// The only module that touches the asana SDK.

import { ApiClient, ProjectsApi, SectionsApi, TasksApi, TypeaheadApi, UsersApi, WorkspacesApi } from "asana";

export const ASANA_API = "https://app.asana.com/api/1.0";

/** An Asana gid: a decimal string, kept as a string since gids outgrow a double. */
export const GID = /^\d{1,20}$/;

export const CURSOR = /^[\w\-.:=+/]{1,512}$/;

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

export type EnumOption = { gid: string; name: string; enabled: boolean };

export type CustomField = Compact & { type?: string; enumOptions: EnumOption[] };

export type ProjectSummary = Compact & { archived: boolean; team?: Compact; workspaceGid?: string };

export type Project = ProjectSummary & {
  permalink?: string;
  completed: boolean;
  owner?: Compact;
  startOn?: string;
  dueOn?: string;
  notes: string;
  customFields: CustomField[];
};

export type WorkspaceUser = User & { workspaceGids: string[] };

export type Page<Item> = { items: Item[]; cursor?: string };

type Resource = Record<string, unknown> & { gid: string };

export type TaskScope = { project: string } | { section: string } | { parent: string };

export type TaskSubtype = "default_task" | "milestone" | "approval";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested";

/** null clears a field. */
export type TaskFields = {
  name?: string;
  notes?: string;
  html_notes?: string;
  assignee?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  resource_subtype?: TaskSubtype;
  completed?: boolean;
  approval_status?: ApprovalStatus;
};

export type TaskPlacement = { project?: string; section?: string; parent?: string };

export type TaskSearch = {
  text?: string;
  assignee?: string;
  project?: string;
  section?: string;
  tag?: string;
  completed?: boolean;
  dueOnAfter?: string;
  dueOnBefore?: string;
  limit: number;
};

const TASK_SUMMARY_FIELDS = "name,completed,assignee.name,due_on,due_at,workspace";

const TASK_FIELDS = [
  TASK_SUMMARY_FIELDS,
  "permalink_url,notes,html_notes,start_on,start_at,completed_at,resource_subtype,approval_status",
  "custom_fields.name,custom_fields.display_value,memberships.project.name,memberships.section.name",
  "parent.name,dependencies.name,dependents.name,num_subtasks",
].join(",");

const PROJECT_SUMMARY_FIELDS = "name,archived,team.name,workspace";

const PROJECT_FIELDS = [
  PROJECT_SUMMARY_FIELDS,
  "permalink_url,completed,owner.name,start_on,due_on,notes",
  "custom_field_settings.custom_field.name,custom_field_settings.custom_field.resource_subtype",
  "custom_field_settings.custom_field.enum_options.name,custom_field_settings.custom_field.enum_options.enabled",
].join(",");

const USER_FIELDS = "name,email,workspaces";

export const MAX_NOTES = 20_000;

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

function customFieldsOf(setting: unknown): CustomField[] {
  const field = (setting as { custom_field?: unknown } | null)?.custom_field;
  if (!isResource(field)) return [];
  const enumOptions = (Array.isArray(field.enum_options) ? field.enum_options : []).flatMap((option) => {
    const compactOption = compact(option);
    return compactOption ? [{ ...compactOption, enabled: option.enabled !== false }] : [];
  });
  return [{ gid: field.gid, name: text(field.name) ?? "", type: text(field.resource_subtype), enumOptions }];
}

function projectSummary(data: Resource): ProjectSummary {
  return {
    gid: data.gid,
    name: text(data.name) ?? "",
    archived: data.archived === true,
    team: compact(data.team),
    workspaceGid: compact(data.workspace)?.gid,
  };
}

function project(data: Resource): Project {
  return {
    ...projectSummary(data),
    permalink: text(data.permalink_url),
    completed: data.completed === true,
    owner: compact(data.owner),
    startOn: text(data.start_on),
    dueOn: text(data.due_on),
    notes: multiline(data.notes),
    customFields: (Array.isArray(data.custom_field_settings) ? data.custom_field_settings : []).flatMap(customFieldsOf),
  };
}

