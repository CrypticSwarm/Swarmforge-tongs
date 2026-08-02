import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo, RepoError } from "../src/repo.js";
import { ASKPASS, FakeGit, WORKSPACE } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const URL = pushUrl(ORIGIN);
const TOKEN = "ghp_thisIsTheSecretTokenValue";

function repoFor(git: FakeGit): Repo {
  return new Repo(git.run, WORKSPACE, ASKPASS);
}

function configPairs(args: readonly string[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-c") continue;
    const [key, ...rest] = args[i + 1].split("=");
    pairs.set(key, rest.join("="));
  }
  return pairs;
}

describe("push argv", () => {
  it("never puts the token on a command line", async () => {
    const git = new FakeGit();
    await repoFor(git).push(ORIGIN, URL, TOKEN);

    for (const call of git.calls) {
      assert.ok(
        !call.args.some((arg) => arg.includes(TOKEN)),
        `token leaked into argv: ${call.args.join(" ")}`,
      );
    }
  });

  it("hands the token to git only through the askpass environment, and only for the push", async () => {
    const git = new FakeGit();
    await repoFor(git).push(ORIGIN, URL, TOKEN);

    const push = git.pushCall!;
    assert.equal(push.env.GIT_ASKPASS, ASKPASS);
    assert.equal(push.env.GITHUB_TONG_TOKEN, TOKEN);

    for (const call of git.calls) {
      if (call === push) continue;
      assert.equal(call.env.GITHUB_TONG_TOKEN, undefined, `token reached ${call.verb[0]}`);
    }
  });

  it("never asks git to prompt", async () => {
    const git = new FakeGit();
    await repoFor(git).push(ORIGIN, URL, TOKEN);
    assert.equal(git.pushCall!.env.GIT_TERMINAL_PROMPT, "0");
  });

  it("pushes a fully qualified refspec to the constructed URL", async () => {
    const git = new FakeGit({ branch: "feature" });
    await repoFor(git).push(ORIGIN, URL, TOKEN);

    assert.deepEqual(git.pushCall!.verb, [
      "push",
      "--no-verify",
      "--porcelain",
      URL,
      "refs/heads/feature:refs/heads/feature",
    ]);
  });

  it("never force-pushes", async () => {
    const git = new FakeGit();
    await repoFor(git).push(ORIGIN, URL, TOKEN);

    for (const arg of git.pushCall!.args) {
      assert.ok(!arg.startsWith("--force"), `push carried ${arg}`);
      assert.notEqual(arg, "-f");
    }
  });

  it("neutralizes the config keys a workspace could use to run a command", async () => {
    const git = new FakeGit();
    await repoFor(git).push(ORIGIN, URL, TOKEN);

    const args = git.pushCall!.args;
    const pairs = configPairs(args);

    assert.equal(pairs.get("core.hooksPath"), "/dev/null");
    assert.equal(pairs.get("core.fsmonitor"), "");
    assert.equal(pairs.get("core.gitProxy"), "");
    assert.equal(pairs.get("credential.helper"), "");
    assert.equal(pairs.get("protocol.ext.allow"), "never");
    assert.equal(pairs.get("safe.directory"), WORKSPACE);
    assert.ok(args.includes("--no-verify"));
  });

  // Not command execution like the keys above: these two send the token, or refs
  // the caller never asked for, somewhere the workspace chose.
  it("keeps the push to the one branch, and to the pinned remote only", async () => {
    const git = new FakeGit();
    await repoFor(git).push(ORIGIN, URL, TOKEN);

    const pairs = configPairs(git.pushCall!.args);

    // `on-demand` would push submodules to their own remotes, carrying GIT_ASKPASS.
    assert.equal(pairs.get("push.recurseSubmodules"), "no");
    assert.equal(pairs.get("push.followTags"), "false");
  });
});

describe("push outcome", () => {
  it("moves the remote-tracking ref so git-signing sees the commits as published", async () => {
    const git = new FakeGit({ branch: "feature", head: "abc123abc123abc123abc123abc123abc123abcd" });
    const outcome = await repoFor(git).push(ORIGIN, URL, TOKEN);

    assert.equal(git.refs.get("refs/remotes/origin/feature"), "abc123abc123abc123abc123abc123abc123abcd");
    assert.equal(outcome.sha, "abc123abc123abc123abc123abc123abc123abcd");
    assert.equal(outcome.branch, "feature");
    assert.equal(outcome.alreadyUpToDate, false);
  });

  it("reports an unchanged remote as already up to date", async () => {
    const git = new FakeGit({ pushUpToDate: true });
    const outcome = await repoFor(git).push(ORIGIN, URL, TOKEN);
    assert.equal(outcome.alreadyUpToDate, true);
  });

  it("leaves the remote-tracking ref alone when the push fails", async () => {
    const git = new FakeGit({ pushFails: { stderr: "! [rejected] feature -> feature (non-fast-forward)" } });

    await assert.rejects(() => repoFor(git).push(ORIGIN, URL, TOKEN), (err: Error) => {
      assert.ok(err instanceof RepoError);
      assert.match(err.message, /non-fast-forward/);
      return true;
    });
    assert.equal(git.refs.size, 0);
  });
});

describe("push refusals", () => {
  it("refuses a detached HEAD", async () => {
    const git = new FakeGit({ branch: null });
    await assert.rejects(() => repoFor(git).push(ORIGIN, URL, TOKEN), /detached/);
    assert.equal(git.pushCall, undefined);
  });

  it("refuses a branch name that would not make an unambiguous refspec", async () => {
    for (const branch of ["--force", "feature:evil", "a..b", "with space", "tilde~1"]) {
      const git = new FakeGit({ branch });
      await assert.rejects(() => repoFor(git).push(ORIGIN, URL, TOKEN), RepoError, `accepted ${branch}`);
      assert.equal(git.pushCall, undefined, `pushed ${branch}`);
    }
  });
});
