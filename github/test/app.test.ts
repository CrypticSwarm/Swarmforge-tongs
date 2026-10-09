// The MCP endpoint end to end, in process: the real express app from src/app.ts
// on an ephemeral port, driven over real HTTP -- by the SDK's own client and by
// hand -- with the fake git and fake GitHub API from fakes.ts behind it. No
// token, no repository, no network.
//
// Covers what the unit suites cannot: that both protocol eras are served; that
// the per-request server construction holds up under repeated and concurrent
// requests -- an MCP server instance connects to exactly one transport, so any
// instance reuse across requests fails here; that the largest schema-legal call
// fits through the body cap; that untrusted arguments are refused before they
// reach git or GitHub; and that malformed, oversized, and non-POST requests get
// JSON-RPC errors rather than express error pages.

import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { MAX_LOG_LINES } from "../src/ci.js";
import { GitHub, MAX_BODY, MAX_TITLE } from "../src/github.js";
import { remoteUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import { MAX_TOOL_INPUT_ELEMENTS, type Context } from "../src/server.js";
import {
  ASKPASS,
  FakeGit,
  FakeGitHubApi,
  REPO_ROUTE,
  WORKSPACE,
  editablePrRoutes,
  jobRoute,
  jobsRoute,
  listPrsRoute,
  logRoutes,
  prRoute,
  runsRoute,
} from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const TOKEN = "ghp_thisIsTheSecretTokenValue";
const OPEN_PR = { number: 7, title: "Add a thing", body: "why", base: "main", head: "feature" };
const VERBS = ["ci_job", "ci_log", "ci_status", "create_pr", "fetch_origin", "find_pr", "get_pr", "push_branch", "update_pr"];

/**
 * The body cap from src/app.ts, written out rather than imported so that moving
 * the cap in either direction breaks a test here.
 */
const BODY_CAP = 1024 * 1024;

/**
 * How the client negotiates: pinned to 2026-07-28, probing with
 * `server/discover` (which must land on 2026-07-28 here), or the plain 2025
 * `initialize` handshake.
 */
type Mode = "pinned" | "auto" | "legacy";
const MODES: readonly Mode[] = ["pinned", "auto", "legacy"];

const NEGOTIATION = {
  pinned: { mode: { pin: "2026-07-28" } },
  auto: { mode: "auto" },
  legacy: { mode: "legacy" },
} as const;

type Recorded = {
  method: string;
  rpcMethod: string | undefined;
  status: number;
  protocolVersion: string | null;
  bodyBytes: number;
};

let git: FakeGit;
let api: FakeGitHubApi;
let httpServer: Server;
let endpoint: URL;
let requests: Recorded[];
const clients: Client[] = [];

/** Nothing the tong did reached git's push or the GitHub API. */
function assertUntouched(): void {
  assert.deepEqual(api.calls, [], "the GitHub API must not have been called");
  assert.equal(git.pushCall, undefined, "nothing must have been pushed");
}

async function connect(mode: Mode = "pinned"): Promise<Client> {
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      method: init?.method ?? "GET",
      rpcMethod: body ? (JSON.parse(body) as { method?: string }).method : undefined,
      status: response.status,
      protocolVersion: new Headers(init?.headers).get("mcp-protocol-version"),
      bodyBytes: body ? Buffer.byteLength(body) : 0,
    });
    return response;
  };
  const client = new Client({ name: "github-test", version: "0.0.0" }, { versionNegotiation: NEGOTIATION[mode] });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: recordingFetch }));
  clients.push(client);
  return client;
}

/**
 * A Streamable-HTTP response may arrive as SSE rather than a bare JSON body; both
 * carry the same JSON-RPC payload.
 */
