import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  AsanaError,
  CURSOR,
  GID,
  MAX_NOTES,
  type Asana,
  type CommentBody,
  type Compact,
  type CustomField,
  type Portfolio,
  type PortfolioItem,
  type PortfolioSummary,
  type Project,
  type ProjectSummary,
  type Story,
  type Task,
  type CustomFieldValue,
  type TaskFields,
  type TaskSummary,
  type Workspace,
  type WorkspaceUser,
} from "./asana.js";
import {
  MAX_CUSTOM_FIELD_ELEMENTS,
  customFieldsInput,
  resolveCustomFields,
  type CustomFieldsInput,
} from "./custom-fields.js";

export type Context = {
  asana: Asana;
  /** Pinned at startup; no verb names another. */
  workspace: Workspace;
};

const INSTRUCTIONS = `Works in one Asana workspace on your behalf.

The Asana token lives only in this tong and is never exposed to the caller. The
workspace is fixed at startup; no verb accepts a workspace.

A list ending in a cursor has more; pass it back as 'cursor' for the next page.
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
const MAX_BLOCKERS = 20;
const blockerGids = z.array(gid).min(1).max(MAX_BLOCKERS);

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
  custom_fields: customFieldsInput.optional(),
  blocked_by: blockerGids.optional().describe("Tasks that block this one, added in a separate call after the create."),
});

const moveToInput = z.strictObject({
  project_gid: gid,
  section_gid: gid.optional().describe("A section of 'project_gid'."),
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
  approval_status: approvalStatus
    .optional()
    .describe("An approval task's status. Send it without 'completed', which Asana sets from it."),
  custom_fields: customFieldsInput.optional(),
  move_to: moveToInput
    .optional()
    .describe("Add the task to this project, or move it to 'section_gid' in a project it is already in."),
  remove_from_project: gid.optional().describe("Take the task out of this project."),
  parent_gid: gid.nullable().optional().describe("Make it a subtask of this task; null makes it top-level."),
  remove_blocked_by: blockerGids.optional().describe("Tasks that no longer block this one."),
  add_blocked_by: blockerGids.optional().describe("Tasks that now block this one."),
});

const deleteTaskInput = z.strictObject({ task_gid: gid.describe("The task's gid.") });

const listCommentsInput = z.strictObject({
  task_gid: gid.describe("The task's gid."),
  include_system: z
    .boolean()
    .optional()
    .describe(
      "Also list system activity like assignments and moves, each with its type. Use the same value with a cursor.",
    ),
  include_html: z.boolean().optional().describe("Add each item's Asana rich-text HTML (html_text)."),
  limit: limitSchema("comments"),
  cursor,
});

const addCommentInput = z.strictObject({
  task_gid: gid.describe("The task's gid."),
  text: z.string().max(MAX_NOTES).regex(/\S/, "must not be blank").optional().describe("The comment as plain text."),
  html_text: htmlNotes.optional().describe("The comment as Asana rich-text HTML, one <body>...</body> element."),
});

const getProjectInput = z.strictObject({ project_gid: gid.describe("The project's gid.") });

const findProjectsInput = z.strictObject({
  query: z.string().trim().min(1).max(200).describe("The project's name, or the start of a word in it."),
  limit: limitSchema("projects"),
});

const updateProjectInput = z.strictObject({
  project_gid: gid.describe("The project's gid."),
  custom_fields: customFieldsInput,
});

const listPortfoliosInput = z.strictObject({
  owner: z
    .union([z.literal("me"), gid])
    .optional()
    .describe("The owner's gid, or 'me' (default). Only a service account's token can name another user."),
  limit: limitSchema("portfolios"),
  cursor,
});

const getPortfolioInput = z.strictObject({
  portfolio_gid: gid.describe("The portfolio's gid."),
  limit: limitSchema("items"),
  cursor,
});

const portfolioItemInput = z.strictObject({
  portfolio_gid: gid.describe("The portfolio's gid."),
  project_gid: gid.describe("The project's gid."),
});

const listUsersInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("A user's name or email, or the start of a word in it."),
  limit: limitSchema("users"),
  cursor,
});

const keyCount = (input: z.ZodObject) => Object.keys(input.shape).length;

/** Elements plus members in `arguments`, checked before the schema. */
const MAX_TOOL_INPUT_ELEMENTS = Math.max(
  ...[getTaskInput, listTasksInput, searchTasksInput, deleteTaskInput].map(keyCount),
  ...[listCommentsInput, addCommentInput, getProjectInput, findProjectsInput, listUsersInput].map(keyCount),
  ...[listPortfoliosInput, getPortfolioInput, portfolioItemInput].map(keyCount),
  keyCount(updateProjectInput) + MAX_CUSTOM_FIELD_ELEMENTS,
  keyCount(createTaskInput) + MAX_BLOCKERS + MAX_CUSTOM_FIELD_ELEMENTS,
  keyCount(updateTaskInput) + keyCount(moveToInput) + 2 * MAX_BLOCKERS + MAX_CUSTOM_FIELD_ELEMENTS,
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

async function requireTaskInPinnedWorkspace(context: Context, taskGid: string): Promise<void> {
  requirePinnedWorkspace(context, await context.asana.taskWorkspace(taskGid), `task ${taskGid}`);
}

async function requireProjectInPinnedWorkspace(context: Context, projectGid: string): Promise<void> {
  requirePinnedWorkspace(context, await context.asana.workspaceOf({ project: projectGid }), `project ${projectGid}`);
}

async function requireSectionInProject(context: Context, sectionGid: string, projectGid: string): Promise<void> {
  if ((await context.asana.projectOfSection(sectionGid)) !== projectGid) {
    throw new Error(`section ${sectionGid} is not in project ${projectGid}.`);
  }
}

function requireTasksInPinnedWorkspace(context: Context, tasks: TaskSummary[], what: string): void {
  for (const task of tasks) requirePinnedWorkspace(context, task.workspaceGid, `a task in ${what}`);
}

function renderCustomFieldValue({ field, type, value }: CustomFieldValue): string {
  const values = typeof value === "object" ? [value].flat().map(label) : value === undefined ? [] : [String(value)];
  return `${label(field)}, ${type ?? "unknown type"}: ${values.join(", ") || "not set"}`;
}

function renderCustomFieldChanges(values: CustomFieldValue[], fieldGids: string[]): string {
  return fieldGids
    .map((fieldGid) => {
      const value = values.find((each) => each.field.gid === fieldGid);
      return `custom field ${value ? renderCustomFieldValue(value) : `${fieldGid}: not in Asana's answer`}`;
    })
    .join("\n");
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
    indented("custom fields", task.customFields.map(renderCustomFieldValue)),
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

async function pinnedPersonGid(context: Context, person: string): Promise<string> {
  if (person === "me") return (await context.asana.me()).gid;
  await requireAssigneeInPinnedWorkspace(context, person);
  return person;
}

function resolvePinned(context: Context, input: CustomFieldsInput, available: CustomField[], where: string) {
  return resolveCustomFields(input, available, where, (person) => pinnedPersonGid(context, person));
}

/** A 5xx, a lost answer, or an unreadable 2xx does not show the write failed. */
function rethrowWithLandedHint(err: unknown, howToCheck: string): never {
  if (err instanceof AsanaError && (err.status === undefined || err.status < 300 || err.status >= 500)) {
    throw new Error(`${err.message}\n\nThe write may have gone through; ${howToCheck} shows whether it did.`);
  }
  throw err;
}

type WriteStep = { inputKey: string; run: () => Promise<string[]> };

function withProgress(err: unknown, done: string[], unsent: string[]): unknown {
  const progress = [indented("already changed", done), `not sent: ${unsent.join(", ") || "none"}`];
  const message = [(err as Error).message, "", ...progress].join("\n");
  return err instanceof AsanaError ? new AsanaError(message, err.status) : new Error(message);
}

async function writeInOrder(steps: WriteStep[], alreadyChanged: string[] = []): Promise<string[]> {
  const done: string[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      done.push(...(await step.run()));
    } catch (err) {
      const changed = [...alreadyChanged, ...done];
      const unsent = steps.slice(index + 1).map((each) => each.inputKey);
      rethrowWithLandedHint(changed.length || unsent.length ? withProgress(err, changed, unsent) : err, "get_task");
    }
  }
  return done;
}

function writeStep<Result>(inputKey: string, write: () => Promise<Result>, render: (result: Result) => string) {
  return { inputKey, run: async () => [render(await write())] };
}

async function requireEachTaskInPinnedWorkspace(context: Context, taskGids: string[]): Promise<void> {
  for (const taskGid of taskGids) await requireTaskInPinnedWorkspace(context, taskGid);
}

const dedupe = (gids: string[] | undefined) => (gids === undefined ? undefined : [...new Set(gids)]);

export async function createTask(context: Context, input: z.infer<typeof createTaskInput>): Promise<string> {
  const { project_gid: project, section_gid: section, parent_gid: parent } = input;
  const blockedBy = dedupe(input.blocked_by);
  const fields = taskFields(input);
  if (project === undefined && parent === undefined) throw new Error("pass 'project_gid', 'parent_gid', or both.");
  if (section !== undefined && project === undefined) throw new Error("pass 'project_gid' with 'section_gid'.");
  if (input.custom_fields && project === undefined) throw new Error("pass 'project_gid' with 'custom_fields'.");
  let available: CustomField[] = [];
  if (project !== undefined) {
    const target = input.custom_fields
      ? await context.asana.projectCustomFields(project)
      : { workspaceGid: await context.asana.workspaceOf({ project }), customFields: [] };
    requirePinnedWorkspace(context, target.workspaceGid, `project ${project}`);
    available = target.customFields;
    if (section !== undefined) await requireSectionInProject(context, section, project);
  }
  if (parent !== undefined) await requireTaskInPinnedWorkspace(context, parent);
  await requireEachTaskInPinnedWorkspace(context, blockedBy ?? []);
  await requireAssigneeInPinnedWorkspace(context, fields.assignee);
  if (input.custom_fields) {
    fields.custom_fields = await resolvePinned(context, input.custom_fields, available, `project ${project}`);
  }
  const task = await context.asana
    .createTask(context.workspace.gid, { project, section, parent }, fields)
    .catch((err) => rethrowWithLandedHint(blockedBy ? withProgress(err, [], ["blocked_by"]) : err, "list_tasks"));
  const created = `created task: ${label(task)}`;
  let blockerLines: string[] = [];
  if (blockedBy) {
    const addBlockers = () => context.asana.addBlockers(task.gid, blockedBy);
    const step = writeStep("blocked_by", addBlockers, () => `blockers added: ${blockedBy.join(", ")}`);
    blockerLines = await writeInOrder([step], [created]);
  }
  return [
    created,
    `url: ${task.permalink ?? "none"}`,
    `parent: ${task.parent ? label(task.parent) : "none"}`,
    renderMemberships(task),
    ...blockerLines,
  ].join("\n");
}

const renderDescription = (task: Task) => `description: ${task.notes ? "replaced" : "cleared"}`;
const renderDue = (task: Task) => `due: ${due(task) ?? "none"}`;

const renderChangedField: Record<keyof TaskFields, (task: Task, fields: TaskFields) => string> = {
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
  custom_fields: (task, fields) => renderCustomFieldChanges(task.customFields, Object.keys(fields.custom_fields ?? {})),
};

export async function updateTask(context: Context, input: z.infer<typeof updateTaskInput>): Promise<string> {
  const { task_gid: taskGid, move_to: moveTo, remove_from_project: removeFrom, parent_gid: parent, ...changes } = input;
  const addBlockedBy = dedupe(input.add_blocked_by);
  const removeBlockedBy = dedupe(input.remove_blocked_by);
  const fields = taskFields(changes);
  const otherChanges = [moveTo, removeFrom, parent, addBlockedBy, removeBlockedBy];
  if (!Object.keys(fields).length && !changes.custom_fields && otherChanges.every((each) => each === undefined)) {
    throw new Error("pass at least one change.");
  }
  if (moveTo && moveTo.project_gid === removeFrom) {
    throw new Error("pass 'move_to' or 'remove_from_project' for a project, not both.");
  }
  if (parent === taskGid) throw new Error("a task cannot be its own parent.");
  const namedBlockers = [...(addBlockedBy ?? []), ...(removeBlockedBy ?? [])];
  if (namedBlockers.includes(taskGid)) throw new Error("a task cannot block itself.");
  const inBoth = addBlockedBy?.find((blocker) => removeBlockedBy?.includes(blocker));
  if (inBoth) throw new Error(`pass task ${inBoth} in 'add_blocked_by' or 'remove_blocked_by', not both.`);
  const target = await context.asana.taskTarget(taskGid, changes.custom_fields !== undefined);
  requirePinnedWorkspace(context, target.workspaceGid, `task ${taskGid}`);
  const alreadyInProject = moveTo !== undefined && target.projectGids.includes(moveTo.project_gid);
  if (moveTo) {
    if (alreadyInProject && !moveTo.section_gid) {
      throw new Error(`task ${taskGid} is already in project ${moveTo.project_gid}; pass a 'section_gid' to move it.`);
    }
    await requireProjectInPinnedWorkspace(context, moveTo.project_gid);
    if (moveTo.section_gid) await requireSectionInProject(context, moveTo.section_gid, moveTo.project_gid);
  }
  if (removeFrom) {
    if (!target.projectGids.includes(removeFrom)) throw new Error(`task ${taskGid} is not in project ${removeFrom}.`);
    await requireProjectInPinnedWorkspace(context, removeFrom);
  }
  if (parent) await requireTaskInPinnedWorkspace(context, parent);
  const notBlocking = removeBlockedBy?.find((blocker) => !target.blockerGids.includes(blocker));
  if (notBlocking) throw new Error(`task ${notBlocking} does not block task ${taskGid}.`);
  await requireEachTaskInPinnedWorkspace(context, namedBlockers);
  await requireAssigneeInPinnedWorkspace(context, fields.assignee);
  if (changes.custom_fields) {
    fields.custom_fields = await resolvePinned(context, changes.custom_fields, target.customFields, `task ${taskGid}`);
  }
  let heading = `updated task: ${label({ gid: taskGid, name: target.name })}`;
  const steps: WriteStep[] = [];
  if (Object.keys(fields).length) {
    steps.push({
      inputKey: "fields",
      run: async () => {
        const task = await context.asana.updateTask(taskGid, fields);
        heading = `updated task: ${label(task)}`;
        const changed = Object.keys(fields) as (keyof TaskFields)[];
        return [...new Set(changed.flatMap((field) => renderChangedField[field](task, fields).split("\n")))];
      },
    });
  }
  if (moveTo) {
    const { project_gid: project, section_gid: section } = moveTo;
    const placed = alreadyInProject
      ? `moved to section ${section} of project ${project}`
      : `added to project ${project}${section ? `, section ${section}` : ""}`;
    steps.push(writeStep("move_to", () => context.asana.placeTask(taskGid, project, section), () => placed));
  }
  if (removeFrom) {
    const remove = () => context.asana.removeTaskFromProject(taskGid, removeFrom);
    steps.push(writeStep("remove_from_project", remove, () => `removed from project ${removeFrom}`));
  }
  if (parent !== undefined) {
    const setParent = () => context.asana.setTaskParent(taskGid, parent);
    const renderParent = (newParent?: Compact) => `parent: ${newParent ? label(newParent) : (parent ?? "none")}`;
    steps.push(writeStep("parent_gid", setParent, renderParent));
  }
  if (removeBlockedBy) {
    const remove = () => context.asana.removeBlockers(taskGid, removeBlockedBy);
    steps.push(writeStep("remove_blocked_by", remove, () => `blockers removed: ${removeBlockedBy.join(", ")}`));
  }
  if (addBlockedBy) {
    const add = () => context.asana.addBlockers(taskGid, addBlockedBy);
    steps.push(writeStep("add_blocked_by", add, () => `blockers added: ${addBlockedBy.join(", ")}`));
  }
  const done = await writeInOrder(steps);
  return [heading, ...done].join("\n");
}

export async function deleteTask(context: Context, input: z.infer<typeof deleteTaskInput>): Promise<string> {
  const taskGid = input.task_gid;
  requirePinnedWorkspace(context, await context.asana.taskWorkspace(taskGid), `task ${taskGid}`);
  await context.asana.deleteTask(taskGid).catch((err) => rethrowWithLandedHint(err, "get_task"));
  return `deleted task ${taskGid}: it is in the token user's Asana trash, restorable for 30 days.`;
}

