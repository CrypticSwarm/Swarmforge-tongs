// The tong's HTTP surface, split from the process entrypoint so tests can start it
// against a stubbed repository and key. Serves a stateless MCP endpoint at /mcp
// plus a /healthz liveness endpoint for the launcher's TCP readiness probe.
//
// /mcp is the SDK's `createMcpHandler`, which serves the 2026-07-28 protocol
// revision and falls back to stateless 2025-era serving for clients that still
// open with `initialize`. Either way every request gets a fresh server from the
// factory: an MCP server instance connects to one transport only, and a
// stateless transport serves one request. GET and DELETE (2025 session
// operations) are answered 405 by the handler itself -- there is no session.
//
// The body is read by the SDK, not by an express body parser, so a malformed,
// non-object, empty, or oversized body gets a JSON-RPC error rather than an
// express HTML error page.

import express, { type Express } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer, type Context } from "./server.js";

/**
 * Sized for the client's envelope, not for our verbs: on 2026-07-28 every
 * request carries the client's full `clientInfo`, whose icons may be inline
 * `data:` URIs, so a legitimate request can run to tens of kilobytes. Argument
 * size needs no allowance here; `maxToolInputElements` bounds that walk.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function createApp(context: Context): Express {
  const onerror = (err: Error) => console.error("mcp request rejected or failed", err);
  const handler = createMcpHandler(() => buildServer(context), {
    onerror,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  // The adapter buffers the body first, so it needs the same bound.
  const mcp = toNodeHandler(handler, { onerror, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });

  const app = express();

  app.all("/mcp", (req, res) => mcp(req, res));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