async function readRpc(res: Response): Promise<unknown> {
  const body = await res.text();
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : body;
  return JSON.parse(payload);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

before(async () => {
  // The context is read per request, so swapping the fakes in beforeEach reaches
  // every server the factory builds afterwards.
  const context: Context = {
    get repo() {
      return new Repo(git.run, WORKSPACE, ASKPASS, false);
    },
    get github() {
      return new GitHub(api.fetch, ORIGIN, TOKEN);
    },
    origin: ORIGIN,
    remoteUrl: remoteUrl(ORIGIN),
    token: TOKEN,
  };
  httpServer = createApp(context).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  endpoint = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

beforeEach(() => {
  git = new FakeGit();
  api = new FakeGitHubApi({
    ...REPO_ROUTE,
    ...prRoute(7, "main", "feature"),
    ...editablePrRoutes(OPEN_PR),
    ...listPrsRoute([OPEN_PR, { ...OPEN_PR, number: 3, state: "closed", merged: true }]),
  });
  requests = [];
});

after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
});

describe("healthz", () => {
  it("answers the launcher's readiness probe", async () => {
    const res = await fetch(new URL("/healthz", endpoint));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("protocol eras", () => {
  for (const mode of ["pinned", "auto"] as const) {
    it(`a 2026-07-28 client negotiates the modern era and lists every verb (${mode})`, async () => {
      const client = await connect(mode);
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.equal(client.getServerVersion()?.name, "github");
      assert.match(client.getInstructions() ?? "", /The GitHub token lives only in this tong/);
      // The tool set never changes, so nothing invites a client to hold a listen stream open.
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);

      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
      assert.deepEqual(Object.keys(byName).sort(), VERBS);

      // What the strict zod 4 schemas list: no extra keys, the right required set,
      // and every parameter still described.
      const expected: Record<string, { properties: string[]; required: string[] | undefined }> = {
        push_branch: { properties: [], required: undefined },
        ci_status: { properties: ["pr", "sha"], required: undefined },
        ci_job: { properties: ["job_id"], required: ["job_id"] },
        ci_log: { properties: ["job_id", "limit", "start", "step"], required: ["job_id"] },
        fetch_origin: { properties: [], required: undefined },
        create_pr: { properties: ["base", "body", "draft", "title"], required: ["title"] },
        find_pr: { properties: ["head"], required: ["head"] },
        get_pr: { properties: ["number"], required: ["number"] },
        update_pr: { properties: ["base", "body", "draft", "number", "state", "title"], required: ["number"] },
      };
      for (const [name, schema] of Object.entries(byName)) {
        assert.equal(schema.type, "object", name);
        assert.equal(schema.additionalProperties, false, `${name} refuses invented parameters`);
        const properties = (schema.properties ?? {}) as Record<string, { description?: string }>;
        assert.deepEqual(Object.keys(properties).sort(), expected[name].properties, name);
        assert.deepEqual(schema.required, expected[name].required, name);
        for (const [key, property] of Object.entries(properties)) {
          assert.ok(property.description, `${name}.${key} is described`);
        }
      }
      const updateProps = byName.update_pr.properties as Record<string, Record<string, unknown>>;
      assert.equal(updateProps.number.type, "integer");
      assert.equal(updateProps.title.maxLength, MAX_TITLE);
      assert.equal(updateProps.body.maxLength, MAX_BODY);
      assert.deepEqual(updateProps.state.enum, ["open", "closed"]);
      // The branch-name rule is a regex so clients can see it, not a refinement they cannot.
      for (const name of ["create_pr", "update_pr"]) {
        const baseProp = (byName[name].properties as Record<string, Record<string, unknown>>).base;
        // Portable: no lookahead, only \xHH escapes, and an escaped hyphen.
        const pattern = baseProp.pattern as string;
        assert.equal(pattern, "^[^\\-\\s\\x00-\\x1f\\x7f][^\\s\\x00-\\x1f\\x7f]*$", `${name}.base lists its pattern`);
        // A client may compile it under any ECMA-262 flag set; each must accept it.
        for (const flags of ["", "u", "v"]) {
          const listed: RegExp = new RegExp(pattern, flags);
          assert.equal(listed.test("-x"), false, `/${flags}`);
          assert.equal(listed.test("feature/x"), true, `/${flags}`);
          assert.equal(listed.test("a b"), false, `/${flags}`);
        }
      }

      // Every request on the wire was a POST with a body, carrying the modern
      // revision; no `initialize`.
      assert.ok(requests.length > 0);
      for (const request of requests) {
        assert.equal(request.method, "POST");
        assert.notEqual(request.rpcMethod, "initialize");
        assert.equal(request.protocolVersion, "2026-07-28");
        assert.equal(request.status, 200);
        assert.ok(request.bodyBytes > 0, "every request has a body");
      }
    });
  }

  it("a 2025-era client still connects through the stateless fallback", async () => {
    const client = await connect("legacy");
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal((await client.listTools()).tools.length, VERBS.length);
    const result = await client.callTool({ name: "get_pr", arguments: { number: 7 } });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /#7 feature -> main \(open\)/);
  });

  it("a hand-written 2025 initialize names the tong", async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    assert.equal(res.status, 200);
    const rpc = (await readRpc(res)) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(rpc.result?.serverInfo?.name, "github");
  });
});

describe("tool calls over HTTP", () => {
  it("push_branch pushes through the fake git", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "push_branch", arguments: {} });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /Pushed feature to acme\/widgets/);
    assert.ok(git.pushCall);
  });

  it("fetch_origin fetches through the fake git", async () => {
    git.fetchOutput = `  ${"a".repeat(40)} ${"b".repeat(40)} refs/remotes/origin/main\n`;
    const client = await connect();
    const result = await client.callTool({ name: "fetch_origin", arguments: {} });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /Fetched acme\/widgets; 1 ref updated:\n\norigin\/main a{12}\.\.b{12} \(fast-forward\)/);
    assert.ok(git.fetchCall);
    assert.equal(git.pushCall, undefined);
  });

  it("create_pr pushes and opens the pull request", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "create_pr", arguments: { title: "Add a thing", body: "why" } });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /Opened pull request #7: feature -> main/);
    assert.deepEqual(api.lastBody, { title: "Add a thing", body: "why", head: "feature", base: "main", draft: false });
  });

  it("get_pr reads and update_pr edits", async () => {
    const client = await connect();
    assert.match(text(await client.callTool({ name: "get_pr", arguments: { number: 7 } })), /title: Add a thing/);
    const result = await client.callTool({ name: "update_pr", arguments: { number: 7, title: "Better" } });
    assert.match(text(result), /Updated pull request #7: title/);
    assert.match(text(await client.callTool({ name: "get_pr", arguments: { number: 7 } })), /title: Better/);
  });

  it("a handler that throws becomes an error result naming the verb, and is logged", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const client = await connect();
    const result = await client.callTool({ name: "get_pr", arguments: { number: 99 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /^get_pr: error: /);
    assert.equal(logged.mock.calls[0]?.arguments[0], "get_pr failed:");
  });
});

