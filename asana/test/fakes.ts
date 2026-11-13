import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Asana, AsanaError, type User, type Workspace } from "../src/asana.js";

export const TOKEN = "2/1200000000000001/1200000000000002:thisIsTheSecretTokenValue";
export const USER: User = { gid: "1200000000000001", name: "Ada Lovelace", email: "ada@example.com" };
export const WORKSPACE: Workspace = { gid: "1100000000000001", name: "Acme" };

export type FakeRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
};

export type FakeReply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** Keyed `"<METHOD> <path>"`, path relative to the API base and without its query. */
export type Routes = Record<string, FakeReply | ((request: FakeRequest) => FakeReply)>;

export class FakeAsana {
  readonly requests: FakeRequest[] = [];
  routes: Routes = {};
  private constructor(
    private readonly server: Server,
    readonly basePath: string,
  ) {}

  static async start(routes: Routes = {}): Promise<FakeAsana> {
    let fake: FakeAsana | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const url = new URL(req.url ?? "/", "http://fake");
      const request: FakeRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: parseJson(Buffer.concat(chunks).toString("utf8")),
      };
      fake!.requests.push(request);
      const route = fake!.routes[`${request.method} ${request.path}`];
      // 599, so a mistyped path cannot pass for one of Asana's own errors.
      const unrouted = errorReply(599, `fake: no route for ${request.method} ${request.path}`);
      let reply: FakeReply;
      try {
        reply = typeof route === "function" ? route(request) : (route ?? unrouted);
      } catch (err) {
        reply = errorReply(599, `fake: route threw: ${(err as Error).message}`);
      }
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)));
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    fake = new FakeAsana(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    fake.routes = routes;
    return fake;
  }

  client(token = TOKEN): Asana {
    return new Asana(token, this.basePath);
  }

  requestsTo(method: string, path: string): FakeRequest[] {
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }
}

function parseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return raw;
  }
}

export function errorReply(status: number, message: string, headers?: Record<string, string>): FakeReply {
  return { status, headers, json: { errors: [{ message, help: "https://developers.asana.com/docs/errors" }] } };
}

export function dataReply(data: unknown): FakeReply {
  return { json: { data } };
}

export function pageReply(items: unknown[], offset?: string): FakeReply {
  const nextPage = offset === undefined ? null : { offset, path: `/next?offset=${offset}`, uri: "https://example/next" };
  return { json: { data: items, next_page: nextPage } };
}

export function typeaheadRoute(resourceType: string, items: unknown[]): (request: FakeRequest) => FakeReply {
  return (request) => {
    assert.equal(request.query.resource_type, resourceType);
    return pageReply(items);
  };
}

export function meRoute(user: User = USER): Routes {
  return { "GET /users/me": dataReply({ resource_type: "user", ...user }) };
}

export function workspaceRoute(workspace: Workspace = WORKSPACE): Routes {
  return { [`GET /workspaces/${workspace.gid}`]: dataReply({ resource_type: "workspace", ...workspace }) };
}

export async function asanaError(promise: Promise<unknown>): Promise<AsanaError> {
  const err = await promise.then(
    () => assert.fail("expected a failure"),
    (err: unknown) => err,
  );
  assert.ok(err instanceof AsanaError, inspect(err));
  return err;
}

export async function unreachableClient(): Promise<Asana> {
  const closed = await FakeAsana.start();
  await closed.close();
  return closed.client();
}