function renderStory(story: Story, includeSystem: boolean, withHtml: boolean): string {
  const details = [
    ...(includeSystem ? [story.subtype ?? "unknown type"] : []),
    `by ${story.author ? label(story.author) : "unknown"}`,
    `at ${story.createdAt ?? "unknown time"}`,
  ];
  const bodies = [indented("text", story.text ? story.text.split("\n") : [])];
  if (withHtml) bodies.push(indented("html_text", story.htmlText ? story.htmlText.split("\n") : []));
  const bodyLines = bodies.join("\n").split("\n").map((line) => `  ${line}`);
  return [`${includeSystem ? "story" : "comment"} ${story.gid}: ${details.join(", ")}`, ...bodyLines].join("\n");
}

export async function listComments(context: Context, input: z.infer<typeof listCommentsInput>): Promise<string> {
  const taskGid = input.task_gid;
  const includeSystem = input.include_system ?? false;
  const withHtml = input.include_html ?? false;
  await requireTaskInPinnedWorkspace(context, taskGid);
  const page = await context.asana.storyList(taskGid, {
    commentsOnly: !includeSystem,
    withHtml,
    limit: input.limit ?? DEFAULT_LIMIT,
    cursor: input.cursor,
  });
  const stories = includeSystem ? page.items : page.items.filter((story) => story.subtype === "comment_added");
  const heading = `${includeSystem ? "stories" : "comments"} on task ${taskGid}, oldest first`;
  const rows = stories.map((story) => renderStory(story, includeSystem, withHtml));
  return renderList(heading, rows, page.cursor && `cursor: ${page.cursor}`);
}

