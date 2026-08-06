import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, pushBlocker } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import { branchName, createPr, type Context } from "../src/server.js";
import { ASKPASS, FakeGit, FakeGitHubApi, REPO_ROUTE, WORKSPACE, prRoute } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const TOKEN = "ghp_thisIsTheSecretTokenValue";

function contextFor(git: FakeGit, api: FakeGitHubApi): Context {
  return {
    repo: new Repo(git.run, WORKSPACE, ASKPASS, false),
    github: new GitHub(api.fetch, ORIGIN, TOKEN),
    origin: ORIGIN,
    pushUrl: pushUrl(ORIGIN),
    token: TOKEN,
  };
}

describe("create_pr", () => {
  it("derives head from the workspace and defaults base to the repository default", async () => {
    const git = new FakeGit({ branch: "feature" });
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(7, "main", "feature") });

    const text = await createPr(contextFor(git, api), { title: "Add a thing" });

    assert.deepEqual(api.lastBody, {
      title: "Add a thing",
      body: "",
      head: "feature",
      base: "main",
      draft: false,
    });
    assert.match(text, /pull request #7: feature -> main/);
    assert.match(text, /https:\/\/github\.com\/acme\/widgets\/pull\/7/);
  });

  it("stacks on an explicit base without consulting the repository default", async () => {
    const git = new FakeGit({ branch: "layer-two" });
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(9, "layer-one", "layer-two") });

    await createPr(contextFor(git, api), { title: "Layer two", base: "layer-one" });

    assert.equal((api.lastBody as { base: string }).base, "layer-one");
    assert.ok(!api.calls.some((call) => call.method === "GET"));
  });

  it("addresses only the pinned repository", async () => {
    const git = new FakeGit();
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(1, "main", "feature") });

    await createPr(contextFor(git, api), { title: "t" });

    for (const call of api.calls) {
      assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/acme\/widgets(\/|$)/);
    }
  });

  it("pushes before opening the pull request", async () => {
    const git = new FakeGit();
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(1, "main", "feature") });

    await createPr(contextFor(git, api), { title: "t" });

    assert.ok(git.pushCall, "no push happened");
    assert.equal(api.calls.filter((c) => c.method === "POST").length, 1);
  });

  it("opens nothing when the push is rejected", async () => {
    const git = new FakeGit({ pushFails: { stderr: "! [rejected] (non-fast-forward)" } });
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(1, "main", "feature") });

    await assert.rejects(() => createPr(contextFor(git, api), { title: "t" }), /non-fast-forward/);
    assert.equal(api.calls.length, 0);
  });

  it("refuses a pull request from a branch onto itself", async () => {
    const git = new FakeGit({ branch: "main" });
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(1, "main", "main") });

    await assert.rejects(() => createPr(contextFor(git, api), { title: "t" }), /base and head are both 'main'/);
    assert.ok(!api.calls.some((call) => call.method === "POST"));
  });

  it("passes body and draft through", async () => {
    const git = new FakeGit();
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(3, "main", "feature", true) });

    const text = await createPr(contextFor(git, api), { title: "t", body: "why\n\nand how", draft: true });

    assert.equal((api.lastBody as { body: string }).body, "why\n\nand how");
    assert.equal((api.lastBody as { draft: boolean }).draft, true);
    assert.match(text, /draft pull request/);
  });

  it("sends the token as a bearer header and nowhere else", async () => {
    const git = new FakeGit();
    const api = new FakeGitHubApi({ ...REPO_ROUTE, ...prRoute(1, "main", "feature") });

    await createPr(contextFor(git, api), { title: "t", body: "b" });

    for (const call of api.calls) {
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(!call.url.includes(TOKEN));
      assert.ok(!JSON.stringify(call.body ?? {}).includes(TOKEN));
    }
  });
});

describe("create_pr failures", () => {
  const cases: Array<[number, RegExp]> = [
    [401, /invalid, revoked, or expired/],
    [403, /lacks the permission/],
    [404, /not scoped to it/],
    [422, /422/],
  ];

  for (const [status, expected] of cases) {
    it(`explains a ${status}`, async () => {
      const git = new FakeGit();
      const api = new FakeGitHubApi({
        ...REPO_ROUTE,
        "POST /repos/acme/widgets/pulls": { status, json: { message: "nope" } },
      });

      await assert.rejects(() => createPr(contextFor(git, api), { title: "t" }), expected);
    });
  }
});

describe("pushBlocker", () => {
  it("passes a token GitHub reports push access for", () => {
    assert.equal(pushBlocker(ORIGIN, { pull: true, push: true }), null);
  });

  it("blocks read-only access, which is all a public repo proves", () => {
    const blocker = pushBlocker(ORIGIN, { pull: true, push: false });
    assert.match(blocker!, /cannot push to acme\/widgets/);
    assert.match(blocker!, /Contents: read and write/);
  });

  it("blocks when GitHub reports no permissions at all", () => {
    assert.match(pushBlocker(ORIGIN, undefined)!, /no permissions for it at all/);
  });
});

describe("base branch validation", () => {
  it("accepts ordinary branch names", () => {
    for (const value of ["main", "feature/x", "release-1.2", "user.name/topic"]) {
      assert.equal(branchName.safeParse(value).success, true, value);
    }
  });

  it("rejects values that are not a branch anybody meant", () => {
    for (const value of ["", "--force", "has space", "line\nbreak", "tab\there", "x".repeat(256)]) {
      assert.equal(branchName.safeParse(value).success, false, JSON.stringify(value));
    }
  });
});
