import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { FakeAsana, TOKEN, WORKSPACE, errorReply, meRoute, workspaceRoute } from "./fakes.js";

const VERBS = ["current_user"];

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
