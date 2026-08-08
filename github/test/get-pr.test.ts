import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import { getPr, prNumber, type Context } from "../src/server.js";
import { ASKPASS, FakeGit, FakeGitHubApi, WORKSPACE, getPrRoute } from "./fakes.js";

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

describe("get_pr", () => {
  it("reports the text, the branches, and the state", async () => {
    const api = new FakeGitHubApi(
      getPrRoute({ number: 7, title: "Add a thing", body: "why\n\nand how", base: "main", head: "feature" }),
    );

    const text = await getPr(contextFor(api), { number: 7 });

    assert.match(text, /#7 feature -> main \(open\)/);
    assert.match(text, /title: Add a thing/);
    assert.match(text, /why\n\nand how/);
    assert.match(text, /https:\/\/github\.com\/acme\/widgets\/pull\/7/);
  });

  it("says which of draft, closed, and merged a pull request is", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ draft: true }, /\(draft\)/],
      [{ state: "closed" }, /\(closed\)/],
      [{ state: "closed", merged: true }, /\(merged\)/],
    ];

    for (const [extra, expected] of cases) {
      const api = new FakeGitHubApi(
        getPrRoute({ number: 3, title: "t", body: "b", base: "main", head: "feature", ...extra }),
      );
      assert.match(await getPr(contextFor(api), { number: 3 }), expected);
    }
  });

  it("renders an empty description as such rather than as nothing", async () => {
    // GitHub answers with null, not "", for a pull request opened with no body.
    const api = new FakeGitHubApi(getPrRoute({ number: 4, title: "t", body: null, base: "main", head: "feature" }));

    assert.match(await getPr(contextFor(api), { number: 4 }), /description:\n\(empty\)/);
  });

  it("addresses only the pinned repository", async () => {
    const api = new FakeGitHubApi(getPrRoute({ number: 7, title: "t", body: "b", base: "main", head: "feature" }));

    await getPr(contextFor(api), { number: 7 });

    assert.deepEqual(
      api.calls.map((call) => call.url),
      ["https://api.github.com/repos/acme/widgets/pulls/7"],
    );
  });
});

describe("pull request number validation", () => {
  it("accepts a number GitHub could have issued", () => {
    for (const value of [1, 7, 123456]) {
      assert.equal(prNumber.safeParse(value).success, true, String(value));
    }
  });

  it("rejects anything that is not one", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, "7", null]) {
      assert.equal(prNumber.safeParse(value).success, false, JSON.stringify(value));
    }
  });

  it("keeps a number that slipped past the schema out of the URL", async () => {
    // The client re-checks rather than trusting its caller: this is the only
    // parameter in the tong that becomes a path segment.
    const api = new FakeGitHubApi();
    const github = new GitHub(api.fetch, ORIGIN, TOKEN);

    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await assert.rejects(() => github.pullRequest(value), /is not a pull request number/);
    }
    assert.equal(api.calls.length, 0);
  });
});