export async function addComment(context: Context, input: z.infer<typeof addCommentInput>): Promise<string> {
  const { task_gid: taskGid, text, html_text: htmlText } = input;
  const bodies: CommentBody[] = [
    ...(text === undefined ? [] : [{ text }]),
    ...(htmlText === undefined ? [] : [{ html_text: htmlText }]),
  ];
  if (bodies.length !== 1) throw new Error("pass exactly one of 'text' or 'html_text'.");
  await requireTaskInPinnedWorkspace(context, taskGid);
  const story = await context.asana
    .addComment(taskGid, bodies[0])
    .catch((err) => rethrowWithLandedHint(err, "list_comments"));
  return [`added comment ${story.gid} to task ${taskGid}`, `created_at: ${story.createdAt ?? "unknown"}`].join("\n");
}

function renderCustomField(field: CustomField): string[] {
  const options = field.enumOptions.map((option) => `  ${label(option)}${option.enabled ? "" : ", disabled"}`);
  return [`${label(field)}: ${field.type ?? "unknown type"}${field.readOnly ? ", read-only" : ""}`, ...options];
}

function renderProject(project: Project, blocks: string[]): string {
  return [
    `project: ${label(project)}`,
    `url: ${project.permalink ?? "none"}`,
    `archived: ${project.archived ? "yes" : "no"}`,
    `completed: ${project.completed ? "yes" : "no"}`,
    `owner: ${project.owner ? label(project.owner) : "none"}`,
    `team: ${project.team ? label(project.team) : "none"}`,
    ...(project.startOn ? [`start: ${project.startOn}`] : []),
    `due: ${project.dueOn ?? "none"}`,
    ...blocks,
    indented("custom fields", project.customFields.flatMap(renderCustomField)),
    indented("custom field values", project.customFieldValues.map(renderCustomFieldValue)),
    indented("notes", project.notes ? project.notes.split("\n") : []),
  ].join("\n");
}

