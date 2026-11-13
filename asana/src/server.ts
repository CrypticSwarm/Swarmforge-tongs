import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  AsanaError,
  CURSOR,
  GID,
  MAX_NOTES,
  type Asana,
  type Compact,
  type CustomField,
  type Project,
  type ProjectSummary,
  type Task,
  type TaskFields,
  type TaskSummary,
  type Workspace,
  type WorkspaceUser,
} from "./asana.js";

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
- get_project reads a project with its sections and custom fields.
- create_task, update_task, and delete_task create, change, and trash tasks.
- find_projects finds projects by name; list_users lists the workspace's users, or finds
  them by name or email.
- A list ending in a cursor has more; pass it back as 'cursor' for the next page.
  A full search or lookup page says so; narrow it to see more.`;

const DEFAULT_LIMIT = 50;

const gid = z.string().regex(GID, "must be an Asana gid, a string of digits");
const cursor = z
  .string()
  .regex(CURSOR, "must be a cursor from a previous page")
  .optional()
  .describe("The cursor the previous page ended with.");

function limitSchema(items: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(`Max ${items} to return, 1-100 (default ${DEFAULT_LIMIT}).`);
}

const assignee = z.union([z.literal("me"), gid]);
const taskName = z.string().trim().min(1).max(1024);
const notes = z.string().max(MAX_NOTES);
const htmlNotes = z
  .string()
  .max(MAX_NOTES)
  .regex(/^<body>(?:(?!<\/?body\b)[\s\S])*<\/body>$/i, "must be one <body>...</body> element");
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const subtype = z.enum(["default_task", "milestone", "approval"]);
const approvalStatus = z.enum(["pending", "approved", "rejected", "changes_requested"]);

const getTaskInput = z.strictObject({ task_gid: gid.describe("The task's gid.") });

const listTasksInput = z.strictObject({
  project_gid: gid.optional().describe("List this project's tasks."),
  section_gid: gid.optional().describe("List this section's tasks."),
  parent_gid: gid.optional().describe("List this task's subtasks."),
  incomplete_only: z.boolean().optional().describe("Leave out completed tasks."),
  limit: limitSchema("tasks"),
  cursor,
});

const searchTasksInput = z.strictObject({
  text: z.string().min(1).max(200).optional().describe("Words to find in the task's name or description."),
  assignee: assignee.optional().describe("The assignee's gid, or 'me' for the token's user."),
  project_gid: gid.optional().describe("Only tasks in this project, or under one of its tasks."),
  section_gid: gid.optional().describe("Only tasks in this section."),
  tag_gid: gid.optional().describe("Only tasks with this tag."),
  completed: z.boolean().optional().describe("Only completed (true) or incomplete (false) tasks."),
  due_on_after: z.iso.date().optional().describe("Only tasks due after this date, YYYY-MM-DD."),
  due_on_before: z.iso.date().optional().describe("Only tasks due before this date, YYYY-MM-DD."),
  limit: limitSchema("tasks"),
});

const createTaskInput = z.strictObject({
  name: taskName.describe("The task's name."),
  notes: notes.optional().describe("The description as plain text."),
  html_notes: htmlNotes.optional().describe("The description as Asana rich-text HTML, one <body>...</body> element."),
  assignee: assignee.optional().describe("The assignee's gid, or 'me' for the token's user."),
  due_on: isoDate.optional().describe("The due date, YYYY-MM-DD."),
  due_at: isoDateTime.optional().describe("The due date and time, ISO 8601."),
  start_on: isoDate.optional().describe("The start date, YYYY-MM-DD."),
  resource_subtype: subtype.optional().describe("The task's type; default_task if left out."),
  project_gid: gid.optional().describe("Add the task to this project."),
  section_gid: gid.optional().describe("Put it in this section of 'project_gid'."),
  parent_gid: gid.optional().describe("Make it a subtask of this task."),
});

const updateTaskInput = z.strictObject({
  task_gid: gid.describe("The task's gid."),
  name: taskName.optional().describe("The new name."),
  notes: notes.nullable().optional().describe("The description as plain text; null clears it."),
  html_notes: htmlNotes.optional().describe("The description as Asana rich-text HTML, one <body>...</body> element."),
  assignee: assignee.nullable().optional().describe("The assignee's gid, 'me', or null to unassign."),
  due_on: isoDate.nullable().optional().describe("The due date, YYYY-MM-DD; null clears it."),
  due_at: isoDateTime.nullable().optional().describe("The due date and time, ISO 8601; null clears it."),
  start_on: isoDate.nullable().optional().describe("The start date, YYYY-MM-DD; null clears it."),
  resource_subtype: subtype.optional().describe("The task's type."),
  completed: z.boolean().optional().describe("Mark the task complete (true) or incomplete (false)."),
  approval_status: approvalStatus.optional().describe("An approval task's status. Asana sets 'completed' from it."),
});

const deleteTaskInput = z.strictObject({ task_gid: gid.describe("The task's gid.") });

const getProjectInput = z.strictObject({ project_gid: gid.describe("The project's gid.") });

const findProjectsInput = z.strictObject({
  query: z.string().trim().min(1).max(200).describe("The project's name, or the start of a word in it."),
  limit: limitSchema("projects"),
});

const listUsersInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("A user's name or email, or the start of a word in it. Leave out to list every user."),
  limit: limitSchema("users"),
  cursor,
});

/** Elements plus members in `arguments`, checked before the schema. Top-level keys only; count nested ones by hand. */
const MAX_TOOL_INPUT_ELEMENTS = Math.max(
  ...[
    getTaskInput,
    listTasksInput,
    searchTasksInput,
    createTaskInput,
    updateTaskInput,
    deleteTaskInput,
    getProjectInput,
    findProjectsInput,
    listUsersInput,
  ].map((input) => Object.keys(input.shape).length),
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

function notInPinnedWorkspace(context: Context, what: string): Error {
  return new Error(`${what} is not in workspace ${context.workspace.name} (gid ${context.workspace.gid}).`);
}

function requirePinnedWorkspace(context: Context, workspaceGid: string | undefined, what: string): void {
  if (workspaceGid !== context.workspace.gid) throw notInPinnedWorkspace(context, what);
}

function renderList(what: string, rows: string[], more: string | undefined, emptyText = "none"): string {
  const heading = rows.length ? `${what}:` : `${what}: ${more ? "none on this page" : emptyText}`;
  const lines = [heading, ...rows.map((row) => `- ${row}`)];
  if (more) lines.push(more);
  return lines.join("\n");
}

function renderTaskList(what: string, tasks: TaskSummary[], more: string | undefined): string {
  const rows = tasks.map((task) => {
    const details = [task.completed ? "completed" : "incomplete"];
    if (task.assignee) details.push(`assignee ${label(task.assignee)}`);
    const dueDate = due(task);
    if (dueDate) details.push(`due ${dueDate}`);
    return `${label(task)}: ${details.join(", ")}`;
  });
  return renderList(what, rows, more, "no tasks");
}

function requireTasksInPinnedWorkspace(context: Context, tasks: TaskSummary[], what: string): void {
  for (const task of tasks) requirePinnedWorkspace(context, task.workspaceGid, `a task in ${what}`);
}

function renderMemberships(task: Task): string {
  return indented(
    "projects",
    task.memberships.map(({ project, section }) => label(project) + (section ? `, section ${label(section)}` : "")),
  );
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
    renderMemberships(task),
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

type TaskFieldInput = Omit<z.infer<typeof updateTaskInput>, "task_gid">;

function refuseBoth(input: TaskFieldInput, first: keyof TaskFieldInput, second: keyof TaskFieldInput, reason = "") {
  if (input[first] !== undefined && input[second] !== undefined) {
    throw new Error(`pass '${first}' or '${second}', not both${reason}.`);
  }
}

function taskFields(input: TaskFieldInput): TaskFields {
  refuseBoth(input, "notes", "html_notes");
  refuseBoth(input, "due_on", "due_at");
  refuseBoth(input, "approval_status", "completed", ": Asana sets 'completed' from 'approval_status'");
  const fields: TaskFields = {
    name: input.name,
    notes: input.notes === null ? "" : input.notes,
    html_notes: input.html_notes,
    assignee: input.assignee,
    due_on: input.due_on,
    due_at: input.due_at,
    start_on: input.start_on,
    resource_subtype: input.resource_subtype,
    completed: input.completed,
    approval_status: input.approval_status,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

async function requireAssigneeInPinnedWorkspace(context: Context, assignee: string | null | undefined) {
  if (assignee === undefined || assignee === null || assignee === "me") return;
  const workspaceGids = await context.asana.userWorkspaces(assignee);
  if (!workspaceGids.includes(context.workspace.gid)) throw notInPinnedWorkspace(context, `user ${assignee}`);
}

/** A 5xx, a lost answer, or an unreadable 2xx does not show the write failed. */
function rethrowWithLandedHint(err: unknown, howToCheck: string): never {
  if (err instanceof AsanaError && (err.status === undefined || err.status < 300 || err.status >= 500)) {
    throw new Error(`${err.message}\n\nThe write may have gone through; ${howToCheck} shows whether it did.`);
  }
  throw err;
}

export async function createTask(context: Context, input: z.infer<typeof createTaskInput>): Promise<string> {
  const { project_gid: project, section_gid: section, parent_gid: parent } = input;
  const fields = taskFields(input);
  if (project === undefined && parent === undefined) throw new Error("pass 'project_gid', 'parent_gid', or both.");
  if (section !== undefined && project === undefined) throw new Error("pass 'project_gid' with 'section_gid'.");
  if (project !== undefined) {
    requirePinnedWorkspace(context, await context.asana.workspaceOf({ project }), `project ${project}`);
  }
  if (section !== undefined && (await context.asana.projectOfSection(section)) !== project) {
    throw new Error(`section ${section} is not in project ${project}.`);
  }
  if (parent !== undefined) {
    requirePinnedWorkspace(context, await context.asana.taskWorkspace(parent), `task ${parent}`);
  }
  await requireAssigneeInPinnedWorkspace(context, fields.assignee);
  const task = await context.asana
    .createTask(context.workspace.gid, { project, section, parent }, fields)
    .catch((err) => rethrowWithLandedHint(err, "list_tasks"));
  return [
    `created task: ${label(task)}`,
    `url: ${task.permalink ?? "none"}`,
    `parent: ${task.parent ? label(task.parent) : "none"}`,
    renderMemberships(task),
  ].join("\n");
}

const renderDescription = (task: Task) => `description: ${task.notes ? "replaced" : "cleared"}`;
const renderDue = (task: Task) => `due: ${due(task) ?? "none"}`;

const renderChangedField: Record<keyof TaskFields, (task: Task) => string> = {
  name: (task) => `name: ${task.name}`,
  notes: renderDescription,
  html_notes: renderDescription,
  assignee: (task) => `assignee: ${task.assignee ? label(task.assignee) : "none"}`,
  due_on: renderDue,
  due_at: renderDue,
  start_on: (task) => `start: ${task.startAt ?? task.startOn ?? "none"}`,
  resource_subtype: (task) => `type: ${task.subtype ?? "unknown"}`,
  completed: (task) => `completed: ${task.completed ? "yes" : "no"}`,
  approval_status: (task) =>
    `approval status: ${task.approvalStatus ?? "none"}, completed: ${task.completed ? "yes" : "no"}`,
};

export async function updateTask(context: Context, input: z.infer<typeof updateTaskInput>): Promise<string> {
  const { task_gid: taskGid, ...changes } = input;
  const fields = taskFields(changes);
  const changed = Object.keys(fields) as (keyof TaskFields)[];
  if (changed.length === 0) throw new Error("pass at least one field to change.");
  requirePinnedWorkspace(context, await context.asana.taskWorkspace(taskGid), `task ${taskGid}`);
  await requireAssigneeInPinnedWorkspace(context, fields.assignee);
  const task = await context.asana
    .updateTask(taskGid, fields)
    .catch((err) => rethrowWithLandedHint(err, "get_task"));
  const lines = new Set(changed.map((field) => renderChangedField[field](task)));
  return [`updated task: ${label(task)}`, ...lines].join("\n");
}

export async function deleteTask(context: Context, input: z.infer<typeof deleteTaskInput>): Promise<string> {
  const taskGid = input.task_gid;
  requirePinnedWorkspace(context, await context.asana.taskWorkspace(taskGid), `task ${taskGid}`);
  await context.asana.deleteTask(taskGid).catch((err) => rethrowWithLandedHint(err, "get_task"));
  return `deleted task ${taskGid}: it is in the token user's Asana trash, restorable for 30 days.`;
}

