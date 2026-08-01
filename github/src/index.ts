// Process entrypoint.
//
// Startup is fail-closed: a missing token, a workspace that is not a git work
// tree, an origin that is not a GitHub repository, or a token that cannot see that
// repository all stop the process here rather than leaving a tong that accepts
// calls and fails every one of them.

import { realRun } from "./exec.js";
import { GitHub, GitHubError } from "./github.js";
import { parseOrigin, pushUrl } from "./origin.js";
import { Repo } from "./repo.js";
import { createApp } from "./app.js";

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

const repo = new Repo(realRun, workspace, askpass);

const origin = await (async () => {
  try {
    await repo.assertIsRepo();
    const url = await repo.originUrl();
    if (!url) die(`${workspace} has no 'origin' remote; this tong has no way to know which repository it serves.`);
    return parseOrigin(url);
  } catch (err) {
    die((err as Error).message);
  }
})();

const github = new GitHub(fetch, origin, token);

// Catches the two configuration mistakes that are otherwise invisible until the
// first verb call: a bad token, and a fine-grained token not scoped to this
// repository. A network failure is not a configuration mistake, so it only warns.
try {
  const { defaultBranch } = await github.repository();
  console.log(`github: ${origin.owner}/${origin.repo} reachable, default branch ${defaultBranch}`);
} catch (err) {
  if (err instanceof GitHubError && [401, 403, 404].includes(err.status)) die(err.message);
  console.error(`github: warning: could not reach GitHub at startup: ${(err as Error).message}`);
}

const httpServer = createApp({ repo, github, origin, pushUrl: pushUrl(origin), token }).listen(port, () => {
  console.log(`github listening on :${port} (${origin.owner}/${origin.repo}, workspace ${workspace})`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
