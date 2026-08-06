// The signed-commit gate: what it inspects, what it refuses, and that a refusal
// leaves the server untouched.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo, RepoError } from "../src/repo.js";
import { createPr, type Context } from "../src/server.js";
import { ASKPASS, FakeGit, FakeGitHubApi, REPO_ROUTE, WORKSPACE, prRoute } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const URL = pushUrl(ORIGIN);
const TOKEN = "ghp_thisIsTheSecretTokenValue";

const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const OLDER = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

function strictRepo(git: FakeGit): Repo {
  return new Repo(git.run, WORKSPACE, ASKPASS, true);
}

describe("requiring signed commits", () => {
  it("refuses the push when a commit it would add carries no signature", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [OLDER, HEAD], signed: [OLDER] });

    await assert.rejects(() => strictRepo(git).push(ORIGIN, URL, TOKEN), (err: Error) => {
      assert.ok(err instanceof RepoError);
      assert.match(err.message, /1 of the 2 commits/);
      assert.match(err.message, /aaaa1111aaaa/);
      assert.match(err.message, /sign_commits/);
      assert.match(err.message, /Nothing has been pushed/);
      return true;
    });

    assert.equal(git.pushCall, undefined);
    assert.equal(git.refs.size, 0);
  });

  it("pushes when every commit it would add is signed", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [OLDER, HEAD], signed: [OLDER, HEAD] });

    const outcome = await strictRepo(git).push(ORIGIN, URL, TOKEN);

    assert.equal(outcome.sha, HEAD);
    assert.ok(git.pushCall);
  });

  it("pushes when there is nothing to add, without asking about any object", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [] });

    await strictRepo(git).push(ORIGIN, URL, TOKEN);

    assert.ok(git.pushCall);
    assert.equal(git.callsTo("cat-file").length, 0);
  });

  // The gate has to name the same commits the refspec does. HEAD is not that: the
  // agent owns the workspace and can move the branch after the sha is read.
  it("asks about the commits the pushed sha would add, not the ones HEAD would", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [HEAD], signed: [HEAD] });

    await strictRepo(git).push(ORIGIN, URL, TOKEN);

    const revList = git.callsTo("rev-list")[0];
    assert.deepEqual(revList.verb, ["rev-list", "--topo-order", "--reverse", HEAD, "--not", "--remotes=origin"]);
    assert.equal(git.callsTo("cat-file")[0].stdin?.toString("utf8"), `${HEAD}\n`);
  });

  // Commit messages are the agent's to write. A check that scanned the whole object
  // would take one that opens with a signature header for a signed commit.
  it("does not accept a signature that is only in the commit message", async () => {
    const git = new FakeGit({
      head: HEAD,
      unpushed: [HEAD],
      messages: {
        [HEAD]: "gpgsig -----BEGIN PGP SIGNATURE-----\n iQIzBAABCgAdFiEE\n -----END PGP SIGNATURE-----\n",
      },
    });

    await assert.rejects(() => strictRepo(git).push(ORIGIN, URL, TOKEN), /carries no signature/);
    assert.equal(git.pushCall, undefined);
  });

  // Which is also how a batch truncated at MAX_OUTPUT_BYTES arrives.
  it("refuses when git returns no object for a commit it must judge", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [OLDER, HEAD], signed: [OLDER, HEAD], missingObjects: [HEAD] });

    await assert.rejects(() => strictRepo(git).push(ORIGIN, URL, TOKEN), (err: Error) => {
      assert.ok(err instanceof RepoError);
      assert.match(err.message, /cannot tell whether it is signed/);
      return true;
    });
    assert.equal(git.pushCall, undefined);
  });

  it("opens no pull request when the gate refuses the push", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [HEAD] });
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(1, "main", "feature") });
    const context: Context = {
      repo: strictRepo(git),
      github: new GitHub(api.fetch, ORIGIN, TOKEN),
      origin: ORIGIN,
      pushUrl: URL,
      token: TOKEN,
    };

    await assert.rejects(() => createPr(context, { title: "t" }), /carries no signature/);
    assert.equal(api.calls.length, 0);
  });
});

describe("not requiring signed commits", () => {
  it("pushes unsigned commits and inspects nothing", async () => {
    const git = new FakeGit({ head: HEAD, unpushed: [OLDER, HEAD] });

    await new Repo(git.run, WORKSPACE, ASKPASS, false).push(ORIGIN, URL, TOKEN);

    assert.ok(git.pushCall);
    assert.equal(git.callsTo("rev-list").length, 0);
    assert.equal(git.callsTo("cat-file").length, 0);
  });
});