describe("CI over HTTP", () => {
  it("ci_status, ci_job, and ci_log read a failed run down to its log", async () => {
    git.refs.set("refs/remotes/origin/feature", git.head);
    const failing = { id: 7, conclusion: "failure", steps: [{ name: "Test", conclusion: "failure" }] };
    Object.assign(api.routes, runsRoute([{ id: 100, conclusion: "failure" }]), jobsRoute(100, [failing]));
    Object.assign(api.routes, jobRoute(failing), logRoutes(7, "2026-10-07T12:00:04.5000000Z boom\n"));
    const client = await connect();

    assert.match(text(await client.callTool({ name: "ci_status", arguments: {} })), /job 7 test: failure at step 1 \(Test\)/);
    assert.match(text(await client.callTool({ name: "ci_job", arguments: { job_id: 7 } })), /1\. Test: failure/);
    assert.match(text(await client.callTool({ name: "ci_log", arguments: { job_id: 7 } })), /Z boom$/);
  });
});

describe("find_pr over HTTP", () => {
  it("finds pull requests by head branch, merged ones included", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "find_pr", arguments: { head: "feature" } });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /#7 feature -> main \(open\)/);
    assert.match(text(result), /#3 feature -> main \(merged\)/);
    assert.equal(git.pushCall, undefined, "a lookup pushes nothing");
    assert.deepEqual(
      api.calls.map((call) => call.method),
      ["GET"],
      "a lookup only reads",
    );
  });
});

