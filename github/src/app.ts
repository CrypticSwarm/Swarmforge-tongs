// The tong's HTTP surface, split from the process entrypoint so tests can start it
// against a stubbed repository and token.

import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, type Context } from "./server.js";

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

export function createApp(context: Context): Express {
  const app = express();
  // Above the worst case for a schema-legal request: MAX_BODY is 64K *characters*,
  // which JSON-escaped multibyte text can inflate past express's 100kb default —
  // that would 413 outside JSON-RPC before the MCP layer ever saw the call.
  app.use(express.json({ limit: "1mb" }));

  // Stateless Streamable HTTP: a fresh server and transport per request.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp POST failed", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // The launcher's TCP readiness probe.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
