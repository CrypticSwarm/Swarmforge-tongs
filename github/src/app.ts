// No express body parser: the SDK reads the body, so a bad one gets a JSON-RPC error, not an HTML page.

import express, { type Express } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildIdleServer, buildServer, type Context, type Idle } from "./server.js";

/**
 * 12 B per escaped code point x (MAX_BODY + MAX_TITLE + 255 base) ~ 774 KiB, plus ~250 KiB for the envelope,
 * which repeats clientInfo (data: icons too). A tighter cap would 413 calls the tool's validation explains better.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function createApp(context: Context | Idle): Express {
  const onerror = (err: Error) => console.error("mcp request rejected or failed", err);
  const build = "idle" in context ? () => buildIdleServer(context.idle) : () => buildServer(context);
  const handler = createMcpHandler(build, {
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
