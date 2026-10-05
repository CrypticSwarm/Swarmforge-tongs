import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, MAX_FIND_RESULTS } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import { findPr, type Context } from "../src/server.js";
import { ASKPASS, FakeGit, FakeGitHubApi, WORKSPACE, listPrsRoute, type PrState } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const TOKEN = "ghp_thisIsTheSecretTokenValue";

function contextFor(api: FakeGitHubApi): Context {
  return {
    repo: new Repo(new FakeGit().run, WORKSPACE, ASKPASS, false),
    github: new GitHub(api.fetch, ORIGIN, TOKEN),
    origin: ORIGIN,
    pushUrl: pushUrl(ORIGIN),
    token: TOKEN,
  };
}

const pr = (number: number, extra: Partial<PrState> = {}): PrState => ({
  number,
  title: `PR ${number}`,
  body: "b",
  base: "main",
  head: "feature",
  ...extra,
});

describe("find_pr", () => {
  it("reports number, branches, state, and URL for each match, newest first", async () => {
    const api = new FakeGitHubApi(listPrsRoute([pr(9, { draft: true }), pr(4, { state: "closed" })]));

    const text = await findPr(contextFor(api), { head: "feature" });

    assert.match(text, /^2 pull requests with head branch 'feature', newest first:/);
    assert.match(text, /#9 feature -> main \(draft\)\nhttps:\/\/github\.com\/acme\/widgets\/pull\/9/);
    assert.match(text, /#4 feature -> main \(closed\)/);
    assert.ok(text.indexOf("#9") < text.indexOf("#4"), "keeps GitHub's newest-first order");
  });

  it("calls a merged pull request merged, though the list endpoint only sends merged_at", async () => {
    // The case that motivated the verb: stacking on a base that has already merged.
    const api = new FakeGitHubApi(listPrsRoute([pr(14, { state: "closed", merged: true })]));

    const text = await findPr(contextFor(api), { head: "feature" });

    assert.match(text, /#14 feature -> main \(merged\)/);
    assert.doesNotMatch(text, /\(closed\)/);
  });

  it("says so when no pull request has that head branch", async () => {
    const api = new FakeGitHubApi(listPrsRoute([]));

    const text = await findPr(contextFor(api), { head: "nothing-here" });

    assert.equal(text, "No pull request in acme/widgets has 'nothing-here' as its head branch.");
  });

  it("does not return titles or descriptions", async () => {
    const api = new FakeGitHubApi(listPrsRoute([pr(9, { title: "SECRET TITLE", body: "SECRET BODY" })]));

    const text = await findPr(contextFor(api), { head: "feature" });

    assert.doesNotMatch(text, /SECRET/);
  });

  it("says when the list was cut short, and shows only the most recent", async () => {
    const many = Array.from({ length: MAX_FIND_RESULTS + 1 }, (_, i) => pr(100 - i));
    const api = new FakeGitHubApi(listPrsRoute(many));

    const text = await findPr(contextFor(api), { head: "feature" });

    assert.match(text, new RegExp(`^${MAX_FIND_RESULTS} pull requests .*showing the ${MAX_FIND_RESULTS} most recent`));
    assert.match(text, new RegExp(`#${100 - MAX_FIND_RESULTS + 1} `));
    assert.doesNotMatch(text, new RegExp(`#${100 - MAX_FIND_RESULTS} `), "the oldest is left out");
  });

  it("does not claim a cut when exactly the cap exists", async () => {
    const exactly = Array.from({ length: MAX_FIND_RESULTS }, (_, i) => pr(100 - i));
    const api = new FakeGitHubApi(listPrsRoute(exactly));

    const text = await findPr(contextFor(api), { head: "feature" });

    assert.match(text, new RegExp(`^${MAX_FIND_RESULTS} pull requests `));
    assert.doesNotMatch(text, /most recent/);
  });

  it("asks GitHub only for this repository's pull requests from the pinned owner's branch", async () => {
    const api = new FakeGitHubApi(listPrsRoute([]));

    await findPr(contextFor(api), { head: "feature/x" });

    assert.equal(api.calls.length, 1);
    const url = new URL(api.calls[0].url);
    assert.equal(api.calls[0].method, "GET");
    assert.equal(url.origin + url.pathname, "https://api.github.com/repos/acme/widgets/pulls");
    assert.equal(url.searchParams.get("head"), "acme:feature/x");
    assert.equal(url.searchParams.get("state"), "all");
    assert.equal(url.searchParams.get("per_page"), String(MAX_FIND_RESULTS + 1), "one extra, so `more` is exact");
  });

  it("keeps a hostile branch name one query value", async () => {
    // Legal under the branch-name schema, and the one place a caller value lands in
    // a query string: it must not add a parameter, override one, or end the URL.
    const api = new FakeGitHubApi(listPrsRoute([]));
    const hostile = "x&state=open&head=evil:y#frag=1";

    await findPr(contextFor(api), { head: hostile });

    const url = new URL(api.calls[0].url);
    assert.equal(url.searchParams.get("head"), `acme:${hostile}`);
    assert.equal(url.searchParams.get("state"), "all");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["direction", "head", "per_page", "sort", "state"]);
    assert.equal(url.hash, "");
  });

  it("keeps a value that slipped past the schema out of the request", async () => {
    const api = new FakeGitHubApi();
    const github = new GitHub(api.fetch, ORIGIN, TOKEN);

    for (const value of ["", "x".repeat(256), 7 as unknown as string, null as unknown as string]) {
      await assert.rejects(() => github.findPullRequests(value), /is not a branch name/);
    }
    assert.equal(api.calls.length, 0);
  });

  it("refuses a reply that is not a list", async () => {
    const api = new FakeGitHubApi({ "GET /repos/acme/widgets/pulls": { status: 200, json: { message: "?" } } });

    await assert.rejects(() => findPr(contextFor(api), { head: "feature" }), /something other than a list/);
  });
});
