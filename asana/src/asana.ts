// The only module that touches the asana SDK.

import { ApiClient, TasksApi, UsersApi, WorkspacesApi } from "asana";

export const ASANA_API = "https://app.asana.com/api/1.0";

/** An Asana gid: a decimal string, kept as a string since gids outgrow a double. */
export const GID = /^\d{1,20}$/;

/** Carries no reference to the SDK's error, whose request object holds the token. */
export class AsanaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type User = { gid: string; name: string; email?: string };
export type Workspace = { gid: string; name: string };
export type Compact = { gid: string; name: string };

export type TaskSummary = {
  gid: string;
  name: string;
  completed: boolean;
  assignee?: Compact;
  dueOn?: string;
  dueAt?: string;
  workspaceGid?: string;
};

export type Task = TaskSummary & {
  permalink?: string;
  notes: string;
  htmlNotes: string;
  startOn?: string;
  startAt?: string;
  completedAt?: string;
  subtype?: string;
  approvalStatus?: string;
  customFields: { field: Compact; value?: string }[];
  memberships: { project: Compact; section?: Compact }[];
  parent?: Compact;
  dependencies: Compact[];
  dependents: Compact[];
  subtaskCount?: number;
};

type Resource = Record<string, unknown> & { gid: string };

const TASK_SUMMARY_FIELDS = "name,completed,assignee.name,due_on,due_at,workspace";

const TASK_FIELDS = [
  TASK_SUMMARY_FIELDS,
  "permalink_url,notes,html_notes,start_on,start_at,completed_at,resource_subtype,approval_status",
  "custom_fields.name,custom_fields.display_value,memberships.project.name,memberships.section.name",
  "parent.name,dependencies.name,dependents.name,num_subtasks",
].join(",");

const MAX_NOTES = 20_000;

type SdkError = {
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  response?: { body?: { errors?: unknown }; headers?: Record<string, unknown> };
};

/** One line, so text from Asana cannot forge lines in a reply or the log. */
function oneLine(text: string, max = 500): string {
  return [...text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")].slice(0, max).join("");
}

function describeFailure(err: unknown): { message: string; status?: number } {
  const sdkError = (err ?? {}) as SdkError;
  // A body that fails to parse carries only statusCode.
  const status = [sdkError.status, sdkError.statusCode].find((value) => typeof value === "number") as number | undefined;
  if (status === undefined) return { message: `cannot reach Asana: ${oneLine(String(sdkError.message ?? err))}` };
  const errors = sdkError.response?.body?.errors;
  const reasons = (Array.isArray(errors) ? errors : [])
    .map((error) => error?.message)
    .filter((message): message is string => typeof message === "string");
  const reason = reasons.length ? reasons.join("; ") : String(sdkError.message ?? "no reason given");
  let message = `Asana answered ${status}: ${oneLine(reason)}`;
  if (status === 429) {
    const retryAfter = String(sdkError.response?.headers?.["retry-after"] ?? "");
    message += /^\d{1,6}$/.test(retryAfter) ? `. Retry after ${retryAfter} seconds.` : ". Retry later.";
  }
  return { message, status };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? oneLine(value) : undefined;
}

/** Keeps newlines, so each line can be indented under a heading. */
function multiline(value: unknown): string {
  if (typeof value !== "string") return "";
  const kept = [...value.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]+/g, " ")];
  if (kept.length <= MAX_NOTES) return kept.join("");
  return `${kept.slice(0, MAX_NOTES).join("")}\n[cut at ${MAX_NOTES} characters]`;
}

function isResource(value: unknown): value is Resource {
  const gid = (value as { gid?: unknown } | null)?.gid;
  return typeof value === "object" && !Array.isArray(value) && typeof gid === "string" && GID.test(gid);
}

function compact(value: unknown): Compact | undefined {
  return isResource(value) ? { gid: value.gid, name: text(value.name) ?? "" } : undefined;
}