function workspaceUser(data: Resource): WorkspaceUser {
  return {
    gid: data.gid,
    name: text(data.name) ?? "",
    email: text(data.email),
    workspaceGids: compacts(data.workspaces).map((workspace) => workspace.gid),
  };
}

export class Asana {
  private readonly projects: ProjectsApi;
  private readonly sections: SectionsApi;
  private readonly tasks: TasksApi;
  private readonly typeahead: TypeaheadApi;
  private readonly users: UsersApi;
  private readonly workspaces: WorkspacesApi;

  constructor(token: string, basePath = ASANA_API) {
    const client = new ApiClient();
    client.basePath = basePath;
    client.authentications.token.accessToken = token;
    // superagent resends the Authorization header on a 307 or 308 to any host.
    const applyAuth = client.applyAuthToRequest.bind(client);
    client.applyAuthToRequest = (request, authNames) => applyAuth(request.redirects(0), authNames);
    // Otherwise list calls drop `next_page`.
    client.RETURN_COLLECTION = false;
    this.projects = new ProjectsApi(client);
    this.sections = new SectionsApi(client);
    this.tasks = new TasksApi(client);
    this.typeahead = new TypeaheadApi(client);
    this.users = new UsersApi(client);
    this.workspaces = new WorkspacesApi(client);
  }

  private async send(what: string, request: () => Promise<unknown>): Promise<{ data?: unknown; next_page?: unknown }> {
    try {
      return ((await request()) ?? {}) as { data?: unknown; next_page?: unknown };
    } catch (err) {
      const { message, status } = describeFailure(err);
      throw new AsanaError(`${what}: ${message}`, status);
    }
  }

