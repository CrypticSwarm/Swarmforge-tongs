import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo, RepoError } from "../src/repo.js";
import { fetchOrigin, type Context } from "../src/server.js";
import { ASKPASS, FakeGit, FakeGitHubApi, WORKSPACE, configPairs, type GitFailure } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const URL = pushUrl(ORIGIN);
const TOKEN = "ghp_thisIsTheSecretTokenValue";

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

/** A stale origin/foo, never pruned, blocks a new origin/foo/bar; git still moves the rest. */
const PARTIAL: GitFailure = {
  stdout: `  ${A} ${B} refs/remotes/origin/main\n! ${Z} ${A} refs/remotes/origin/foo/bar\n`,
  stderr: "error: cannot lock ref 'refs/remotes/origin/foo/bar': 'refs/remotes/origin/foo' exists",
};

function repoFor(git: FakeGit): Repo {
  return new Repo(git.run, WORKSPACE, ASKPASS, false);
}

function contextFor(git: FakeGit): Context {
  return {
    repo: repoFor(git),
    github: new GitHub(new FakeGitHubApi().fetch, ORIGIN, TOKEN),
    origin: ORIGIN,
    pushUrl: URL,
    token: TOKEN,
  };
}

describe("fetch argv", () => {
  it("fetches every branch of the pinned URL into refs/remotes/origin, and nothing else", async () => {
    const git = new FakeGit({ originUrl: "git@evil.example:acme/widgets.git" });
    await repoFor(git).fetch(ORIGIN, URL, TOKEN);

    assert.deepEqual(git.fetchCall!.verb, [
      "fetch",
      "--porcelain",
      "--no-recurse-submodules",
      "--no-prune",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      URL,
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    assert.deepEqual(
      git.calls.map((call) => call.verb[0]),
      ["fetch"],
      "the workspace's own remote must not be consulted",
    );
  });

  it("hands the token to git only through the askpass environment", async () => {
    const git = new FakeGit();
    await repoFor(git).fetch(ORIGIN, URL, TOKEN);

    const fetch = git.fetchCall!;
    assert.ok(!fetch.args.some((arg) => arg.includes(TOKEN)), `token leaked into argv: ${fetch.args.join(" ")}`);
    assert.equal(fetch.env.GIT_ASKPASS, ASKPASS);
    assert.equal(fetch.env.GITHUB_TONG_TOKEN, TOKEN);
    assert.equal(fetch.env.GIT_TERMINAL_PROMPT, "0");
  });

  it("carries the shared hardening, plus the keys fetch needs", async () => {
    const git = new FakeGit();
    await repoFor(git).fetch(ORIGIN, URL, TOKEN);

    const pairs = configPairs(git.fetchCall!.args);
    assert.equal(pairs.get("core.hooksPath"), "/dev/null");
    assert.equal(pairs.get("fetch.bundleURI"), "");
  });
});

describe("fetch outcome", () => {
  it("reports each updated ref from the porcelain output", async () => {
    const git = new FakeGit({
      fetchOutput: [
        `  ${A} ${B} refs/remotes/origin/main`,
        `+ ${B} ${A} refs/remotes/origin/rewritten`,
        `* ${Z} ${A} refs/remotes/origin/feature`,
        `* ${Z} ${B} refs/tags/v1`,
        "",
      ].join("\n"),
    });

    assert.deepEqual(await repoFor(git).fetch(ORIGIN, URL, TOKEN), {
      refs: [
        { ref: "refs/remotes/origin/main", change: "fast-forward", from: A, to: B },
        { ref: "refs/remotes/origin/rewritten", change: "forced update", from: B, to: A },
        { ref: "refs/remotes/origin/feature", change: "new", from: Z, to: A },
        { ref: "refs/tags/v1", change: "new", from: Z, to: B },
      ],
      failure: null,
    });
  });

  it("reports nothing when nothing changed", async () => {
    const git = new FakeGit({ fetchOutput: "" });
    assert.deepEqual(await repoFor(git).fetch(ORIGIN, URL, TOKEN), { refs: [], failure: null });
  });

  it("throws when git fails before moving anything", async () => {
    const git = new FakeGit({
      fetchFails: { stderr: "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'" },
    });

    await assert.rejects(() => repoFor(git).fetch(ORIGIN, URL, TOKEN), (err: Error) => {
      assert.ok(err instanceof RepoError);
      assert.match(err.message, /fetching from acme\/widgets failed/);
      assert.match(err.message, /Authentication failed/);
      return true;
    });
  });

  it("reports what moved when git fails partway", async () => {
    const git = new FakeGit({ fetchFails: PARTIAL });

    assert.deepEqual(await repoFor(git).fetch(ORIGIN, URL, TOKEN), {
      refs: [
        { ref: "refs/remotes/origin/main", change: "fast-forward", from: A, to: B },
        { ref: "refs/remotes/origin/foo/bar", change: "rejected", from: Z, to: A },
      ],
      failure: PARTIAL.stderr,
    });
  });
});

describe("fetch_origin", () => {
  it("names each ref the way git branch -r and git tag do", async () => {
    const git = new FakeGit({
      fetchOutput: `+ ${B} ${A} refs/remotes/origin/rewritten\n* ${Z} ${B} refs/tags/v1\n`,
    });

    assert.equal(
      await fetchOrigin(contextFor(git)),
      [
        "Fetched acme/widgets; 2 refs updated:",
        "",
        `origin/rewritten ${B.slice(0, 12)}..${A.slice(0, 12)} (forced update)`,
        `tag v1 ${B.slice(0, 12)} (new)`,
      ].join("\n"),
    );
  });

  it("says so when nothing changed", async () => {
    assert.equal(await fetchOrigin(contextFor(new FakeGit())), "Fetched acme/widgets; nothing changed.");
  });

  it("fails a partial fetch, naming both the rejected refs and the ones that moved", async () => {
    const git = new FakeGit({ fetchFails: PARTIAL });

    await assert.rejects(() => fetchOrigin(contextFor(git)), (err: Error) => {
      assert.match(err.message, /^fetching acme\/widgets failed partway: error: cannot lock ref/);
      assert.match(err.message, new RegExp(`origin/foo/bar ${A.slice(0, 12)} \\(rejected\\)`));
      assert.match(err.message, /git update-ref -d/);
      assert.match(err.message, /went through; 1 ref updated:\n\norigin\/main a{12}\.\.b{12} \(fast-forward\)$/);
      return true;
    });
  });

  it("caps the list, and says by how much", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `* ${Z} ${A} refs/remotes/origin/b${i}`);
    const text = await fetchOrigin(contextFor(new FakeGit({ fetchOutput: lines.join("\n") })));

    assert.match(text, /^Fetched acme\/widgets; 60 refs updated:/);
    assert.match(text, /origin\/b49 /);
    assert.doesNotMatch(text, /origin\/b50 /);
    assert.match(text, /\.\.\.and 10 more$/);
  });
});
