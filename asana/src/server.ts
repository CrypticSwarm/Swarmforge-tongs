import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { CURSOR, GID, type Asana, type Compact, type Task, type TaskSummary, type Workspace } from "./asana.js";

export type Context = {
  asana: Asana;
  /** Pinned at startup; no verb names another. */
  workspace: Workspace;
};

const INSTRUCTIONS = `Works in one Asana workspace on your behalf.

The Asana token lives only in this tong and is never exposed to the caller. The
workspace is fixed at startup; no verb accepts a workspace.

- current_user names the token's user and the pinned workspace.
- get_task reads one task in full; list_tasks lists a project's or a section's tasks,
  or a task's subtasks; search_tasks searches the workspace and needs Asana Premium.
- A list ending in a cursor has more; pass it back as 'cursor' for the next page.
  A full search page says so; narrow the search to see more.`;

const DEFAULT_LIMIT = 50;

const gid = z.string().regex(GID, "must be an Asana gid, a string of digits");
const limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe(`Max tasks to return, 1-100 (default ${DEFAULT_LIMIT}).`);

const getTaskInput = z.strictObject({ task_gid: gid.describe("The task's gid.") });

const listTasksInput = z.strictObject({
  project_gid: gid.optional().describe("List this project's tasks."),
  section_gid: gid.optional().describe("List this section's tasks."),
  parent_gid: gid.optional().describe("List this task's subtasks."),
  incomplete_only: z.boolean().optional().describe("Leave out completed tasks."),
  limit,
  cursor: z
    .string()
    .regex(CURSOR, "must be a cursor from a previous page")
    .optional()
    .describe("The cursor the previous page ended with."),
});

const searchTasksInput = z.strictObject({
  text: z.string().min(1).max(200).optional().describe("Words to find in the task's name or description."),
  assignee: z.union([z.literal("me"), gid]).optional().describe("The assignee's gid, or 'me' for the token's user."),
  project_gid: gid.optional().describe("Only tasks in this project, or under one of its tasks."),
  section_gid: gid.optional().describe("Only tasks in this section."),
  tag_gid: gid.optional().describe("Only tasks with this tag."),
  completed: z.boolean().optional().describe("Only completed (true) or incomplete (false) tasks."),
  due_on_after: z.iso.date().optional().describe("Only tasks due after this date, YYYY-MM-DD."),
  due_on_before: z.iso.date().optional().describe("Only tasks due before this date, YYYY-MM-DD."),
  limit,
});

/** Elements plus members in `arguments`, checked before the schema. Top-level keys only; count nested ones by hand. */
const MAX_TOOL_INPUT_ELEMENTS = Math.max(
  ...[getTaskInput, listTasksInput, searchTasksInput].map((input) => Object.keys(input.shape).length),
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

function renderTaskList(what: string, tasks: TaskSummary[], more: string | undefined): string {
  const rows = tasks.map((task) => {
    const details = [task.completed ? "completed" : "incomplete"];
    if (task.assignee) details.push(`assignee ${label(task.assignee)}`);
    const dueDate = due(task);
    if (dueDate) details.push(`due ${dueDate}`);
    return `- ${label(task)}: ${details.join(", ")}`;
  });
  const lines = [rows.length ? `${what}:` : `${what}: ${more ? "none on this page" : "no tasks"}`, ...rows];
  if (more) lines.push(more);
  return lines.join("\n");
}

function requireTasksInPinnedWorkspace(context: Context, tasks: TaskSummary[], what: string): void {
  for (const task of tasks) requirePinnedWorkspace(context, task.workspaceGid, `a task in ${what}`);
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

export async function listTasks(context: Context, input: z.infer<typeof listTasksInput>): Promise<string> {
  const scopes = [
    ...(input.project_gid ? [{ project: input.project_gid, what: `project ${input.project_gid}` }] : []),
    ...(input.section_gid ? [{ section: input.section_gid, what: `section ${input.section_gid}` }] : []),
    ...(input.parent_gid ? [{ parent: input.parent_gid, what: `task ${input.parent_gid}` }] : []),
  ];
  if (scopes.length !== 1) throw new Error("pass exactly one of 'project_gid', 'section_gid', or 'parent_gid'.");
  const [{ what, ...scope }] = scopes;
  requirePinnedWorkspace(context, await context.asana.workspaceOf(scope), what);
  const page = await context.asana.taskList(scope, {
    incompleteOnly: input.incomplete_only ?? false,
    limit: input.limit ?? DEFAULT_LIMIT,
    cursor: input.cursor,
  });
  requireTasksInPinnedWorkspace(context, page.items, what);
  // The subtasks endpoint cannot leave out completed tasks itself.
  const tasks = input.incomplete_only ? page.items.filter((task) => !task.completed) : page.items;
  const heading = "parent" in scope ? `subtasks of ${what}` : `tasks in ${what}`;
  return renderTaskList(heading, tasks, page.cursor && `cursor: ${page.cursor}`);
}

export async function searchTasks(context: Context, input: z.infer<typeof searchTasksInput>): Promise<string> {
  if (input.project_gid && input.section_gid) {
    throw new Error("pass 'project_gid' or 'section_gid', not both: Asana would return the tasks of either.");
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  const tasks = await context.asana.searchTasks(context.workspace.gid, {
    text: input.text,
    assignee: input.assignee,
    project: input.project_gid,
    section: input.section_gid,
    tag: input.tag_gid,
    completed: input.completed,
    dueOnAfter: input.due_on_after,
    dueOnBefore: input.due_on_before,
    limit,
  });
  requireTasksInPinnedWorkspace(context, tasks, "the search");
  const more = tasks.length === limit ? "more may match: narrow the search" : undefined;
  return renderTaskList("matching tasks, newest first", tasks, more);
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

  verb(
    "list_tasks",
    {
      description:
        "List the tasks in a project or a section, or a task's subtasks, in their Asana order. " +
        "Pass exactly one of 'project_gid', 'section_gid', or 'parent_gid'.",
      inputSchema: listTasksInput,
    },
    listTasks,
  );

  verb(
    "search_tasks",
    {
      description:
        "Search the workspace's tasks, newest first, by the filters given; all must match. " +
        "Pass at most one of 'project_gid' and 'section_gid'. Needs Asana Premium. " +
        "Results lag edits by up to a minute.",
      inputSchema: searchTasksInput,
    },
    searchTasks,
  );

  return server;
}
