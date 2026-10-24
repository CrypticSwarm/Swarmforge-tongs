import { ALLOWLIST } from "./allowlist.js";
import { booleanFromEnv } from "./config.js";
import { loadDispatch } from "./dispatch.js";
import { realRun } from "./exec.js";
import { GitHub, pushBlocker } from "./github.js";
import { type Origin, parseOrigin, remoteUrl } from "./origin.js";
import { Repo } from "./repo.js";
import { createApp } from "./app.js";
import { RESERVED_VERBS, type Context, type Idle } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const workspace = process.env.GITHUB_TONG_WORKSPACE ?? "/workspace";
const askpass = process.env.GITHUB_TONG_ASKPASS ?? "/app/askpass.sh";

const token = process.env.GITHUB_TOKEN;

// Children inherit the environment; only push and fetch get the token back.
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

const dispatchOn = (() => {
  try {
    return booleanFromEnv("GITHUB_TONG_DISPATCH", process.env.GITHUB_TONG_DISPATCH);
  } catch (err) {
    die((err as Error).message);
  }
})();

const repo = new Repo(realRun, workspace, askpass, requireSignedCommits);

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

  let defaultBranch: string;
  try {
    let permissions: Record<string, boolean> | undefined;
    ({ defaultBranch, permissions } = await github.repository());
    const blocker = pushBlocker(origin, permissions);
    if (blocker) die(blocker);
    console.log(`github: ${origin.owner}/${origin.repo} writable, default branch ${defaultBranch}`);
  } catch (err) {
    // Network errors too: a tong that looks healthy and fails every verb is worse than none.
    die((err as Error).message);
  }

  if (requireSignedCommits) {
    console.log("github: every commit a push would add to the repository must carry a signature");
  }

  let dispatch: Context["dispatch"];
  if (dispatchOn) {
    const { entries, dropped, unusable } = await loadDispatch(github, defaultBranch, RESERVED_VERBS);
    for (const entry of entries) {
      const on = entry.ref === "default" ? defaultBranch : "the checked-out branch";
      console.log(`github: ${entry.verb} dispatches ${entry.file} on ${on}`);
    }
    for (const { verb, why } of dropped) console.error(`github: dropping verb ${verb}: ${why}`);
    if (unusable) console.error(`github: no dispatch verbs: ${unusable}`);
    else if (!entries.length && !dropped.length) console.log(`github: no dispatch verbs from ${ALLOWLIST} on ${defaultBranch}`);
    dispatch = { defaultBranch, entries, dropped, unusable };
  }

  return { repo, github, origin, remoteUrl: remoteUrl(origin), token, dispatch };
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