describe("the largest schema-legal call", () => {
  // zod 4 measures string lengths in Unicode code points, and the most bytes one
  // code point can cost on the wire is twelve: an astral character written as an
  // escaped surrogate pair, which is what Python's json.dumps sends by default.
  // The SDK client's JSON.stringify writes it as four raw UTF-8 bytes instead, so
  // these requests are built by hand.
  const ASTRAL = "\u{1F600}";
  const ESCAPED = "\\ud83d\\ude00";
  const BRANCH_MAX = 255;
  const WORST_CASE_STRING_BYTES = 12 * (MAX_TITLE + MAX_BODY + BRANCH_MAX);
  /** app.ts promises the 2026-07-28 envelope about 250 KiB beyond the worst-case call. */
  const ENVELOPE_HEADROOM = 240 * 1024;

  /** A JSON string literal of `count` escaped astral code points. */
  const escaped = (count: number) => `"${ESCAPED.repeat(count)}"`;

  type Era = "2026-07-28" | "2025";

  /**
   * One raw `tools/call`, `args` already serialized. The 2026-07-28 request
   * carries the envelope with a `clientInfo` icon sized to the documented
   * headroom, so the cap has to fit both at once.
   */
  async function rawCall(era: Era, name: string, args: string) {
    const params =
      era === "2026-07-28"
        ? `{"name":"${name}","arguments":${args},"_meta":{` +
          `"io.modelcontextprotocol/protocolVersion":"2026-07-28",` +
          `"io.modelcontextprotocol/clientInfo":{"name":"raw","version":"0","icons":[{"src":"data:image/png;base64,` +
          "A".repeat(ENVELOPE_HEADROOM) +
          `"}]},"io.modelcontextprotocol/clientCapabilities":{}}}`
        : `{"name":"${name}","arguments":${args}}`;
    const body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${params}}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(era === "2026-07-28"
        ? { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name }
        : { "mcp-protocol-version": "2025-11-25" }),
    };
    const res = await fetch(endpoint, { method: "POST", headers, body });
    const wireBytes = Buffer.byteLength(body);
    assert.equal(res.status, 200, `${era} ${name}: ${wireBytes} bytes`);
    const rpc = (await readRpc(res)) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { wireBytes, isError: rpc.result.isError === true, text: rpc.result.content[0]?.text ?? "" };
  }

  const fullUpdate = (bodyCodePoints: number) =>
    `{"number":7,"title":${escaped(MAX_TITLE)},"body":${escaped(bodyCodePoints)},` +
    `"base":${escaped(BRANCH_MAX)},"state":"closed","draft":true}`;

  for (const era of ["2026-07-28", "2025"] as const) {
    it(`update_pr with every field at its limit goes through (${era})`, async () => {
      const call = await rawCall(era, "update_pr", fullUpdate(MAX_BODY));
      assert.equal(call.isError, false, call.text);
      assert.match(call.text, /Updated pull request #7: title, description, base main -> .*, closed it, converted it to a draft/);
      assert.ok(call.wireBytes >= WORST_CASE_STRING_BYTES, `${call.wireBytes} bytes on the wire`);
      if (era === "2025") {
        assert.ok(BODY_CAP - call.wireBytes >= ENVELOPE_HEADROOM, `${BODY_CAP - call.wireBytes} bytes of headroom`);
      } else {
        assert.ok(call.wireBytes >= WORST_CASE_STRING_BYTES + ENVELOPE_HEADROOM);
      }

      const patch = api.calls.find((c) => c.method === "PATCH");
      assert.deepEqual(patch?.body, {
        title: ASTRAL.repeat(MAX_TITLE),
        body: ASTRAL.repeat(MAX_BODY),
        base: ASTRAL.repeat(BRANCH_MAX),
        state: "closed",
      });
    });

    it(`create_pr with every field at its limit goes through (${era})`, async () => {
      const args = `{"title":${escaped(MAX_TITLE)},"body":${escaped(MAX_BODY)},"base":${escaped(BRANCH_MAX)},"draft":true}`;
      const call = await rawCall(era, "create_pr", args);
      assert.equal(call.isError, false, call.text);
      assert.ok(call.wireBytes >= WORST_CASE_STRING_BYTES, `${call.wireBytes} bytes on the wire`);
      assert.deepEqual(api.lastBody, {
        title: ASTRAL.repeat(MAX_TITLE),
        body: ASTRAL.repeat(MAX_BODY),
        head: "feature",
        base: ASTRAL.repeat(BRANCH_MAX),
        draft: true,
      });
    });

    it(`one code point more is refused by the schema, not the cap (${era})`, async () => {
      const call = await rawCall(era, "update_pr", fullUpdate(MAX_BODY + 1));
      assert.equal(call.isError, true);
      assert.match(call.text, /body: Too big/);
      assertUntouched();
    });
  }

  it("lengths are counted in code points, not UTF-16 units", async () => {
    // MAX_BODY astral characters are twice MAX_BODY UTF-16 units: accepted, as the
    // listed `maxLength` promises a client; one more is not.
    const client = await connect();
    const fits = await client.callTool({ name: "create_pr", arguments: { title: "t", body: ASTRAL.repeat(MAX_BODY) } });
    assert.notEqual(fits.isError, true, text(fits));
    assert.equal((api.lastBody as { body: string }).body.length, 2 * MAX_BODY);

    // Fresh call log: the first call already pushed, so assertUntouched() cannot apply.
    api = new FakeGitHubApi();
    const over = await client.callTool({ name: "create_pr", arguments: { title: "t", body: ASTRAL.repeat(MAX_BODY + 1) } });
    assert.equal(over.isError, true);
    assert.match(text(over), /body: Too big/);
    assert.deepEqual(api.calls, []);
  });
});