function renderFirstPage(title: string, page: { items: Compact[]; cursor?: string }): string {
  return indented(title, [...page.items.map(label), ...(page.cursor ? [`more ${title} not shown`] : [])]);
}

async function renderProjectPortfolios(context: Context, projectGid: string): Promise<string> {
  try {
    return renderFirstPage("portfolios", await context.asana.projectPortfolios(projectGid));
  } catch (err) {
    if (!(err instanceof AsanaError)) throw err;
    return `portfolios: not available (${err.message})`;
  }
}

export async function getProject(context: Context, input: z.infer<typeof getProjectInput>): Promise<string> {
  const project = await context.asana.project(input.project_gid);
  requirePinnedWorkspace(context, project.workspaceGid, `project ${input.project_gid}`);
  const sections = renderFirstPage("sections", await context.asana.sectionList(input.project_gid));
  return renderProject(project, [sections, await renderProjectPortfolios(context, input.project_gid)]);
}

export async function updateProject(context: Context, input: z.infer<typeof updateProjectInput>): Promise<string> {
  const projectGid = input.project_gid;
  const target = await context.asana.projectTarget(projectGid);
  requirePinnedWorkspace(context, target.workspaceGid, `project ${projectGid}`);
  const fields = await resolvePinned(context, input.custom_fields, target.customFields, `project ${projectGid}`);
  const project = await context.asana
    .updateProject(projectGid, fields)
    .catch((err) => rethrowWithLandedHint(err, "get_project"));
  return [
    `updated project: ${label(project)}`,
    renderCustomFieldChanges(project.customFieldValues, Object.keys(fields)),
  ].join("\n");
}

