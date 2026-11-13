import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Asana, Workspace } from "./asana.js";

export type Context = {
  asana: Asana;
  /** Pinned at startup; no verb names another. */
  workspace: Workspace;
};

const INSTRUCTIONS = `Works in one Asana workspace on your behalf.

The Asana token lives only in this tong and is never exposed to the caller. The
workspace is fixed at startup; no verb accepts a workspace.

- current_user names the token's user and the pinned workspace.`;

/** Elements plus members in `arguments`, checked before the schema. Recount on adding a parameter. */
const MAX_TOOL_INPUT_ELEMENTS = 1;

export async function currentUser(context: Context): Promise<string> {
  const user = await context.asana.me();
  return [
    `user: ${user.name} (gid ${user.gid})`,
    `email: ${user.email ?? "not shown to this token"}`,
    `workspace: ${context.workspace.name} (gid ${context.workspace.gid})`,
  ].join("\n");
}

export function buildServer(context: Context): McpServer {
  const server = new McpServer(
    { name: "asana", version: "0.1.0" },
    {
      instructions: INSTRUCTIONS,
      // The tool set is fixed; registerTool would otherwise advertise `listChanged: true`.
      capabilities: { tools: { listChanged: false } },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  );

  function verb<Shape extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema: z.ZodObject<Shape> },
    run: (context: Context, input: z.infer<z.ZodObject<Shape>>) => Promise<string>,
  ): void {
    server.registerTool(name, { title: name, ...config }, async (input) => {
      try {
        return { content: [{ type: "text" as const, text: await run(context, input) }] };
      } catch (err) {
        // The container log is the operator's only copy.
        console.error(`${name} failed:`, err);
        return {
          content: [{ type: "text" as const, text: `${name}: error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    });
  }

  verb(
    "current_user",
    {
      description:
        "Name the Asana user this tong acts as, with their gid and email, and the workspace every verb works in.",
      inputSchema: z.strictObject({}),
    },
    currentUser,
  );

  return server;
}
