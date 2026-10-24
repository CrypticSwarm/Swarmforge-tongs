import { strict as assert } from "node:assert";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import type { SigningKey } from "../src/gpg.js";
import { Repo } from "../src/repo.js";
import { MAX_TOOL_INPUT_ELEMENTS, type Context } from "../src/server.js";
import { FakeGit, commit } from "./fake-git.js";

const KEY: SigningKey = {
  fingerprint: "AAAABBBBCCCCDDDDEEEEFFFF00001111222233334",
  uids: ["Ada <ada@example.com>"],
  emails: ["ada@example.com"],
};

function freshGit(): FakeGit {
  const git = new FakeGit();
  const base = commit(git, { message: "published base" });
  git.published.add(base);
  const first = commit(git, { parents: [base], message: "local 0" });
  git.setHead(commit(git, { parents: [first], message: "local 1" }));
  return git;
}

type Mode = "pinned" | "auto" | "legacy";
const MODES: readonly Mode[] = ["pinned", "auto", "legacy"];

const NEGOTIATION = {
  pinned: { mode: { pin: "2026-07-28" } },
  auto: { mode: "auto" },
  legacy: { mode: "legacy" },
} as const;

/** Written out rather than imported, so moving the cap breaks a test. */
const BODY_CAP = 1024 * 1024;

type Recorded = { method: string; status: number; protocolVersion: string | null; bodyBytes: number };

let git: FakeGit;
let httpServer: Server;
let endpoint: URL;
let requests: Recorded[];
const clients: Client[] = [];

async function connect(mode: Mode = "pinned", icon?: string): Promise<Client> {
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      status: response.status,
      protocolVersion: headers.get("mcp-protocol-version"),
      bodyBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0,
    });
    return response;
  };
  const client = new Client(
    { name: "git-signing-test", version: "0.0.0", ...(icon ? { icons: [{ src: icon }] } : {}) },
    { versionNegotiation: NEGOTIATION[mode] },
  );
  await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: recordingFetch }));
  clients.push(client);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

before(async () => {
  // Getters, so the `git` swapped in by beforeEach reaches every later server.
  const context: Context = {
    get repo() {
      return new Repo(git.run, "/workspace", async () => false);
    },
    get run() {
      return git.run;
    },
    key: KEY,
    passphrase: undefined,
  };
  httpServer = createApp(context).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  endpoint = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

beforeEach(() => {
  git = freshGit();
  requests = [];
});

after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
});

describe("protocol eras", () => {
  for (const mode of ["pinned", "auto"] as const) {
    test(`a 2026-07-28 client negotiates the modern era and lists both verbs (${mode})`, async () => {
      const client = await connect(mode);
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.match(client.getInstructions() ?? "", /Call signing_status first/);
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["sign_commits", "signing_status"]);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.deepEqual(tool.inputSchema.properties ?? {}, {}, `${tool.name} takes no parameters`);
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} refuses invented parameters`);
      }

      assert.ok(requests.length > 0);
      for (const request of requests) {
        assert.equal(request.method, "POST");
        assert.equal(request.protocolVersion, "2026-07-28");
        assert.equal(request.status, 200);
        assert.ok(request.bodyBytes > 0, "every request has a body");
      }
    });
  }

  test("a 2025-era client still connects through the stateless fallback", async () => {
    const client = await connect("legacy");
    assert.equal(client.getProtocolEra(), "legacy");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["sign_commits", "signing_status"]);
    const result = await client.callTool({ name: "signing_status", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.match(text(result), /Unpublished commits \(2\)/);
  });
});

describe("client envelope size", () => {
  test("a 2026-07-28 client whose clientInfo carries a ~96 KB inline icon still connects", async () => {
    // clientInfo rides on every request.
    const icon = `data:image/png;base64,${"A".repeat(96 * 1024)}`;
    const client = await connect("pinned", icon);
    assert.equal(client.getProtocolEra(), "modern");
    const result = await client.callTool({ name: "signing_status", arguments: {} });
    assert.notEqual(result.isError, true, text(result));
    for (const request of requests) {
      assert.ok(request.bodyBytes > 96 * 1024, `${request.bodyBytes} bytes`);
      assert.equal(request.status, 200);
    }
  });
});

describe("tool calls over HTTP", () => {
  test("signing_status reports through the stubbed repository", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "signing_status", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.match(text(result), /branch:\s+feature/);
    assert.match(text(result), /2 commit\(s\) would be re-created with a signature/);
    assert.deepEqual(git.refUpdates, [], "status is read-only");
  });

  test("sign_commits signs and moves the branch", async () => {
    const client = await connect();
    const originalHead = git.head;
    const result = await client.callTool({ name: "sign_commits", arguments: {} });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /Signed 2 commit\(s\) on feature/);
    assert.equal(git.signedPayloads.length, 2);
    assert.notEqual(git.refs.get("refs/heads/feature"), originalHead);
  });

  test("a call with no arguments object at all is accepted", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "signing_status" });
    assert.notEqual(result.isError, true, text(result));
  });
});

describe("per-request server construction", () => {
  for (const mode of MODES) {
    test(`many sequential requests on one connection each succeed (${mode})`, async () => {
      const client = await connect(mode);
      for (let i = 0; i < 10; i++) {
        const result = await client.callTool({ name: "signing_status", arguments: {} });
        assert.notEqual(result.isError, true, `call ${i}: ${text(result)}`);
      }
      assert.match(text(await client.callTool({ name: "sign_commits", arguments: {} })), /Signed 2/);
      assert.match(text(await client.callTool({ name: "sign_commits", arguments: {} })), /Nothing to sign/);
    });
  }

  test("sequential connections in every negotiation mode each succeed", async () => {
    for (const mode of [...MODES, ...MODES]) {
      const client = await connect(mode);
      assert.equal((await client.listTools()).tools.length, 2);
    }
  });

  test("concurrent requests across connections and negotiation modes all succeed", async () => {
    const modes: Mode[] = ["pinned", "pinned", "auto", "auto", "legacy", "legacy"];
    const connected = await Promise.all(modes.map((mode) => connect(mode)));
    const results = await Promise.all(
      connected.flatMap((client) => [
        client.listTools().then((r) => r.tools.length),
        ...Array.from({ length: 4 }, () =>
          client.callTool({ name: "signing_status", arguments: {} }).then((r) => {
            assert.notEqual(r.isError, true, text(r));
            return text(r);
          }),
        ),
      ]),
    );
    assert.equal(results.length, modes.length * 5);
    for (const result of results) {
      if (typeof result === "number") assert.equal(result, 2);
      else assert.match(result, /Unpublished commits \(2\)/);
    }
  });
});

describe("untrusted arguments", () => {
  for (const mode of MODES) {
    test(`a payload over maxToolInputElements is refused before the verb runs (${mode})`, async () => {
      const client = await connect(mode);
      const result = await client.callTool({
        name: "sign_commits",
        arguments: { ref: "refs/heads/main", key: ["a", "b", "c"], nested: { deep: [1, 2, 3] } },
      });
      assert.equal(result.isError, true);
      assert.match(
        text(result),
        new RegExp(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`),
      );
      assert.equal(git.signedPayloads.length, 0, "gpg must not have run");
      assert.deepEqual(git.refUpdates, [], "nothing should have been written");
    });
  }

  test("an invented argument within the element cap is refused by the strict schema", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "sign_commits", arguments: { ref: "refs/heads/main" } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Input validation error/);
    assert.deepEqual(git.refUpdates, [], "nothing should have been written");
  });
});

