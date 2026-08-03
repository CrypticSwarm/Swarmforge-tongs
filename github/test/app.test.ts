// Transport-shell tests: no token, no repository, no network.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { GitHub } from "../src/github.js";
import { pushUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import { ASKPASS, FakeGit, FakeGitHubApi, WORKSPACE } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };

let base: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

before(async () => {
  const git = new FakeGit();
  const api = new FakeGitHubApi();
  server = createApp({
    repo: new Repo(git.run, WORKSPACE, ASKPASS, false),
    github: new GitHub(api.fetch, ORIGIN, "unused"),
    origin: ORIGIN,
    pushUrl: pushUrl(ORIGIN),
    token: "unused",
  }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A Streamable-HTTP response may arrive as SSE rather than a bare JSON body; both
// carry the same JSON-RPC payload.
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

  for (const method of ["GET", "DELETE"] as const) {
    it(`refuses ${method}`, async () => {
      const res = await fetch(`${base}/mcp`, { method });
      assert.equal(res.status, 405);
      assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32000);
    });
  }
});
