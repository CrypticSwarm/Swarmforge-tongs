import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import { updatePr, type Context } from "../src/server.js";
import { ASKPASS, FakeGit, FakeGitHubApi, WORKSPACE, editablePrRoutes } from "./fakes.js";

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

const OPEN_PR = { number: 7, title: "Add a thing", body: "why", base: "main", head: "feature" };

function apiWithPr(overrides: Partial<typeof OPEN_PR> & Record<string, unknown> = {}): FakeGitHubApi {
  return new FakeGitHubApi(editablePrRoutes({ ...OPEN_PR, ...overrides }));
}

describe("update_pr", () => {
  it("replaces the description and says so", async () => {
    const api = apiWithPr();

    const text = await updatePr(contextFor(api), { number: 7, body: "why\n\nand how" });

    assert.deepEqual(api.lastBody, { body: "why\n\nand how" });
    assert.match(text, /Updated pull request #7: description/);
    assert.match(text, /https:\/\/github\.com\/acme\/widgets\/pull\/7/);
  });

  it("sends only the fields it was given", async () => {
    const api = apiWithPr();

    await updatePr(contextFor(api), { number: 7, title: "A better title" });

    // Not `{title, body: undefined, base: undefined, ...}`: a key GitHub sees is a
    // field it may act on, and nothing here asked to touch the description.
    assert.deepEqual(api.lastBody, { title: "A better title" });
  });

  it("moves the base and names where it moved from", async () => {
    const api = apiWithPr();

    const text = await updatePr(contextFor(api), { number: 7, base: "release-2" });

    assert.deepEqual(api.lastBody, { base: "release-2" });
    assert.match(text, /base main -> release-2/);
  });

  it("closes and reopens", async () => {
    const api = apiWithPr();
    const context = contextFor(api);

    assert.match(await updatePr(context, { number: 7, state: "closed" }), /closed it/);
    assert.match(await updatePr(context, { number: 7, state: "open" }), /reopened it/);
  });

  it("reports several changes in one edit", async () => {
    const api = apiWithPr();

    const text = await updatePr(contextFor(api), { number: 7, title: "New", body: "New body", state: "closed" });

    assert.match(text, /Updated pull request #7: title, description, closed it/);
  });

  it("reports what changed, not what was asked", async () => {
    // GitHub takes an edit that sets a field to the value it already had. Calling
    // that an update would tell a caller its text landed when nothing moved.
    const api = apiWithPr();

    const text = await updatePr(contextFor(api), { number: 7, title: "Add a thing", body: "why" });

    assert.match(text, /already matched what you asked for; nothing changed/);
  });

  it("refuses an edit that changes nothing, before calling GitHub", async () => {
    const api = apiWithPr();

    await assert.rejects(() => updatePr(contextFor(api), { number: 7 }), /nothing to change/);
    assert.equal(api.calls.length, 0);
  });

  it("refuses to point a pull request at its own head branch", async () => {
    const api = apiWithPr();

    await assert.rejects(
      () => updatePr(contextFor(api), { number: 7, base: "feature" }),
      /base and head would both be 'feature'/,
    );
    assert.ok(!api.calls.some((call) => call.method === "PATCH"));
  });

  it("addresses only the pinned repository", async () => {
    const api = apiWithPr();

    await updatePr(contextFor(api), { number: 7, body: "b" });

    assert.deepEqual(
      api.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET https://api.github.com/repos/acme/widgets/pulls/7",
        "PATCH https://api.github.com/repos/acme/widgets/pulls/7",
      ],
    );
  });

  it("sends the token as a bearer header and nowhere else", async () => {
    const api = apiWithPr();

    await updatePr(contextFor(api), { number: 7, body: "b" });

    for (const call of api.calls) {
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(!call.url.includes(TOKEN));
      assert.ok(!JSON.stringify(call.body ?? {}).includes(TOKEN));
    }
  });

  it("blames the number, not the repository, for a 404 on a pull request", async () => {
    // Startup already proved the token can see the repository, so the generic
    // "maybe the repo does not exist" would send a caller after the wrong thing.
    const api = new FakeGitHubApi({
      "GET /repos/acme/widgets/pulls/999": { status: 404, json: { message: "Not Found" } },
    });

    await assert.rejects(
      () => updatePr(contextFor(api), { number: 999, body: "b" }),
      /cannot see that pull request in acme\/widgets/,
    );
  });
});