function compacts(value: unknown): Compact[] {
  return (Array.isArray(value) ? value : []).map(compact).filter((item): item is Compact => item !== undefined);
}

function taskSummary(data: Resource): TaskSummary {
  return {
    gid: data.gid,
    name: text(data.name) ?? "",
    completed: data.completed === true,
    assignee: compact(data.assignee),
    dueOn: text(data.due_on),
    dueAt: text(data.due_at),
    workspaceGid: compact(data.workspace)?.gid,
  };
}

function task(data: Resource): Task {
  const memberships = (Array.isArray(data.memberships) ? data.memberships : []).flatMap((membership) => {
    const project = compact(membership?.project);
    return project ? [{ project, section: compact(membership.section) }] : [];
  });
  const customFields = (Array.isArray(data.custom_fields) ? data.custom_fields : []).flatMap((field) => {
    const fieldCompact = compact(field);
    return fieldCompact ? [{ field: fieldCompact, value: text(field.display_value) || undefined }] : [];
  });
  return {
    ...taskSummary(data),
    permalink: text(data.permalink_url),
    notes: multiline(data.notes),
    htmlNotes: multiline(data.html_notes),
    startOn: text(data.start_on),
    startAt: text(data.start_at),
    completedAt: text(data.completed_at),
    subtype: text(data.resource_subtype),
    approvalStatus: text(data.approval_status),
    customFields,
    memberships,
    parent: compact(data.parent),
    dependencies: compacts(data.dependencies),
    dependents: compacts(data.dependents),
    subtaskCount: typeof data.num_subtasks === "number" ? data.num_subtasks : undefined,
  };
}

export class Asana {
  private readonly tasks: TasksApi;
  private readonly users: UsersApi;
  private readonly workspaces: WorkspacesApi;

  constructor(token: string, basePath = ASANA_API) {
    const client = new ApiClient();
    client.basePath = basePath;
    client.authentications.token.accessToken = token;
    // superagent resends the Authorization header on a 307 or 308 to any host.
    const applyAuth = client.applyAuthToRequest.bind(client);
    client.applyAuthToRequest = (request, authNames) => applyAuth(request.redirects(0), authNames);
    this.tasks = new TasksApi(client);
    this.users = new UsersApi(client);
    this.workspaces = new WorkspacesApi(client);
  }

  private async call(what: string, request: () => Promise<unknown>): Promise<Resource> {
    let body: unknown;
    try {
      body = await request();
    } catch (err) {
      const { message, status } = describeFailure(err);
      throw new AsanaError(`${what}: ${message}`, status);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new AsanaError(`${what}: Asana's answer had no data`);
    }
    if (!isResource(data)) throw new AsanaError(`${what}: Asana's answer had no gid`);
    return data;
  }

  async me(): Promise<User> {
    const data = await this.call("reading the token's user", () =>
      this.users.getUser("me", { opt_fields: "name,email" }),
    );
    return { gid: data.gid, name: text(data.name) ?? "", email: text(data.email) };
  }

  async workspace(gid: string): Promise<Workspace> {
    const data = await this.call(`reading workspace ${gid}`, () =>
      this.workspaces.getWorkspace(gid, { opt_fields: "name" }),
    );
    return { gid: data.gid, name: text(data.name) ?? "" };
  }

  async task(gid: string): Promise<Task> {
    return task(await this.call(`reading task ${gid}`, () => this.tasks.getTask(gid, { opt_fields: TASK_FIELDS })));
  }
}

export async function openWorkspace(asana: Asana, workspaceGid: string): Promise<{ user: User; workspace: Workspace }> {
  const user = await asana.me();
  const workspace = await asana.workspace(workspaceGid);
  if (workspace.gid !== workspaceGid) {
    throw new AsanaError(`reading workspace ${workspaceGid}: Asana answered with workspace ${workspace.gid}`);
  }
  return { user, workspace };
}
