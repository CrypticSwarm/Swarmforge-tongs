// A workspace with no repository: healthy, but no verbs.

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";

const REASON = "/workspace had no 'origin' remote";

let httpServer: Server;
let endpoint: URL;
const clients: Client[] = [];

async function connect(mode: "auto" | "legacy"): Promise<Client> {
  const client = new Client({ name: "github-test", version: "0.0.0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  clients.push(client);
  return client;
}

before(async () => {
  httpServer = createApp({ idle: REASON }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  endpoint = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
});

describe("with no repository", () => {
  it("answers the launcher's readiness probe", async () => {
    const res = await fetch(new URL("/healthz", endpoint));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  for (const mode of ["auto", "legacy"] as const) {
    it(`lists no tools and says why (${mode})`, async () => {
      const client = await connect(mode);
      assert.deepEqual((await client.listTools()).tools, []);
      const instructions = client.getInstructions() ?? "";
      assert.match(instructions, /^No verbs/);
      assert.ok(instructions.includes(REASON), instructions);
    });
  }

  it("refuses a call to a verb it would otherwise have", async () => {
    const client = await connect("auto");
    await assert.rejects(client.callTool({ name: "push_branch", arguments: {} }), /Tool push_branch not found/);
  });
});
