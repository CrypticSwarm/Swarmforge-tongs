import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { getTask, listTasks, searchTasks, type Context } from "../src/server.js";
import { FakeAsana, WORKSPACE, dataReply, errorReply, pageReply, type Routes } from "./fakes.js";

const TASK_GID = "1300000000000001";
const PROJECT_GID = "1400000000000001";
const SECTION_GID = "1500000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid, resource_type: "workspace" };
const ELSEWHERE = { gid: "1100000000000999", resource_type: "workspace" };
const SUMMARY_FIELDS = "name,completed,assignee.name,due_on,due_at,workspace";

function customField(index: number, name: string, type: string, value: Record<string, unknown>) {
  return { gid: `160000000000000${index}`, name, resource_subtype: type, ...value };
}

const FULL_TASK = {
  gid: TASK_GID,
  name: "Ship it",
  completed: true,
  completed_at: "2026-11-01T10:00:00.000Z",
  assignee: { gid: "1200000000000001", name: "Ada Lovelace" },
  due_on: "2026-11-02",
  start_on: "2026-10-30",
  workspace: IN_WORKSPACE,
  permalink_url: "https://app.asana.com/0/0/1300000000000001",
  notes: "line one\nassignee: forged\r\nsep end\x1b",
  html_notes: "<body>line <strong>one</strong>\n</body>",
  resource_subtype: "approval",
  approval_status: "pending",
  custom_fields: [
    customField(1, "Priority", "enum", { enum_value: { gid: "1620000000000001", name: "High" } }),
    customField(2, "Estimate", "number", { number_value: null, display_value: "" }),
    customField(3, "Tags", "multi_enum", { multi_enum_values: [{ gid: "1620000000000002", name: "Red" }] }),
    customField(4, "Points", "number", { number_value: 3.5, display_value: "3.50" }),
    customField(5, "Ship", "date", { date_value: { date: "2026-11-20", date_time: null } }),
    customField(9, "Due", "date", { date_value: { date: "2026-11-20", date_time: "2026-11-20T17:00:00.000Z" } }),
    customField(6, "Reviewers", "people", { people_value: [{ gid: "1200000000000001", name: "Ada" }] }),
    customField(7, "Code", "text", { text_value: "A-1" }),
    customField(8, "Score", "formula", { display_value: "42" }),
  ],
  memberships: [{ project: { gid: PROJECT_GID, name: "Launch" }, section: { gid: SECTION_GID, name: "Doing" } }],
  parent: { gid: "1300000000000002", name: "Epic" },
  dependencies: [{ gid: "1300000000000003", name: "Design" }],
  dependents: [],
  num_subtasks: 2,
};

function summary(gid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name: `Task ${gid.slice(-1)}`, completed: false, workspace: IN_WORKSPACE, ...extra };
}

function projectRoute(workspace = IN_WORKSPACE): Routes {
  return { [`GET /projects/${PROJECT_GID}`]: dataReply({ gid: PROJECT_GID, workspace }) };
}

let fake: FakeAsana;
let context: Context;

before(async () => {
  fake = await FakeAsana.start();
  context = { asana: fake.client(), workspace: WORKSPACE };
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.routes = {};
});

after(() => fake.close());

describe("get_task", () => {
  it("renders every field and indents each description line", async () => {
    fake.routes = { [`GET /tasks/${TASK_GID}`]: dataReply(FULL_TASK) };
    assert.equal(
      await getTask(context, { task_gid: TASK_GID }),
      [
        "task: Ship it (gid 1300000000000001)",
        "url: https://app.asana.com/0/0/1300000000000001",
        "type: approval, pending",
        "completed: yes, at 2026-11-01T10:00:00.000Z",
        "assignee: Ada Lovelace (gid 1200000000000001)",
        "start: 2026-10-30",
        "due: 2026-11-02",
        "parent: Epic (gid 1300000000000002)",
        "subtasks: 2",
        "projects:",
        "  Launch (gid 1400000000000001), section Doing (gid 1500000000000001)",
        "custom fields:",
        "  Priority (gid 1600000000000001), enum: High (gid 1620000000000001)",
        "  Estimate (gid 1600000000000002), number: not set",
        "  Tags (gid 1600000000000003), multi_enum: Red (gid 1620000000000002)",
        "  Points (gid 1600000000000004), number: 3.5",
        "  Ship (gid 1600000000000005), date: 2026-11-20",
        "  Due (gid 1600000000000009), date: 2026-11-20T17:00:00.000Z",
        "  Reviewers (gid 1600000000000006), people: Ada (gid 1200000000000001)",
        "  Code (gid 1600000000000007), text: A-1",
        "  Score (gid 1600000000000008), formula: 42",
        "blocked by:",
        "  Design (gid 1300000000000003)",
        "blocking: none",
        "notes:",
        "  line one",
        "  assignee: forged",
        "  sep",
        "  end ",
        "html_notes:",
        "  <body>line <strong>one</strong>",
        "  </body>",
      ].join("\n"),
    );
    const { query } = fake.requestsTo("GET", `/tasks/${TASK_GID}`)[0];
    assert.equal(
      query.opt_fields.split(",").sort().join(","),
      "approval_status,assignee.name,completed,completed_at,custom_fields.date_value,custom_fields.display_value," +
        "custom_fields.enum_value.name,custom_fields.multi_enum_values.name,custom_fields.name," +
        "custom_fields.number_value,custom_fields.people_value.name,custom_fields.resource_subtype," +
        "custom_fields.text_value," +
        "dependencies.name,dependents.name,due_at,due_on,html_notes,memberships.project.name," +
        "memberships.section.name,name,notes,num_subtasks,parent.name,permalink_url,resource_subtype,start_at," +
        "start_on,workspace",
    );
  });

  it("cuts a long description and says so", async () => {
    fake.routes = { [`GET /tasks/${TASK_GID}`]: dataReply({ ...FULL_TASK, notes: "x".repeat(20_001) }) };
    assert.match(await getTask(context, { task_gid: TASK_GID }), /\n {2}x{20000}\n {2}\[cut at 20000 characters\]\n/);
  });

  it("refuses a task in another workspace, or in none", async () => {
    for (const workspace of [ELSEWHERE, undefined]) {
      fake.routes = { [`GET /tasks/${TASK_GID}`]: dataReply({ ...FULL_TASK, workspace }) };
      await assert.rejects(getTask(context, { task_gid: TASK_GID }), {
        message: `task ${TASK_GID} is not in workspace Acme (gid ${WORKSPACE.gid}).`,
      });
    }
  });
});