  private async call(what: string, request: () => Promise<unknown>): Promise<Resource> {
    const { data } = await this.send(what, request);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new AsanaError(`${what}: Asana's answer had no data`);
    }
    if (!isResource(data)) throw new AsanaError(`${what}: Asana's answer had no gid`);
    return data;
  }

  private async callList(what: string, request: () => Promise<unknown>): Promise<Page<Resource>> {
    const { data, next_page: nextPage } = await this.send(what, request);
    if (!Array.isArray(data)) throw new AsanaError(`${what}: Asana's answer had no data`);
    if (!data.every(isResource)) throw new AsanaError(`${what}: Asana's answer had an item without a gid`);
    if (nextPage === undefined || nextPage === null) return { items: data };
    const offset = (nextPage as { offset?: unknown }).offset;
    if (typeof offset !== "string" || !CURSOR.test(offset)) {
      throw new AsanaError(`${what}: Asana's next page was malformed`);
    }
    return { items: data, cursor: offset };
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

  async taskWorkspace(gid: string): Promise<string | undefined> {
    const data = await this.call(`reading task ${gid}`, () => this.tasks.getTask(gid, { opt_fields: "workspace" }));
    return compact(data.workspace)?.gid;
  }

  async userWorkspaces(gid: string): Promise<string[]> {
    const data = await this.call(`reading user ${gid}`, () => this.users.getUser(gid, { opt_fields: "workspaces" }));
    return compacts(data.workspaces).map((workspace) => workspace.gid);
  }

  async createTask(workspaceGid: string, placement: TaskPlacement, fields: TaskFields): Promise<Task> {
    const { project, section, parent } = placement;
    const data = {
      ...fields,
      workspace: workspaceGid,
      ...(project === undefined ? {} : section ? { memberships: [{ project, section }] } : { projects: [project] }),
      ...(parent === undefined ? {} : { parent }),
    };
    return task(await this.call("creating a task", () => this.tasks.createTask({ data }, { opt_fields: TASK_FIELDS })));
  }

  async updateTask(gid: string, fields: TaskFields): Promise<Task> {
    return task(
      await this.call(`updating task ${gid}`, () =>
        this.tasks.updateTask({ data: fields }, gid, { opt_fields: TASK_FIELDS }),
      ),
    );
  }

  async deleteTask(gid: string): Promise<void> {
    await this.send(`deleting task ${gid}`, () => this.tasks.deleteTask(gid));
  }

  async workspaceOf(scope: TaskScope): Promise<string | undefined> {
    if ("parent" in scope) return this.taskWorkspace(scope.parent);
    const projectGid = "project" in scope ? scope.project : await this.projectOfSection(scope.section);
    if (projectGid === undefined) return undefined;
    const what = "project" in scope ? `reading project ${projectGid}` : `reading section ${scope.section}'s project`;
    const project = await this.call(what, () =>
      this.projects.getProject(projectGid, { opt_fields: "workspace" }),
    );
    return compact(project.workspace)?.gid;
  }

  async projectOfSection(sectionGid: string): Promise<string | undefined> {
    const section = await this.call(`reading section ${sectionGid}`, () =>
      this.sections.getSection(sectionGid, { opt_fields: "project" }),
    );
    return compact(section.project)?.gid;
  }

  async taskList(
    scope: TaskScope,
    options: { incompleteOnly: boolean; limit: number; cursor?: string },
  ): Promise<Page<TaskSummary>> {
    const query = { opt_fields: TASK_SUMMARY_FIELDS, limit: options.limit, offset: options.cursor };
    const incompleteFilter = options.incompleteOnly ? { completed_since: "now" } : {};
    const page =
      "project" in scope
        ? await this.callList(`listing tasks in project ${scope.project}`, () =>
            this.tasks.getTasksForProject(scope.project, { ...query, ...incompleteFilter }),
          )
        : "section" in scope
          ? await this.callList(`listing tasks in section ${scope.section}`, () =>
              this.tasks.getTasksForSection(scope.section, { ...query, ...incompleteFilter }),
            )
          : await this.callList(`listing subtasks of task ${scope.parent}`, () =>
              this.tasks.getSubtasksForTask(scope.parent, query),
            );
    return { items: page.items.map(taskSummary), cursor: page.cursor };
  }

  async searchTasks(workspaceGid: string, search: TaskSearch): Promise<TaskSummary[]> {
    const query = {
      opt_fields: TASK_SUMMARY_FIELDS,
      limit: search.limit,
      sort_by: "created_at",
      sort_ascending: false,
      text: search.text,
      "assignee.any": search.assignee,
      "projects.any": search.project,
      "sections.any": search.section,
      "tags.any": search.tag,
      completed: search.completed,
      "due_on.after": search.dueOnAfter,
      "due_on.before": search.dueOnBefore,
    };
    const page = await this.callList("searching tasks", () =>
      this.tasks.searchTasksForWorkspace(workspaceGid, query),
    ).catch((err) => {
      if (err instanceof AsanaError && err.status === 402) {
        throw new AsanaError(`${err.message}. Task search needs Asana Premium.`, 402);
      }
      throw err;
    });
    return page.items.map(taskSummary);
  }

  async project(gid: string): Promise<Project> {
    return project(
      await this.call(`reading project ${gid}`, () => this.projects.getProject(gid, { opt_fields: PROJECT_FIELDS })),
    );
  }

  async sectionList(projectGid: string): Promise<Page<Compact>> {
    const page = await this.callList(`listing sections of project ${projectGid}`, () =>
      this.sections.getSectionsForProject(projectGid, { opt_fields: "name", limit: 100 }),
    );
    return { items: compacts(page.items), cursor: page.cursor };
  }

  async findProjects(workspaceGid: string, query: string, count: number): Promise<ProjectSummary[]> {
    const page = await this.callList("finding projects", () =>
      this.typeahead.typeaheadForWorkspace(workspaceGid, "project", {
        query,
        count,
        opt_fields: PROJECT_SUMMARY_FIELDS,
      }),
    );
    return page.items.map(projectSummary);
  }

  async findUsers(workspaceGid: string, query: string, count: number): Promise<WorkspaceUser[]> {
    const page = await this.callList("finding users", () =>
      this.typeahead.typeaheadForWorkspace(workspaceGid, "user", { query, count, opt_fields: USER_FIELDS }),
    );
    return page.items.map(workspaceUser);
  }

  async userList(workspaceGid: string, options: { limit: number; cursor?: string }): Promise<Page<WorkspaceUser>> {
    const page = await this.callList("listing users", () =>
      this.users.getUsers({
        workspace: workspaceGid,
        limit: options.limit,
        offset: options.cursor,
        opt_fields: USER_FIELDS,
      }),
    );
    return { items: page.items.map(workspaceUser), cursor: page.cursor };
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
