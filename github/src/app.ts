// The tong's HTTP surface, split from the process entrypoint so tests can start it
// without a token or a repository.

import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

export function buildServer(): McpServer {
  return new McpServer({ name: "github", version: "0.1.0" });
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Stateless Streamable HTTP: a fresh server and transport per request.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildServer();
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