describe("list_tasks", () => {
  it("lists a project's tasks and ends a partial list with its cursor", async () => {
    const assignee = { gid: "1200000000000001", name: "Ada" };
    fake.routes = {
      ...projectRoute(),
      [`GET /projects/${PROJECT_GID}/tasks`]: pageReply(
        [
          summary("1300000000000001", { assignee, due_at: "2026-11-02T09:00:00.000Z" }),
          summary("1300000000000002", { completed: true }),
        ],
        "eyJvZmZzZXQiOjJ9",
      ),
    };
    assert.equal(
      await listTasks(context, { project_gid: PROJECT_GID, limit: 2, cursor: "abc" }),
      [
        `tasks in project ${PROJECT_GID}:`,
        "- Task 1 (gid 1300000000000001): incomplete, assignee Ada (gid 1200000000000001), due 2026-11-02T09:00:00.000Z",
        "- Task 2 (gid 1300000000000002): completed",
        "cursor: eyJvZmZzZXQiOjJ9",
      ].join("\n"),
    );
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}`)[0].query, { opt_fields: "workspace" });
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}/tasks`)[0].query, {
      opt_fields: SUMMARY_FIELDS,
      limit: "2",
      offset: "abc",
    });
  });

  it("lists a section's incomplete tasks, 50 by default, once its project is in the workspace", async () => {
    fake.routes = {
      ...projectRoute(),
      [`GET /sections/${SECTION_GID}`]: dataReply({ gid: SECTION_GID, project: { gid: PROJECT_GID } }),
      [`GET /sections/${SECTION_GID}/tasks`]: pageReply([]),
    };
    assert.equal(
      await listTasks(context, { section_gid: SECTION_GID, incomplete_only: true }),
      `tasks in section ${SECTION_GID}: no tasks`,
    );
    assert.deepEqual(fake.requestsTo("GET", `/sections/${SECTION_GID}`)[0].query, { opt_fields: "project" });
    const { query } = fake.requestsTo("GET", `/sections/${SECTION_GID}/tasks`)[0];
    assert.equal(query.limit, "50");
    assert.equal(query.completed_since, "now");
  });

  it("filters completed subtasks locally, since Asana cannot", async () => {
    fake.routes = {
      [`GET /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID, workspace: IN_WORKSPACE }),
      [`GET /tasks/${TASK_GID}/subtasks`]: pageReply(
        [summary("1300000000000005"), summary("1300000000000006", { completed: true })],
        "next",
      ),
    };
    assert.equal(
      await listTasks(context, { parent_gid: TASK_GID, incomplete_only: true }),
      `subtasks of task ${TASK_GID}:\n- Task 5 (gid 1300000000000005): incomplete\ncursor: next`,
    );
    assert.equal(fake.requestsTo("GET", `/tasks/${TASK_GID}/subtasks`)[0].query.completed_since, undefined);
    fake.routes[`GET /tasks/${TASK_GID}/subtasks`] = pageReply([summary("1300000000000006", { completed: true })], "next");
    assert.equal(
      await listTasks(context, { parent_gid: TASK_GID, incomplete_only: true }),
      `subtasks of task ${TASK_GID}: none on this page\ncursor: next`,
    );
  });

  it("refuses zero or several scopes before calling Asana", async () => {
    for (const input of [{}, { project_gid: PROJECT_GID, parent_gid: TASK_GID }]) {
      await assert.rejects(listTasks(context, input), /pass exactly one of/);
    }
    assert.deepEqual(fake.requests, []);
  });

  it("refuses a scope outside the workspace before listing it", async () => {
    const section = (project?: unknown) => ({
      [`GET /sections/${SECTION_GID}`]: dataReply({ gid: SECTION_GID, project }),
    });
    const parent = { [`GET /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID, workspace: ELSEWHERE }) };
    for (const [routes, input, what] of [
      [projectRoute(ELSEWHERE), { project_gid: PROJECT_GID }, `project ${PROJECT_GID}`],
      [
        { ...projectRoute(ELSEWHERE), ...section({ gid: PROJECT_GID }) },
        { section_gid: SECTION_GID },
        `section ${SECTION_GID}`,
      ],
      [section(), { section_gid: SECTION_GID }, `section ${SECTION_GID}`],
      [parent, { parent_gid: TASK_GID }, `task ${TASK_GID}`],
    ] as const) {
      fake.requests.length = 0;
      fake.routes = routes;
      await assert.rejects(listTasks(context, input), {
        message: `${what} is not in workspace Acme (gid ${WORKSPACE.gid}).`,
      });
      assert.ok(!fake.requests.some((request) => request.path.endsWith("tasks")), what);
    }
  });

  it("refuses the whole page if any task is outside the workspace, without naming it", async () => {
    fake.routes = {
      ...projectRoute(),
      [`GET /projects/${PROJECT_GID}/tasks`]: pageReply([
        summary("1300000000000001"),
        summary("1300000000000002", { workspace: ELSEWHERE, completed: true }),
      ]),
    };
    await assert.rejects(listTasks(context, { project_gid: PROJECT_GID, incomplete_only: true }), {
      message: `a task in project ${PROJECT_GID} is not in workspace Acme (gid ${WORKSPACE.gid}).`,
    });
  });

  it("rejects a malformed list reply", async () => {
    for (const [reply, problem] of [
      [pageReply([{ name: "x" }]), "an item without a gid"],
      [pageReply([summary("1300000000000001")], "bad offset!"), "next page was malformed"],
      [dataReply(summary("1300000000000001")), "no data"],
    ] as const) {
      fake.routes = { ...projectRoute(), [`GET /projects/${PROJECT_GID}/tasks`]: reply };
      await assert.rejects(listTasks(context, { project_gid: PROJECT_GID }), { message: new RegExp(`${problem}$`) });
    }
  });
});