function renderCustomField(field: CustomField): string[] {
  const options = field.enumOptions.map((option) => `  ${label(option)}${option.enabled ? "" : ", disabled"}`);
  return [`${label(field)}: ${field.type ?? "unknown type"}`, ...options];
}

function renderProject(project: Project, sections: Compact[], moreSections: boolean): string {
  return [
    `project: ${label(project)}`,
    `url: ${project.permalink ?? "none"}`,
    `archived: ${project.archived ? "yes" : "no"}`,
    `completed: ${project.completed ? "yes" : "no"}`,
    `owner: ${project.owner ? label(project.owner) : "none"}`,
    `team: ${project.team ? label(project.team) : "none"}`,
    ...(project.startOn ? [`start: ${project.startOn}`] : []),
    `due: ${project.dueOn ?? "none"}`,
    indented("sections", [...sections.map(label), ...(moreSections ? ["more sections not shown"] : [])]),
    indented("custom fields", project.customFields.flatMap(renderCustomField)),
    indented("notes", project.notes ? project.notes.split("\n") : []),
  ].join("\n");
}

export async function getProject(context: Context, input: z.infer<typeof getProjectInput>): Promise<string> {
  const project = await context.asana.project(input.project_gid);
  requirePinnedWorkspace(context, project.workspaceGid, `project ${input.project_gid}`);
  const sections = await context.asana.sectionList(input.project_gid);
  return renderProject(project, sections.items, sections.cursor !== undefined);
}