function renderPortfolioSummary(portfolio: PortfolioSummary | PortfolioItem): string {
  return portfolio.archived ? `${label(portfolio)}, archived` : label(portfolio);
}

function requireAllInPinnedWorkspace(context: Context, items: { workspaceGid?: string }[], what: string): void {
  for (const item of items) requirePinnedWorkspace(context, item.workspaceGid, what);
}

export async function listPortfolios(context: Context, input: z.infer<typeof listPortfoliosInput>): Promise<string> {
  const owner = input.owner ?? "me";
  const page = await context.asana.portfolioList(context.workspace.gid, owner, {
    limit: input.limit ?? DEFAULT_LIMIT,
    cursor: input.cursor,
  });
  requireAllInPinnedWorkspace(context, page.items, "a listed portfolio");
  const heading = `portfolios owned by ${owner === "me" ? "the token's user" : `user ${owner}`}`;
  return renderList(heading, page.items.map(renderPortfolioSummary), page.cursor && `cursor: ${page.cursor}`);
}

function renderPortfolioItem(item: PortfolioItem, fieldGids: Set<string>): string {
  const values = item.customFieldValues.filter((value) => fieldGids.has(value.field.gid));
  const heading = `${item.type ?? "item"} ${renderPortfolioSummary(item)}`;
  return [heading, ...values.map((value) => `  ${renderCustomFieldValue(value)}`)].join("\n");
}