describe("search_tasks", () => {
  const SEARCH = `GET /workspaces/${WORKSPACE.gid}/tasks/search`;

  it("searches the pinned workspace newest first and says when the page is full", async () => {
    fake.routes = { [SEARCH]: pageReply([summary("1300000000000001"), summary("1300000000000002")]) };
    const result = await searchTasks(context, {
      text: "launch",
      assignee: "me",
      section_gid: SECTION_GID,
      tag_gid: "1700000000000001",
      completed: false,
      due_on_after: "2026-11-01",
      due_on_before: "2026-12-01",
      limit: 2,
    });
    assert.match(
      result,
      /^matching tasks, newest first:\n- Task 1 .*\n- Task 2 .*\nmore may match: narrow the search$/,
    );
    assert.deepEqual(fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}/tasks/search`)[0].query, {
      opt_fields: SUMMARY_FIELDS,
      limit: "2",
      sort_by: "created_at",
      sort_ascending: "false",
      text: "launch",
      "assignee.any": "me",
      "sections.any": SECTION_GID,
      "tags.any": "1700000000000001",
      completed: "false",
      "due_on.after": "2026-11-01",
      "due_on.before": "2026-12-01",
    });
  });

  it("sends a project filter, and says nothing more on a short page", async () => {
    fake.routes = { [SEARCH]: pageReply([summary("1300000000000001")]) };
    assert.doesNotMatch(await searchTasks(context, { project_gid: PROJECT_GID }), /more may match/);
    assert.equal(
      fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}/tasks/search`)[0].query["projects.any"],
      PROJECT_GID,
    );
  });

  it("refuses a project and a section together, since Asana would join their tasks", async () => {
    await assert.rejects(searchTasks(context, { project_gid: PROJECT_GID, section_gid: SECTION_GID }), /not both/);
    assert.deepEqual(fake.requests, []);
  });

  it("refuses a result outside the workspace", async () => {
    fake.routes = { [SEARCH]: pageReply([summary("1300000000000001", { workspace: ELSEWHERE })]) };
    await assert.rejects(searchTasks(context, {}), /a task in the search is not in workspace Acme/);
  });

  it("adds a Premium hint to a 402", async () => {
    fake.routes = { [SEARCH]: errorReply(402, "Payment Required") };
    await assert.rejects(searchTasks(context, { text: "x" }), {
      message: "searching tasks: Asana answered 402: Payment Required. Task search needs Asana Premium.",
    });
  });
});
