// Process entrypoint.
//
// Startup is fail-closed: a missing token, an origin that is not a GitHub
// repository, or a token that cannot see that repository all stop the process here
// rather than leaving a tong that accepts calls and fails every one of them.
// No origin, or no repository, serves no verbs instead.

import { booleanFromEnv } from "./config.js";
import { realRun } from "./exec.js";
import { GitHub, pushBlocker } from "./github.js";
import { type Origin, parseOrigin, remoteUrl } from "./origin.js";
import { Repo } from "./repo.js";
import { createApp } from "./app.js";
import type { Context, Idle } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const workspace = process.env.GITHUB_TONG_WORKSPACE ?? "/workspace";
const askpass = process.env.GITHUB_TONG_ASKPASS ?? "/app/askpass.sh";

const token = process.env.GITHUB_TOKEN;

// Child processes inherit this process's environment, so drop the token from it as
// soon as it is read. Only the push gets it back, through repo.ts.
delete process.env.GITHUB_TOKEN;

function die(message: string): never {
  console.error(`github: ${message}`);
  process.exit(1);
}

if (!token) {
  die(
    "GITHUB_TOKEN is unset. It must be a GitHub token delivered as a ${secret:...} reference in the tong " +
      "definition.",
  );
}

// Parsed before anything else happens, so a misspelled value is a startup failure
// rather than a gate that turns out to have been off after a push has gone out.
const requireSignedCommits = (() => {
  try {
    return booleanFromEnv(
      "GITHUB_TONG_REQUIRE_SIGNED_COMMITS",
      process.env.GITHUB_TONG_REQUIRE_SIGNED_COMMITS,
    );
  } catch (err) {
    die((err as Error).message);
  }
})();

const repo = new Repo(realRun, workspace, askpass, requireSignedCommits);

/** The verified repository, or why there is none. */
async function serving(token: string): Promise<Context | Idle> {
  let url: string | null;
  try {
    if (!(await repo.isRepo())) return { idle: `${workspace} was not a git work tree` };
    url = await repo.originUrl();
  } catch (err) {
    die((err as Error).message);
  }
  if (!url) return { idle: `${workspace} had no 'origin' remote` };

  let origin: Origin;
  try {
    origin = parseOrigin(url);
  } catch (err) {
    die((err as Error).message);
  }

  const github = new GitHub(fetch, origin, token);

  // Catches the configuration mistakes that are otherwise invisible until the first
  // verb call. Reachability is not enough on its own: a public repository answers
  // this for any valid token, including one with no write access to it, so the
  // reported permissions are what actually gets checked.
  try {
    const { defaultBranch, permissions } = await github.repository();
    const blocker = pushBlocker(origin, permissions);
    if (blocker) die(blocker);
    console.log(`github: ${origin.owner}/${origin.repo} writable, default branch ${defaultBranch}`);
  } catch (err) {
    // Including the network case. Warning and starting anyway produces a tong that
    // looks healthy and fails every verb with an error from deep inside git, which
    // is a worse outcome than not starting.
    die((err as Error).message);
  }

  if (requireSignedCommits) {
    console.log("github: every commit a push would add to the repository must carry a signature");
  }

  return { repo, github, origin, remoteUrl: remoteUrl(origin), token };
}

const context = await serving(token);
const serves = "idle" in context ? `no verbs: ${context.idle}` : `${context.origin.owner}/${context.origin.repo}`;

const httpServer = createApp(context).listen(port, () => {
  console.log(`github listening on :${port} (${serves}, workspace ${workspace})`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