function renderPortfolio(portfolio: Portfolio, items: PortfolioItem[], more: string | undefined): string {
  const fieldGids = new Set(portfolio.customFields.map((field) => field.gid));
  return [
    `portfolio: ${label(portfolio)}`,
    `url: ${portfolio.permalink ?? "none"}`,
    `archived: ${portfolio.archived ? "yes" : "no"}`,
    `owner: ${portfolio.owner ? label(portfolio.owner) : "none"}`,
    ...(portfolio.color ? [`color: ${portfolio.color}`] : []),
    `latest status update: ${portfolio.statusTitle ?? "none"}`,
    ...(portfolio.startOn ? [`start: ${portfolio.startOn}`] : []),
    `due: ${portfolio.dueOn ?? "none"}`,
    indented("custom fields", portfolio.customFields.flatMap(renderCustomField)),
    renderList("items", items.map((item) => renderPortfolioItem(item, fieldGids)), more),
  ].join("\n");
}

export async function getPortfolio(context: Context, input: z.infer<typeof getPortfolioInput>): Promise<string> {
  const portfolioGid = input.portfolio_gid;
  const portfolio = await context.asana.portfolio(portfolioGid);
  requirePinnedWorkspace(context, portfolio.workspaceGid, `portfolio ${portfolioGid}`);
  const page = await context.asana.portfolioItems(portfolioGid, {
    limit: input.limit ?? DEFAULT_LIMIT,
    cursor: input.cursor,
  });
  return renderPortfolio(portfolio, page.items, page.cursor && `cursor: ${page.cursor}`);
}

