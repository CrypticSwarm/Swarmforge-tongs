import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { getTask, type Context } from "../src/server.js";
import { FakeAsana, WORKSPACE, dataReply } from "./fakes.js";

const TASK_GID = "1300000000000001";
const PROJECT_GID = "1400000000000001";
const SECTION_GID = "1500000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid, resource_type: "workspace" };
const ELSEWHERE = { gid: "1100000000000999", resource_type: "workspace" };
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
    { gid: "1600000000000001", name: "Priority", display_value: "High" },
    { gid: "1600000000000002", name: "Estimate", display_value: "" },
  ],
  memberships: [{ project: { gid: PROJECT_GID, name: "Launch" }, section: { gid: SECTION_GID, name: "Doing" } }],
  parent: { gid: "1300000000000002", name: "Epic" },
  dependencies: [{ gid: "1300000000000003", name: "Design" }],
  dependents: [],
  num_subtasks: 2,
};

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
        "  Priority (gid 1600000000000001): High",
        "  Estimate (gid 1600000000000002): not set",
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
      "approval_status,assignee.name,completed,completed_at,custom_fields.display_value,custom_fields.name," +
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
