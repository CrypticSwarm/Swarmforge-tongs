import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { FakeAsana, TOKEN, WORKSPACE, dataReply, errorReply, meRoute, workspaceRoute } from "./fakes.js";

const VERBS = [
  "create_task",
  "current_user",
  "delete_task",
  "find_projects",
  "get_project",
  "get_task",
  "list_tasks",
  "list_users",
  "search_tasks",
  "update_task",
];

let fake: FakeAsana;
let httpServer: Server;
let endpoint: URL;
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const client = new Client({ name: "asana-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  clients.push(client);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

before(async () => {
  fake = await FakeAsana.start();
  httpServer = createApp({ asana: fake.client(), workspace: WORKSPACE }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  endpoint = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.routes = { ...meRoute(), ...workspaceRoute() };
});

after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
  await fake.close();
});

describe("plain HTTP", () => {
  it("healthz answers 200 {ok:true}", async () => {
    const res = await fetch(new URL("/healthz", endpoint));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("refuses a body over 1 MiB before Asana is called", async (t) => {
    t.mock.method(console, "error", () => {});
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const res = await fetch(endpoint, { method: "POST", headers, body: " ".repeat(1024 * 1024 + 1) });
    assert.equal(res.status, 413);
    assert.deepEqual(fake.requests, []);
  });
});

describe("tools/list", () => {
  it("lists every verb with a strict, described schema", async () => {
    const client = await connect();
    assert.equal(client.getServerVersion()?.name, "asana");
    assert.match(client.getInstructions() ?? "", /no verb accepts a workspace/);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), VERBS);
    for (const tool of tools) {
      assert.ok(tool.description, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} refuses invented parameters`);
      for (const [key, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.ok((property as { description?: string }).description, `${tool.name}.${key} is described`);
      }
    }
  });
});

describe("current_user", () => {
  it("names the token's user and the pinned workspace", async () => {
    const result = await (await connect()).callTool({ name: "current_user", arguments: {} });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(
      text(result),
      "user: Ada Lovelace (gid 1200000000000001)\nemail: ada@example.com\nworkspace: Acme (gid 1100000000000001)",
    );
    assert.equal(fake.requestsTo("GET", "/users/me").length, 1);
  });

  it("turns an Asana failure into an error result and logs no token", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    fake.routes = { "GET /users/me": errorReply(429, "Too many requests", { "retry-after": "12" }) };
    const result = await (await connect()).callTool({ name: "current_user", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(
      text(result),
      "current_user: error: reading the token's user: Asana answered 429: Too many requests. Retry after 12 seconds.",
    );
    assert.equal(logged.mock.calls[0]?.arguments[0], "current_user failed:");
    assert.ok(!inspect(logged.mock.calls, { depth: Infinity, showHidden: true }).includes(TOKEN));
  });

  it("refuses an invented argument before calling Asana", async () => {
    const result = await (await connect()).callTool({ name: "current_user", arguments: { workspace: "1" } });
    assert.equal(result.isError, true);
    assert.deepEqual(fake.requests, []);
  });
});

describe("verbs", () => {
  it("serve get_task and list_users over MCP", async () => {
    const task = { gid: "1300000000000001", name: "Ship it", workspace: { gid: WORKSPACE.gid } };
    fake.routes = { "GET /tasks/1300000000000001": dataReply(task) };
    const result = await (await connect()).callTool({ name: "get_task", arguments: { task_gid: task.gid } });
    assert.match(text(result), /^task: Ship it \(gid 1300000000000001\)\n/);
    fake.routes = { "GET /users": { json: { data: [], next_page: null } } };
    const users = await (await connect()).callTool({ name: "list_users", arguments: {} });
    assert.equal(text(users), "users in workspace Acme: none");
  });

  it("refuse a malformed argument by name before calling Asana", async () => {
    const client = await connect();
    for (const [name, args, field] of [
      ["get_task", { task_gid: "../users/me" }, "task_gid"],
      ["get_task", { task_gid: "1".repeat(21) }, "task_gid"],
      ["list_tasks", { section_gid: "1/2" }, "section_gid"],
      ["list_tasks", { parent_gid: "" }, "parent_gid"],
      ["list_tasks", { cursor: "a&b" }, "cursor"],
      ["list_tasks", { limit: 101 }, "limit"],
      ["list_tasks", { limit: 1.5 }, "limit"],
      ["search_tasks", { assignee: "ada@example.com" }, "assignee"],
      ["search_tasks", { tag_gid: "x" }, "tag_gid"],
      ["search_tasks", { due_on_after: "next week" }, "due_on_after"],
      ["search_tasks", { text: "x".repeat(201) }, "text"],
      ["search_tasks", { limit: 0 }, "limit"],
      ["get_project", { project_gid: "1?opt_fields=notes" }, "project_gid"],
      ["find_projects", {}, "query"],
      ["find_projects", { query: " " }, "query"],
      ["find_projects", { query: "x".repeat(201) }, "query"],
      ["list_users", { query: " " }, "query"],
      ["list_users", { query: "x".repeat(201) }, "query"],
      ["list_users", { cursor: "a b" }, "cursor"],
      ["list_users", { limit: 101 }, "limit"],
      ["create_task", { project_gid: "1" }, "name"],
      ["create_task", { name: " ", project_gid: "1" }, "name"],
      ["create_task", { name: "x".repeat(1025), project_gid: "1" }, "name"],
      ["create_task", { name: "x", notes: "x".repeat(20_001), project_gid: "1" }, "notes"],
      ["create_task", { name: "x", html_notes: "plain", project_gid: "1" }, "html_notes"],
      ["create_task", { name: "x", html_notes: "<body>a</body><body>b</body>", project_gid: "1" }, "html_notes"],
      ["create_task", { name: "x", html_notes: "<body>a</BODY><BODY>b</body>", project_gid: "1" }, "html_notes"],
      ["create_task", { name: "x", html_notes: `<body>${"x".repeat(19_988)}</body>`, project_gid: "1" }, "html_notes"],
      ["create_task", { name: "x", project_gid: "1/../2" }, "project_gid"],
      ["create_task", { name: "x", parent_gid: "me" }, "parent_gid"],
      ["create_task", { name: "x", due_at: "tomorrow", project_gid: "1" }, "due_at"],
      ["create_task", { name: "x", resource_subtype: "section", project_gid: "1" }, "resource_subtype"],
      ["create_task", { name: "x", section_gid: "1;2", project_gid: "1" }, "section_gid"],
      ["update_task", { task_gid: "1/stories", completed: true }, "task_gid"],
      ["update_task", { task_gid: "1", name: null }, "name"],
      ["update_task", { task_gid: "1", resource_subtype: null }, "resource_subtype"],
      ["update_task", { task_gid: "1", completed: null }, "completed"],
      ["update_task", { task_gid: "1", approval_status: null }, "approval_status"],
      ["update_task", { task_gid: "1", html_notes: null }, "html_notes"],
      ["update_task", { task_gid: "1", assignee: "ada@example.com" }, "assignee"],
      ["update_task", { task_gid: "1", approval_status: "done" }, "approval_status"],
      ["delete_task", { task_gid: "1/subtasks" }, "task_gid"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(text(result), new RegExp(`tool ${name}: ${field}: `), `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(fake.requests, []);
  });

  it("refuse an invented argument before calling Asana", async () => {
    const client = await connect();
    for (const [name, args] of [
      ["get_project", { project_gid: "1", workspace: "1" }],
      ["find_projects", { query: "x", workspace: "1" }],
      ["list_users", { workspace: "1" }],
      ["create_task", { name: "x", project_gid: "1", workspace: "1" }],
      ["update_task", { task_gid: "1", completed: true, workspace: "1" }],
      ["delete_task", { task_gid: "1", workspace: "1" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.match(text(result), /Unrecognized key: "workspace"/, name);
    }
    assert.deepEqual(fake.requests, []);
  });

  it("count the largest verb's parameters within the limit, and refuse one more", async (t) => {
    t.mock.method(console, "error", () => {});
    const client = await connect();
    fake.routes = { [`GET /workspaces/${WORKSPACE.gid}/tasks/search`]: { json: { data: [] } } };
    const filters = {
      text: "x",
      assignee: "me",
      project_gid: "1",
      tag_gid: "3",
      completed: true,
      due_on_after: "2026-01-01",
      due_on_before: "2026-02-01",
      limit: 5,
    };
    const every = await client.callTool({ name: "search_tasks", arguments: { ...filters, section_gid: "2" } });
    assert.match(text(every), /not both/);
    const accepted = await client.callTool({ name: "search_tasks", arguments: filters });
    assert.equal(text(accepted), "matching tasks, newest first: no tasks");
    const fields = {
      name: "x",
      notes: "a",
      html_notes: "<body>a</body>",
      assignee: "me",
      due_on: "2026-11-20",
      due_at: "2026-11-20T17:00:00Z",
      start_on: "2026-11-18",
      resource_subtype: "milestone",
      project_gid: "1",
      section_gid: "2",
      parent_gid: "3",
    };
    const create = await client.callTool({ name: "create_task", arguments: fields });
    assert.match(text(create), /not both/);
    const tooMany = await client.callTool({ name: "create_task", arguments: { ...fields, extra: 1 } });
    assert.match(text(tooMany), /maximum of 11 elements/);
    assert.deepEqual(fake.requestsTo("POST", "/tasks"), []);
  });

  it("accept nulls that clear fields over MCP", async () => {
    const gid = "1300000000000001";
    fake.routes[`GET /tasks/${gid}`] = dataReply({ gid, workspace: { gid: WORKSPACE.gid } });
    fake.routes[`PUT /tasks/${gid}`] = dataReply({ gid, name: "x" });
    const cleared = { notes: null, assignee: null, due_on: null, start_on: null };
    const result = await (await connect()).callTool({ name: "update_task", arguments: { task_gid: gid, ...cleared } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(fake.requestsTo("PUT", `/tasks/${gid}`)[0].body, { data: { ...cleared, notes: "" } });
  });

  it("run writes one at a time, each workspace check right before its write", async () => {
    const client = await connect();
    const [parent, updated, deleted] = ["1300000000000001", "1300000000000002", "1300000000000003"];
    for (const gid of [parent, updated, deleted]) {
      fake.routes[`GET /tasks/${gid}`] = dataReply({ gid, workspace: { gid: WORKSPACE.gid } });
    }
    fake.routes["POST /tasks"] = dataReply({ gid: "1300000000000004" });
    fake.routes[`PUT /tasks/${updated}`] = dataReply({ gid: updated, completed: true });
    fake.routes[`DELETE /tasks/${deleted}`] = dataReply({});
    const results = await Promise.all([
      client.callTool({ name: "create_task", arguments: { name: "x", parent_gid: parent } }),
      client.callTool({ name: "update_task", arguments: { task_gid: updated, completed: true } }),
      client.callTool({ name: "delete_task", arguments: { task_gid: deleted } }),
    ]);
    assert.ok(results.every((result) => !result.isError));
    const order = fake.requests.map((request) => `${request.method} ${request.path}`);
    const pairs = [0, 2, 4].map((index) => order.slice(index, index + 2).join(" then "));
    assert.equal(order.length, 6);
    assert.deepEqual(pairs.sort(), [
      `GET /tasks/${parent} then POST /tasks`,
      `GET /tasks/${updated} then PUT /tasks/${updated}`,
      `GET /tasks/${deleted} then DELETE /tasks/${deleted}`,
    ]);
  });
});