async function requirePortfolioItemInPinnedWorkspace(context: Context, input: z.infer<typeof portfolioItemInput>) {
  const portfolioGid = input.portfolio_gid;
  requirePinnedWorkspace(context, await context.asana.portfolioWorkspace(portfolioGid), `portfolio ${portfolioGid}`);
  await requireProjectInPinnedWorkspace(context, input.project_gid);
}

export async function addToPortfolio(context: Context, input: z.infer<typeof portfolioItemInput>): Promise<string> {
  await requirePortfolioItemInPinnedWorkspace(context, input);
  await context.asana
    .addPortfolioItem(input.portfolio_gid, input.project_gid)
    .catch((err) => rethrowWithLandedHint(err, "get_project"));
  return `added project ${input.project_gid} to portfolio ${input.portfolio_gid}`;
}

export async function removeFromPortfolio(
  context: Context,
  input: z.infer<typeof portfolioItemInput>,
): Promise<string> {
  await requirePortfolioItemInPinnedWorkspace(context, input);
  await context.asana
    .removePortfolioItem(input.portfolio_gid, input.project_gid)
    .catch((err) => rethrowWithLandedHint(err, "get_project"));
  return `removed project ${input.project_gid} from portfolio ${input.portfolio_gid}`;
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
        "List tasks in their Asana order. Pass exactly one of 'project_gid', 'section_gid', or 'parent_gid'.",
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
        "Create a task in 'project_gid', under 'parent_gid', or both. " +
        "At most one of 'notes'/'html_notes' and of 'due_on'/'due_at'.",
      inputSchema: createTaskInput,
    },
    serially(createTask),
  );

  verb(
    "update_task",
    {
      description:
        "Change only the given fields of a task and return their new values. " +
        "At most one of 'notes'/'html_notes' and of 'due_on'/'due_at'. " +
        "Not atomic: a failure lists what changed and what was not sent.",
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
    "list_comments",
    {
      description: "List a task's comments, oldest first, with author and time.",
      inputSchema: listCommentsInput,
    },
    listComments,
  );

  verb(
    "add_comment",
    {
      description: "Comment on a task as the token's user. Pass exactly one of 'text' or 'html_text'.",
      inputSchema: addCommentInput,
    },
    serially(addComment),
  );

  verb(
    "get_project",
    {
      description:
        "Read one project: owner, team, dates, archived and completed state, sections, portfolios, custom fields " +
        "with their type and enum options, its own custom field values, and its description.",
      inputSchema: getProjectInput,
    },
    getProject,
  );

  verb(
    "update_project",
    {
      description: "Set a project's own custom field values, such as its portfolios' fields, and return them.",
      inputSchema: updateProjectInput,
    },
    serially(updateProject),
  );

  verb(
    "list_portfolios",
    {
      description: "List the workspace's portfolios a user owns.",
      inputSchema: listPortfoliosInput,
    },
    listPortfolios,
  );

  verb(
    "get_portfolio",
    {
      description:
        "Read one portfolio: owner, status, dates, its custom fields with enum options, and a page of its " +
        "projects and portfolios with each one's values for those fields.",
      inputSchema: getPortfolioInput,
    },
    getPortfolio,
  );

  verb(
    "add_to_portfolio",
    { description: "Add a project to a portfolio.", inputSchema: portfolioItemInput },
    serially(addToPortfolio),
  );

  verb(
    "remove_from_portfolio",
    { description: "Take a project out of a portfolio.", inputSchema: portfolioItemInput },
    serially(removeFromPortfolio),
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
        "List the workspace's users. With 'query', return one page of matches, most worked with first.",
      inputSchema: listUsersInput,
    },
    listUsers,
  );

  return server;
}
