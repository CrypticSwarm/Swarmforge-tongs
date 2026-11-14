import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { FakeAsana, TOKEN, WORKSPACE, dataReply, errorReply, meRoute, workspaceRoute } from "./fakes.js";

const VERBS = [
  "add_comment",
  "add_to_portfolio",
  "create_task",
  "current_user",
  "delete_task",
  "find_projects",
  "get_project",
  "get_task",
  "list_comments",
  "list_tasks",
  "list_users",
  "remove_from_portfolio",
  "search_tasks",
  "update_project",
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

function manyFields(count: number, value: unknown): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`field ${index}`, value]));
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
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /no verb accepts a workspace/);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), VERBS);
    for (const name of VERBS) assert.doesNotMatch(instructions, new RegExp(name), `${name} is not in the instructions`);
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
      ["update_task", { task_gid: "1", custom_fields: {} }, "custom_fields"],
      ["update_task", { task_gid: "1", custom_fields: manyFields(21, "x") }, "custom_fields"],
      ["update_task", { task_gid: "1", custom_fields: { "a\nb": "x" } }, "custom_fields.a\nb"],
      ["update_task", { task_gid: "1", custom_fields: { a: "x".repeat(1025) } }, "custom_fields.a"],
      ["update_task", { task_gid: "1", custom_fields: { a: Array(21).fill("x") } }, "custom_fields.a"],
      ["update_task", { task_gid: "1", custom_fields: { a: ["x\u2028"] } }, "custom_fields.a.0"],
      ["update_task", { task_gid: "1", custom_fields: { a: { date: "2026-11-20" } } }, "custom_fields.a"],
      ["create_task", { name: "x", project_gid: "1", custom_fields: { a: true } }, "custom_fields.a"],
      ["update_task", JSON.parse('{"task_gid": "1", "custom_fields": {"__proto__": "x", "a": "y"}}'), "custom_fields"],
      ["update_task", { task_gid: "1", move_to: {} }, "move_to.project_gid"],
      ["update_task", { task_gid: "1", move_to: { project_gid: "1", section_gid: "x" } }, "move_to.section_gid"],
      ["update_task", { task_gid: "1", move_to: "1" }, "move_to"],
      ["update_task", { task_gid: "1", remove_from_project: null }, "remove_from_project"],
      ["update_task", { task_gid: "1", parent_gid: "../2" }, "parent_gid"],
      ["update_task", { task_gid: "1", add_blocked_by: [] }, "add_blocked_by"],
      ["update_task", { task_gid: "1", add_blocked_by: Array(21).fill("2") }, "add_blocked_by"],
      ["update_task", { task_gid: "1", remove_blocked_by: ["2", "x"] }, "remove_blocked_by.1"],
      ["create_task", { name: "x", project_gid: "1", blocked_by: "2" }, "blocked_by"],
      ["list_comments", { task_gid: "1/stories" }, "task_gid"],
      ["list_comments", { task_gid: "1", include_system: "yes" }, "include_system"],
      ["list_comments", { task_gid: "1", include_html: 1 }, "include_html"],
      ["list_comments", { task_gid: "1", limit: 0 }, "limit"],
      ["list_comments", { task_gid: "1", cursor: "a&b" }, "cursor"],
      ["add_comment", { task_gid: "../1", text: "x" }, "task_gid"],
      ["add_comment", { task_gid: "1", text: " \n" }, "text"],
      ["add_comment", { task_gid: "1", text: "x".repeat(20_001) }, "text"],
      ["add_comment", { task_gid: "1", html_text: "plain" }, "html_text"],
      ["add_comment", { task_gid: "1", html_text: `<body>${"x".repeat(19_988)}</body>` }, "html_text"],
      ["add_comment", { task_gid: "1", html_text: "<body>a</body><body>b</body>" }, "html_text"],
      ["update_project", { project_gid: "1" }, "custom_fields"],
      ["update_project", { project_gid: "1", custom_fields: {} }, "custom_fields"],
      ["update_project", { project_gid: "1/duplicate", custom_fields: { a: "x" } }, "project_gid"],
      ["add_to_portfolio", { portfolio_gid: "1" }, "project_gid"],
      ["add_to_portfolio", { portfolio_gid: "1", project_gid: "me" }, "project_gid"],
      ["remove_from_portfolio", { portfolio_gid: "../1", project_gid: "2" }, "portfolio_gid"],
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
      ["update_task", { task_gid: "1", move_to: { project_gid: "1", workspace: "1" } }],
      ["delete_task", { task_gid: "1", workspace: "1" }],
      ["list_comments", { task_gid: "1", workspace: "1" }],
      ["add_comment", { task_gid: "1", text: "x", workspace: "1" }],
      ["update_project", { project_gid: "1", custom_fields: { a: "x" }, workspace: "1" }],
      ["add_to_portfolio", { portfolio_gid: "1", project_gid: "2", workspace: "1" }],
      ["remove_from_portfolio", { portfolio_gid: "1", project_gid: "2", workspace: "1" }],
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
    const blockers = Array.from({ length: 20 }, (_, index) => String(1300000000000100 + index));
    const fields = {
      task_gid: "1",
      name: "x",
      notes: "a",
      html_notes: "<body>a</body>",
      assignee: "me",
      due_on: "2026-11-20",
      due_at: "2026-11-20T17:00:00Z",
      start_on: "2026-11-18",
      resource_subtype: "milestone",
      completed: true,
      approval_status: "approved",
      custom_fields: manyFields(20, Array(20).fill("x")),
      move_to: { project_gid: "2", section_gid: "3" },
      remove_from_project: "4",
      parent_gid: "5",
      add_blocked_by: blockers,
      remove_blocked_by: blockers,
    };
    const update = await client.callTool({ name: "update_task", arguments: fields });
    assert.match(text(update), /not both/);
    const tooMany = await client.callTool({ name: "update_task", arguments: { ...fields, extra: 1 } });
    assert.match(text(tooMany), /maximum of 479 elements/);
    assert.ok(fake.requests.every((request) => request.method === "GET"));
  });

  it("accept nulls that clear fields over MCP", async () => {
    const gid = "1300000000000001";
    fake.routes[`GET /tasks/${gid}`] = dataReply({ gid, workspace: { gid: WORKSPACE.gid } });
    fake.routes[`PUT /tasks/${gid}`] = dataReply({ gid, name: "x" });
    fake.routes[`POST /tasks/${gid}/setParent`] = dataReply({ gid, parent: null });
    const cleared = { notes: null, assignee: null, due_on: null, start_on: null };
    const result = await (await connect()).callTool({
      name: "update_task",
      arguments: { task_gid: gid, ...cleared, parent_gid: null },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(fake.requestsTo("PUT", `/tasks/${gid}`)[0].body, { data: { ...cleared, notes: "" } });
    assert.deepEqual(fake.requestsTo("POST", `/tasks/${gid}/setParent`)[0].body, { data: { parent: null } });
  });

  it("route portfolio and project writes, and run them one at a time", async () => {
    const [first, second, third] = await Promise.all([connect(), connect(), connect()]);
    const portfolio = "2100000000000001";
    const [updated, added, removed] = ["1400000000000001", "1400000000000002", "1400000000000003"];
    const inWorkspace = { workspace: { gid: WORKSPACE.gid } };
    fake.routes[`GET /portfolios/${portfolio}`] = dataReply({ gid: portfolio, ...inWorkspace });
    for (const gid of [added, removed]) fake.routes[`GET /projects/${gid}`] = dataReply({ gid, ...inWorkspace });
    const field = { gid: "1600000000000001", name: "Budget", resource_subtype: "number" };
    fake.routes[`GET /projects/${updated}`] = dataReply({ gid: updated, ...inWorkspace, custom_fields: [field] });
    fake.routes[`PUT /projects/${updated}`] = dataReply({ gid: updated, name: "Launch" });
    fake.routes[`POST /portfolios/${portfolio}/addItem`] = dataReply({});
    fake.routes[`POST /portfolios/${portfolio}/removeItem`] = dataReply({});
    const results = await Promise.all([
      first.callTool({ name: "update_project", arguments: { project_gid: updated, custom_fields: { Budget: 5 } } }),
      second.callTool({ name: "add_to_portfolio", arguments: { portfolio_gid: portfolio, project_gid: added } }),
      third.callTool({ name: "remove_from_portfolio", arguments: { portfolio_gid: portfolio, project_gid: removed } }),
    ]);
    assert.deepEqual(results.map(text), [
      "updated project: Launch (gid 1400000000000001)\ncustom field 1600000000000001: not in Asana's answer",
      `added project ${added} to portfolio ${portfolio}`,
      `removed project ${removed} from portfolio ${portfolio}`,
    ]);
    const order = fake.requests.map((request) => `${request.method} ${request.path}`);
    const runs = [
      [`GET /projects/${updated}`, `PUT /projects/${updated}`],
      [`GET /portfolios/${portfolio}`, `GET /projects/${added}`, `POST /portfolios/${portfolio}/addItem`],
      [`GET /portfolios/${portfolio}`, `GET /projects/${removed}`, `POST /portfolios/${portfolio}/removeItem`],
    ];
    assert.equal(order.length, 8);
    for (const run of runs) {
      const end = order.indexOf(run.at(-1)!);
      assert.deepEqual(order.slice(end - run.length + 1, end + 1), run);
    }
  });

  it("run writes one at a time across sessions, each workspace check right before its write", async () => {
    const [first, second, third, fourth] = await Promise.all([connect(), connect(), connect(), connect()]);
    const gids = ["1300000000000001", "1300000000000002", "1300000000000003", "1300000000000004"];
    const [parent, updated, deleted, commented] = gids;
    for (const gid of gids) {
      fake.routes[`GET /tasks/${gid}`] = dataReply({ gid, workspace: { gid: WORKSPACE.gid } });
    }
    fake.routes["POST /tasks"] = dataReply({ gid: "1300000000000005" });
    fake.routes[`POST /tasks/${commented}/stories`] = dataReply({ gid: "1900000000000001" });
    fake.routes[`PUT /tasks/${updated}`] = dataReply({ gid: updated, completed: true });
    fake.routes[`DELETE /tasks/${deleted}`] = dataReply({});
    const results = await Promise.all([
      first.callTool({ name: "create_task", arguments: { name: "x", parent_gid: parent } }),
      second.callTool({ name: "update_task", arguments: { task_gid: updated, completed: true } }),
      third.callTool({ name: "delete_task", arguments: { task_gid: deleted } }),
      fourth.callTool({ name: "add_comment", arguments: { task_gid: commented, text: "x" } }),
    ]);
    assert.ok(results.every((result) => !result.isError));
    const order = fake.requests.map((request) => `${request.method} ${request.path}`);
    const pairs = [0, 2, 4, 6].map((index) => order.slice(index, index + 2).join(" then "));
    assert.equal(order.length, 8);
    assert.deepEqual(pairs.sort(), [
      `GET /tasks/${parent} then POST /tasks`,
      `GET /tasks/${updated} then PUT /tasks/${updated}`,
      `GET /tasks/${deleted} then DELETE /tasks/${deleted}`,
      `GET /tasks/${commented} then POST /tasks/${commented}/stories`,
    ]);
  });
});
