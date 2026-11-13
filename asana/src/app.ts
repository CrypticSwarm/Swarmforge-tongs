// No express body parser: the MCP handler reads the body, so a bad one gets a JSON-RPC error, not an HTML page.

import express, { type Express } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer, type Context } from "./server.js";

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
