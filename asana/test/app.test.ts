import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { FakeAsana, TOKEN, WORKSPACE, dataReply, errorReply, meRoute, workspaceRoute } from "./fakes.js";

const VERBS = ["current_user", "get_task", "list_tasks", "search_tasks"];

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

describe("task verbs", () => {
  it("serve get_task over MCP", async () => {
    const task = { gid: "1300000000000001", name: "Ship it", workspace: { gid: WORKSPACE.gid } };
    fake.routes = { "GET /tasks/1300000000000001": dataReply(task) };
    const result = await (await connect()).callTool({ name: "get_task", arguments: { task_gid: task.gid } });
    assert.match(text(result), /^task: Ship it \(gid 1300000000000001\)\n/);
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
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(text(result), new RegExp(`tool ${name}: ${field}: `), `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(fake.requests, []);
  });

  it("count all nine search parameters within the limit, and refuse one more", async (t) => {
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
    const tooMany = await client.callTool({ name: "search_tasks", arguments: { ...filters, section_gid: "2", extra: 1 } });
    assert.match(text(tooMany), /maximum of 9 elements/);
  });
});