function renderProjectSummary(project: ProjectSummary): string {
  const details = [label(project), ...(project.team ? [`team ${label(project.team)}`] : [])];
  if (project.archived) details.push("archived");
  return details.join(", ");
}

export async function findProjects(context: Context, input: z.infer<typeof findProjectsInput>): Promise<string> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const projects = await context.asana.findProjects(context.workspace.gid, input.query, limit);
  for (const project of projects) requirePinnedWorkspace(context, project.workspaceGid, "a matching project");
  const more = projects.length >= limit ? "more may match: narrow the query" : undefined;
  return renderList("matching projects, most recently used first", projects.map(renderProjectSummary), more);
}

function renderUser(user: WorkspaceUser): string {
  return user.email ? `${label(user)}, ${user.email}` : label(user);
}

function requireUsersInPinnedWorkspace(context: Context, users: WorkspaceUser[]): void {
  if (users.some((user) => !user.workspaceGids.includes(context.workspace.gid))) {
    throw notInPinnedWorkspace(context, "a returned user");
  }
}

export async function listUsers(context: Context, input: z.infer<typeof listUsersInput>): Promise<string> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const workspace = context.workspace;
  if (input.query === undefined) {
    const page = await context.asana.userList(workspace.gid, { limit, cursor: input.cursor });
    requireUsersInPinnedWorkspace(context, page.items);
    const more = page.cursor && `cursor: ${page.cursor}`;
    return renderList(`users in workspace ${workspace.name}`, page.items.map(renderUser), more);
  }
  if (input.cursor !== undefined) throw new Error("pass 'query' or 'cursor', not both: matches come in one page.");
  const users = await context.asana.findUsers(workspace.gid, input.query, limit);
  requireUsersInPinnedWorkspace(context, users);
  const more = users.length >= limit ? "more may match: narrow the query" : undefined;
  return renderList("matching users, most worked with first", users.map(renderUser), more);
}

