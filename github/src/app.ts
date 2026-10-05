// The tong's HTTP surface, split from the process entrypoint so tests can start it
// against a stubbed repository and token.
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
 * Above the largest schema-legal request, with room for the client's envelope.
 *
 * zod 4's `.max()` counts Unicode code points, and the most a code point can
 * cost on the wire is twelve bytes: an astral character written as an escaped
 * surrogate pair, `\ud83d\ude00`, which Python's json.dumps sends by default.
 * So the fullest `update_pr` carries at most 12 x (65536 body + 256 title + 255
 * base) = 792,564 bytes of string content; with keys, number, state, draft, and
 * JSON-RPC framing, about 774 KiB. That leaves about 250 KiB of the 1 MiB cap
 * for the 2026-07-28 envelope, which repeats the client's full `clientInfo` --
 * inline `data:` icons included -- on every request. A tighter cap would 413
 * legitimate calls outside the tool's own validation, which reports a too-long
 * field far more usefully.
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

  // The launcher's TCP readiness probe.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
