import assert from "node:assert/strict";
import { inspect } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";
import { openWorkspace } from "../src/asana.js";
import {
  FakeAsana,
  TOKEN,
  USER,
  WORKSPACE,
  asanaError,
  dataReply,
  errorReply,
  meRoute,
  unreachableClient,
  workspaceRoute,
} from "./fakes.js";

let fake: FakeAsana;

before(async () => {
  fake = await FakeAsana.start();
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.routes = { ...meRoute(), ...workspaceRoute() };
});

after(() => fake.close());

function holdsToken(err: unknown): boolean {
  return inspect(err, { depth: Infinity, showHidden: true }).includes(TOKEN);
}

describe("requests", () => {
  it("send each client's own token as a bearer token and ask only for the fields used", async () => {
    assert.deepEqual(await fake.client().me(), USER);
    assert.deepEqual(await fake.client("other-token").workspace(WORKSPACE.gid), WORKSPACE);
    const [me] = fake.requestsTo("GET", "/users/me");
    const [workspace] = fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}`);
    assert.equal(me.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(workspace.headers.authorization, "Bearer other-token");
    assert.deepEqual(me.query, { opt_fields: "name,email" });
    assert.deepEqual(workspace.query, { opt_fields: "name" });
  });

  it("do not follow a redirect, so the token stays with Asana", async (t) => {
    const elsewhere = await FakeAsana.start(meRoute());
    t.after(() => elsewhere.close());
    fake.routes = { "GET /users/me": { status: 307, headers: { location: `${elsewhere.basePath}/users/me` } } };
    assert.match((await asanaError(fake.client().me())).message, /Asana answered 307/);
    assert.deepEqual(elsewhere.requests, []);
  });
});

describe("answers", () => {
  it("me() omits email when Asana does", async () => {
    fake.routes = meRoute({ gid: USER.gid, name: USER.name });
    assert.equal((await fake.client().me()).email, undefined);
  });

  it("are flattened to one line", async () => {
    fake.routes = meRoute({ ...USER, name: "Ada\nworkspace: Evil\u2028" });
    assert.equal((await fake.client().me()).name, "Ada workspace: Evil ");
  });
});

describe("errors", () => {
  it("carry Asana's status and message, and never the token", async () => {
    fake.routes = { "GET /users/me": errorReply(401, "Not Authorized") };
    const err = await asanaError(fake.client().me());
    assert.equal(err.status, 401);
    assert.equal(err.message, "reading the token's user: Asana answered 401: Not Authorized");
    assert.equal(holdsToken(err), false);
  });

  it("say when to retry a 429, if Asana says so in whole seconds", async () => {
    const advice = { "30": "Retry after 30 seconds.", "-5": "Retry later.", "1.5": "Retry later.", "": "Retry later." };
    for (const [retryAfter, expected] of Object.entries(advice)) {
      fake.routes = { "GET /users/me": errorReply(429, "Too many requests", { "retry-after": retryAfter }) };
      assert.ok((await asanaError(fake.client().me())).message.endsWith(`429: Too many requests. ${expected}`), retryAfter);
    }
  });

  it("fall back to the status text when Asana sends no errors", async () => {
    fake.routes = { "GET /users/me": { status: 502 } };
    assert.match((await asanaError(fake.client().me())).message, /Asana answered 502: Bad Gateway$/);
  });

  it("strip control characters from Asana's message and cap it", async () => {
    fake.routes = { "GET /users/me": errorReply(400, `bad\n\x1b[31m${"x".repeat(1000)}`) };
    const { message } = await asanaError(fake.client().me());
    assert.doesNotMatch(message, /[\x00-\x1f]/);
    assert.ok(message.length < 600, String(message.length));
  });

  it("report an answer without data or a gid", async () => {
    for (const [json, missing] of [
      [{ nope: true }, "data"],
      [{ data: [USER] }, "data"],
      [{ data: { name: "x" } }, "gid"],
      [{ data: { gid: "../x" } }, "gid"],
    ] as const) {
      fake.routes = { "GET /users/me": { json } };
      assert.match((await asanaError(fake.client().me())).message, new RegExp(`Asana's answer had no ${missing}$`));
    }
  });

  it("keep the status of a body that is not JSON, or has malformed errors", async () => {
    fake.routes = { "GET /users/me": { status: 200, text: "<html>" } };
    assert.match((await asanaError(fake.client().me())).message, /: Asana answered 200: /);
    fake.routes = { "GET /users/me": { status: 403, json: { errors: "boom" } } };
    assert.match((await asanaError(fake.client().me())).message, /: Asana answered 403: Forbidden$/);
  });

  it("report an unreachable Asana without a status", async () => {
    const err = await asanaError((await unreachableClient()).me());
    assert.equal(err.status, undefined);
    assert.match(err.message, /^reading the token's user: cannot reach Asana: .*ECONNREFUSED/);
  });
});

describe("openWorkspace", () => {
  it("names the token's user and the pinned workspace", async () => {
    assert.deepEqual(await openWorkspace(fake.client(), WORKSPACE.gid), { user: USER, workspace: WORKSPACE });
  });

  it("refuses a workspace the token cannot read", async () => {
    fake.routes = { ...meRoute(), [`GET /workspaces/${WORKSPACE.gid}`]: errorReply(403, "Forbidden") };
    assert.equal(
      (await asanaError(openWorkspace(fake.client(), WORKSPACE.gid))).message,
      `reading workspace ${WORKSPACE.gid}: Asana answered 403: Forbidden`,
    );
  });

  it("refuses a bad token before reading the workspace", async () => {
    fake.routes = { "GET /users/me": errorReply(401, "Not Authorized") };
    await asanaError(openWorkspace(fake.client(), WORKSPACE.gid));
    assert.deepEqual(fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}`), []);
  });

  it("refuses an answer for another workspace", async () => {
    fake.routes = { ...meRoute(), [`GET /workspaces/${WORKSPACE.gid}`]: dataReply({ gid: "999", name: "Other" }) };
    assert.match((await asanaError(openWorkspace(fake.client(), WORKSPACE.gid))).message, /answered with workspace 999$/);
  });
});