describe("per-request server construction", () => {
  for (const mode of MODES) {
    it(`many sequential requests on one connection each succeed (${mode})`, async () => {
      const client = await connect(mode);
      for (let i = 0; i < 10; i++) {
        const result = await client.callTool({ name: "get_pr", arguments: { number: 7 } });
        assert.notEqual(result.isError, true, `call ${i}: ${text(result)}`);
      }
      assert.match(text(await client.callTool({ name: "push_branch", arguments: {} })), /Pushed feature/);
    });
  }

  it("sequential connections in every negotiation mode each succeed", async () => {
    for (const mode of [...MODES, ...MODES]) {
      const client = await connect(mode);
      assert.equal((await client.listTools()).tools.length, VERBS.length);
    }
  });

  it("concurrent requests across connections and negotiation modes all succeed", async () => {
    const modes: Mode[] = ["pinned", "pinned", "auto", "auto", "legacy", "legacy"];
    const connected = await Promise.all(modes.map((mode) => connect(mode)));
    const results = await Promise.all(
      connected.flatMap((client) => [
        client.listTools().then((r) => r.tools.length),
        ...Array.from({ length: 4 }, () =>
          client.callTool({ name: "get_pr", arguments: { number: 7 } }).then((r) => {
            assert.notEqual(r.isError, true, text(r));
            return text(r);
          }),
        ),
      ]),
    );
    assert.equal(results.length, modes.length * 5);
    for (const result of results) {
      if (typeof result === "number") assert.equal(result, VERBS.length);
      else assert.match(result, /#7 feature -> main \(open\)/);
    }
  });
});

describe("untrusted arguments", () => {
  const FULLEST = { number: 7, title: "t", body: "b", base: "next", state: "open", draft: false };

  it("a __proto__ key in the arguments is dropped, and pollutes nothing", async () => {
    // Hand-written, since JSON.stringify would not emit an own __proto__ key.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body:
        '{"jsonrpc":"2.0","id":1,"method":"tools/call",' +
        '"params":{"name":"get_pr","arguments":{"number":7,"__proto__":{"x":1}}}}',
    });
    assert.equal(res.status, 200);
    const rpc = (await readRpc(res)) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    assert.notEqual(rpc.result.isError, true, rpc.result.content[0]?.text);
    assert.match(rpc.result.content[0].text, /#7 feature -> main \(open\)/);
    assert.deepEqual(
      api.calls.map((call) => `${call.method} ${call.url}`),
      ["GET https://api.github.com/repos/acme/widgets/pulls/7"],
    );
    assert.equal(git.pushCall, undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined, "Object.prototype is untouched");
  });

  it(`the fullest legal call is exactly ${MAX_TOOL_INPUT_ELEMENTS} elements and passes the cap`, async () => {
    assert.equal(Object.keys(FULLEST).length, MAX_TOOL_INPUT_ELEMENTS);
    const client = await connect();
    const result = await client.callTool({ name: "update_pr", arguments: FULLEST });
    assert.notEqual(result.isError, true, text(result));
  });

  for (const mode of MODES) {
    it(`one element more is refused before git or GitHub is reached (${mode})`, async () => {
      const client = await connect(mode);
      const result = await client.callTool({ name: "update_pr", arguments: { ...FULLEST, extra: 1 } });
      assert.equal(result.isError, true);
      assert.match(text(result), new RegExp(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));
      assertUntouched();
    });
  }

  it("nested elements count toward the cap too", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "create_pr", arguments: { title: ["a", "b", "c", "d", "e", "f"] } });
    assert.equal(result.isError, true);
    assert.match(text(result), /more than the maximum/);
    assertUntouched();
  });

  it("an invented argument within the cap is refused by the strict schema", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_pr", arguments: { number: 7, repo: "evil/elsewhere" } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Input validation error/);
    assertUntouched();
  });

  it("the schema limits hold over the wire", async () => {
    const client = await connect();
    const refused: Array<[string, Record<string, unknown>]> = [
      ["create_pr", { title: "x".repeat(MAX_TITLE + 1) }],
      ["create_pr", { title: "t", body: "x".repeat(MAX_BODY + 1) }],
      ["create_pr", { title: "t", base: "-x" }],
      ["create_pr", { title: "" }],
      ["get_pr", { number: 1.5 }],
      ["get_pr", { number: Number.MAX_SAFE_INTEGER + 2 }],
      ["find_pr", { head: "-x" }],
      ["find_pr", { head: "a b" }],
      ["find_pr", { head: "" }],
      ["find_pr", { head: "x", repo: "evil/elsewhere" }],
      ["find_pr", {}],
      ["update_pr", { number: 7, state: "merged" }],
      ["ci_status", { sha: "abc123" }],
      ["ci_status", { sha: "A".repeat(40) }],
      ["ci_status", { pr: 0 }],
      ["ci_job", { job_id: -1 }],
      ["ci_log", { job_id: 7, limit: 0 }],
      ["ci_log", { job_id: 7, limit: MAX_LOG_LINES + 1 }],
      ["ci_log", { job_id: 7, start: 0 }],
      ["ci_log", { job_id: 7, step: 0 }],
      ["ci_log", {}],
      ["ci_job", { job_id: 7, repo: "evil/elsewhere" }],
      ["ci_status", { ref: "main" }],
    ];
    for (const [name, args] of refused) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)}`);
      assert.match(text(result), /Input validation error/);
    }
    assertUntouched();
  });
});

describe("plain HTTP", () => {
  const POST_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  /**
   * A JSON-RPC error with nothing of the server's internals in the body. Its id
   * is null unless the request was read far enough to recover one.
   */
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

  for (const method of ["GET", "DELETE"] as const) {
    it(`refuses ${method}: there is no session`, async () => {
      await assertJsonRpcError(await fetch(endpoint, { method }), 405, -32000);
    });
  }

  /**
   * Valid JSON of exactly `length` bytes, shaped like a request but with a
   * top-level member JSON-RPC does not allow -- so one that passes the size
   * check is still refused, as an invalid message rather than as too large.
   */
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
    it(`${what} gets a JSON-RPC error, not an HTML page`, async (t) => {
      // The handler's onerror logs each rejection; expected here, so kept quiet.
      t.mock.method(console, "error", () => {});
      await assertJsonRpcError(await fetch(endpoint, { method: "POST", headers: POST_HEADERS, body }), status, code, id);
      assertUntouched();
    });
  }

  it("a declared over-cap body is refused before it is sent", async () => {
    // Only the first byte is ever written. A 413 can only arrive if the Node
    // adapter checks Content-Length up front; without its own cap it would sit
    // buffering toward the 4 MiB SDK default and this would time out.
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
});
