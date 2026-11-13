import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { GID, type Asana, type Compact, type Task, type TaskSummary, type Workspace } from "./asana.js";

export type Context = {
  asana: Asana;
  /** Pinned at startup; no verb names another. */
  workspace: Workspace;
};

const INSTRUCTIONS = `Works in one Asana workspace on your behalf.

The Asana token lives only in this tong and is never exposed to the caller. The
workspace is fixed at startup; no verb accepts a workspace.

- current_user names the token's user and the pinned workspace.
- get_task reads one task in full.`;

const gid = z.string().regex(GID, "must be an Asana gid, a string of digits");
const getTaskInput = z.strictObject({ task_gid: gid.describe("The task's gid.") });

/** Elements plus members in `arguments`, checked before the schema. Top-level keys only; count nested ones by hand. */
const MAX_TOOL_INPUT_ELEMENTS = Math.max(
  ...[getTaskInput].map((input) => Object.keys(input.shape).length),
);

export async function currentUser(context: Context): Promise<string> {
  const user = await context.asana.me();
  return [
    `user: ${user.name} (gid ${user.gid})`,
    `email: ${user.email ?? "not shown to this token"}`,
    `workspace: ${context.workspace.name} (gid ${context.workspace.gid})`,
  ].join("\n");
}

function label(item: Compact): string {
  return `${item.name} (gid ${item.gid})`;
}

function indented(title: string, lines: string[]): string {
  return lines.length ? `${title}:\n${lines.map((line) => `  ${line}`).join("\n")}` : `${title}: none`;
}

function due(task: TaskSummary): string | undefined {
  return task.dueAt ?? task.dueOn;
}

function requirePinnedWorkspace(context: Context, workspaceGid: string | undefined, what: string): void {
  if (workspaceGid !== context.workspace.gid) {
    throw new Error(`${what} is not in workspace ${context.workspace.name} (gid ${context.workspace.gid}).`);
  }
}

function renderTask(task: Task): string {
  const subtype = task.subtype === "approval" ? `approval, ${task.approvalStatus ?? "no status"}` : task.subtype;
  const start = task.startAt ?? task.startOn;
  return [
    `task: ${label(task)}`,
    `url: ${task.permalink ?? "none"}`,
    `type: ${subtype ?? "unknown"}`,
    `completed: ${task.completed ? `yes${task.completedAt ? `, at ${task.completedAt}` : ""}` : "no"}`,
    `assignee: ${task.assignee ? label(task.assignee) : "none"}`,
    ...(start ? [`start: ${start}`] : []),
    `due: ${due(task) ?? "none"}`,
    `parent: ${task.parent ? label(task.parent) : "none"}`,
    `subtasks: ${task.subtaskCount ?? "unknown"}`,
    indented(
      "projects",
      task.memberships.map(({ project, section }) => label(project) + (section ? `, section ${label(section)}` : "")),
    ),
    indented(
      "custom fields",
      task.customFields.map(({ field, value }) => `${label(field)}: ${value ?? "not set"}`),
    ),
    indented("blocked by", task.dependencies.map(label)),
    indented("blocking", task.dependents.map(label)),
    indented("notes", task.notes ? task.notes.split("\n") : []),
    indented("html_notes", task.htmlNotes ? task.htmlNotes.split("\n") : []),
  ].join("\n");
}

export async function getTask(context: Context, input: z.infer<typeof getTaskInput>): Promise<string> {
  const task = await context.asana.task(input.task_gid);
  requirePinnedWorkspace(context, task.workspaceGid, `task ${task.gid}`);
  return renderTask(task);
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

  verb(
    "get_task",
    {
      description:
        "Read one task in full: type and approval status, completion, assignee, dates, parent, subtask count, " +
        "projects and sections, custom field values, what blocks it and what it blocks, and its description " +
        "as plain text (notes) and as Asana rich-text HTML (html_notes).",
      inputSchema: getTaskInput,
    },
    getTask,
  );

  return server;
}