/** Module-wide, so writes from every request share one queue. */
let writeQueue: Promise<unknown> = Promise.resolve();

function serially<Input>(run: (context: Context, input: Input) => Promise<string>) {
  return (context: Context, input: Input): Promise<string> => {
    const result = writeQueue.then(() => run(context, input));
    writeQueue = result.catch(() => {});
    return result;
  };
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

  verb(
    "create_task",
    {
      description:
        "Create a task in a project (optionally one of its sections), under 'parent_gid', or both. " +
        "At most one of 'notes'/'html_notes' and of 'due_on'/'due_at'.",
      inputSchema: createTaskInput,
    },
    serially(createTask),
  );

  verb(
    "update_task",
    {
      description:
        "Change only the given fields of a task; null clears where allowed. At most one of " +
        "'notes'/'html_notes' and of 'due_on'/'due_at'; send 'approval_status' without 'completed'. " +
        "Returns each changed field's new value.",
      inputSchema: updateTaskInput,
    },
    serially(updateTask),
  );

  verb(
    "delete_task",
    {
      description: "Move a task to the token user's Asana trash, restorable for 30 days.",
      inputSchema: deleteTaskInput,
    },
    serially(deleteTask),
  );

  verb(
    "get_project",
    {
      description:
        "Read one project: owner, team, dates, archived and completed state, sections, custom fields with " +
        "their type and enum options, and its description.",
      inputSchema: getProjectInput,
    },
    getProject,
  );

  verb(
    "find_projects",
    {
      description: "Find the workspace's projects by name, most recently used first.",
      inputSchema: findProjectsInput,
    },
    findProjects,
  );

  verb(
    "list_users",
    {
      description:
        "List the workspace's users, or find them by name or email. " +
        "A 'query' returns one page, most worked with first.",
      inputSchema: listUsersInput,
    },
    listUsers,
  );

  return server;
}
