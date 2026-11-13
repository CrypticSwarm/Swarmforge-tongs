import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { listUsers, type Context } from "../src/server.js";
import { FakeAsana, WORKSPACE, pageReply, typeaheadRoute } from "./fakes.js";

const IN_WORKSPACE = { gid: WORKSPACE.gid, resource_type: "workspace" };
const ELSEWHERE = { gid: "1100000000000999", resource_type: "workspace" };
const TYPEAHEAD_ROUTE = `GET /workspaces/${WORKSPACE.gid}/typeahead`;

function user(gid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name: `User ${gid.slice(-1)}`, workspaces: [ELSEWHERE, IN_WORKSPACE], ...extra };
}

let fake: FakeAsana;
let context: Context;

before(async () => {
  fake = await FakeAsana.start();
  context = { asana: fake.client(), workspace: WORKSPACE };
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.routes = {};
});

after(() => fake.close());

describe("list_users", () => {
  it("lists the workspace's users a page at a time", async () => {
    fake.routes = {
      "GET /users": pageReply([user("1200000000000001", { email: "ada@example.com" }), user("1200000000000002")], "next"),
    };
    assert.equal(
      await listUsers(context, { limit: 2, cursor: "abc" }),
      [
        "users in workspace Acme:",
        "- User 1 (gid 1200000000000001), ada@example.com",
        "- User 2 (gid 1200000000000002)",
        "cursor: next",
      ].join("\n"),
    );
    assert.deepEqual(fake.requestsTo("GET", "/users")[0].query, {
      workspace: WORKSPACE.gid,
      limit: "2",
      offset: "abc",
      opt_fields: "name,email,workspaces",
    });
  });

  it("finds users by typeahead and says when the page is full", async () => {
    fake.routes = { [TYPEAHEAD_ROUTE]: typeaheadRoute("user", [user("1200000000000001")]) };
    assert.equal(
      await listUsers(context, { query: "ada", limit: 1 }),
      "matching users, most worked with first:\n- User 1 (gid 1200000000000001)\nmore may match: narrow the query",
    );
    assert.deepEqual(fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}/typeahead`)[0].query, {
      resource_type: "user",
      query: "ada",
      count: "1",
      opt_fields: "name,email,workspaces",
    });
  });

  it("asks for 50 by default, listed or found", async () => {
    fake.routes = { "GET /users": pageReply([]), [TYPEAHEAD_ROUTE]: typeaheadRoute("user", []) };
    assert.equal(await listUsers(context, {}), "users in workspace Acme: none");
    assert.equal(await listUsers(context, { query: "x" }), "matching users, most worked with first: none");
    assert.equal(fake.requestsTo("GET", "/users")[0].query.limit, "50");
    assert.equal(fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}/typeahead`)[0].query.count, "50");
  });

  it("refuses a query with a cursor before calling Asana", async () => {
    await assert.rejects(listUsers(context, { query: "ada", cursor: "abc" }), /not both/);
    assert.deepEqual(fake.requests, []);
  });

  it("refuses a user outside the workspace, listed or found", async () => {
    const stranger = user("1200000000000009", { workspaces: [ELSEWHERE] });
    fake.routes = { "GET /users": pageReply([user("1200000000000001"), stranger]) };
    await assert.rejects(listUsers(context, {}), { message: /^a returned user is not in workspace Acme/ });
    fake.routes = { [TYPEAHEAD_ROUTE]: typeaheadRoute("user", [{ ...stranger, workspaces: undefined }]) };
    await assert.rejects(listUsers(context, { query: "x" }), { message: /^a returned user is not in workspace Acme/ });
  });
});