describe("plain HTTP", () => {
  const POST_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  /** `id` stays null unless the request was readable. */
  async function assertJsonRpcError(
    response: Response,
    status: number,
    code: number,
    id: number | null = null,
  ): Promise<void> {
    const body = await response.text();
    assert.equal(response.status, status, body);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.doesNotMatch(body, /node_modules|\n\s+at |<html|<pre/i, "no stack trace or HTML error page");
    const parsed = JSON.parse(body);
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, id);
    assert.equal(parsed.error.code, code);
  }

  test("GET and DELETE on /mcp are 405: there is no session", async () => {
    for (const method of ["GET", "DELETE"]) {
      await assertJsonRpcError(await fetch(endpoint, { method }), 405, -32000);
    }
  });

  /** The extra "pad" member fails the SDK's strict JSON-RPC schema, so even an under-cap body is refused. */
  function paddedBody(length: number): string {
    const head = '{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"';
    const tail = '"}';
    const body = head + "x".repeat(length - head.length - tail.length) + tail;
    assert.equal(body.length, length);
    return body;
  }

  const badBodies: Array<[string, string, number, number, (number | null)?]> = [
    ["malformed JSON", '{"jsonrpc": "2.0", "id": 1, "method":', 400, -32700],
    ["a JSON value that is not a JSON-RPC message", '"hello"', 400, -32600],
    ["an empty body", "", 400, -32700],
    // The pair pins the cap exactly: lowering it breaks the first, raising it the second.
    ["a body of exactly the size cap", paddedBody(BODY_CAP), 400, -32600, 1],
    ["a body one byte over the size cap", paddedBody(BODY_CAP + 1), 413, -32000],
  ];
  for (const [what, body, status, code, id] of badBodies) {
    test(`${what} gets a JSON-RPC error, not an HTML page`, async (t) => {
      t.mock.method(console, "error", () => {});
      await assertJsonRpcError(await fetch(endpoint, { method: "POST", headers: POST_HEADERS, body }), status, code, id);
      assert.deepEqual(git.refUpdates, []);
    });
  }

  test("a declared over-cap body is refused before it is sent", async () => {
    // Only one byte is written, so this times out unless Content-Length is checked up front.
    const req = httpRequest(endpoint, {
      method: "POST",
      headers: { ...POST_HEADERS, "content-length": String(BODY_CAP + 1) },
    });
    try {
      const responded = new Promise<{ status: number; body: string }>((resolve, reject) => {
        req.on("response", (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          res.on("error", reject);
          res.resume();
        });
        req.on("error", reject);
        req.setTimeout(5000, () => reject(new Error("no response while the body was still incomplete")));
      });
      req.write("{");
      const { status, body } = await responded;
      assert.equal(status, 413, body);
      assert.equal(JSON.parse(body).error.code, -32000);
    } finally {
      req.destroy();
    }
  });

  test("/healthz answers", async () => {
    const response = await fetch(new URL("/healthz", endpoint));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});
