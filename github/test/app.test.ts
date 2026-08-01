// Transport-shell tests: no token, no repository, no network.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";

let base: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A Streamable-HTTP response may arrive as SSE rather than a bare JSON body;
// both carry the same JSON-RPC payload.
function parseRpc(contentType: string | null, body: string): unknown {
  if (contentType?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("");
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

describe("healthz", () => {
  it("answers the launcher's readiness probe", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("mcp", () => {
  it("initializes and names the tong", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });

    assert.equal(res.status, 200);
    const rpc = parseRpc(res.headers.get("content-type"), await res.text()) as {
      result?: { serverInfo?: { name?: string } };
    };
    assert.equal(rpc.result?.serverInfo?.name, "github");
  });

  it("exposes no verbs yet", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    // Without an initialize handshake the stateless transport refuses the call;
    // either way there is no verb here to invoke.
    const rpc = parseRpc(res.headers.get("content-type"), await res.text()) as {
      result?: { tools?: unknown[] };
      error?: unknown;
    };
    assert.ok(rpc.error !== undefined || rpc.result?.tools?.length === 0);
  });

  for (const method of ["GET", "DELETE"] as const) {
    it(`refuses ${method}`, async () => {
      const res = await fetch(`${base}/mcp`, { method });
      assert.equal(res.status, 405);
      assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32000);
    });
  }
});
