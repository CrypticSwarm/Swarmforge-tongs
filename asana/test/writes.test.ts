import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createTask, type Context } from "../src/server.js";
import { FakeAsana, WORKSPACE, dataReply, errorReply, unreachableClient, type Routes } from "./fakes.js";

const TASK_GID = "1300000000000001";
const PARENT_GID = "1300000000000002";
const PROJECT_GID = "1400000000000001";
const SECTION_GID = "1500000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid };
const ELSEWHERE = { gid: "1100000000000999" };
const USER_GID = "1200000000000009";
const NOT_PINNED = `is not in workspace Acme (gid ${WORKSPACE.gid}).`;

const CREATED = {
  gid: TASK_GID,
  name: "Ship it",
  workspace: IN_WORKSPACE,
  permalink_url: "https://app.asana.com/0/0/1300000000000001",
  memberships: [{ project: { gid: PROJECT_GID, name: "Launch" }, section: { gid: SECTION_GID, name: "Doing" } }],
  parent: { gid: PARENT_GID, name: "Epic" },
};

function projectRoute(workspace: unknown = IN_WORKSPACE): Routes {
  return { [`GET /projects/${PROJECT_GID}`]: dataReply({ gid: PROJECT_GID, workspace }) };
}

function sectionRoute(project = PROJECT_GID): Routes {
  return { [`GET /sections/${SECTION_GID}`]: dataReply({ gid: SECTION_GID, project: { gid: project } }) };
}

function taskRoute(gid: string, workspace: unknown = IN_WORKSPACE): Routes {
  return { [`GET /tasks/${gid}`]: dataReply({ gid, workspace }) };
}

function userRoute(workspaces: unknown[] = [IN_WORKSPACE]): Routes {
  return { [`GET /users/${USER_GID}`]: dataReply({ gid: USER_GID, workspaces }) };
}

function writes(): string[] {
  return fake.requests.filter((request) => request.method !== "GET").map((request) => request.method);
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

describe("create_task", () => {
  it("creates a subtask in a project's section, always in the pinned workspace", async () => {
    fake.routes = {
      ...projectRoute(),
      ...sectionRoute(),
      ...taskRoute(PARENT_GID),
      ...userRoute([ELSEWHERE, IN_WORKSPACE]),
      "POST /tasks": dataReply(CREATED),
    };
    const result = await createTask(context, {
      name: "Ship it",
      html_notes: "<body>Do <strong>it</strong></body>",
      assignee: USER_GID,
      due_at: "2026-11-20T17:00:00Z",
      start_on: "2026-11-18",
      resource_subtype: "milestone",
      project_gid: PROJECT_GID,
      section_gid: SECTION_GID,
      parent_gid: PARENT_GID,
    });
    assert.equal(
      result,
      [
        "created task: Ship it (gid 1300000000000001)",
        "url: https://app.asana.com/0/0/1300000000000001",
        "parent: Epic (gid 1300000000000002)",
        "projects:",
        "  Launch (gid 1400000000000001), section Doing (gid 1500000000000001)",
      ].join("\n"),
    );
    const [post] = fake.requestsTo("POST", "/tasks");
    assert.deepEqual(post.body, {
      data: {
        name: "Ship it",
        html_notes: "<body>Do <strong>it</strong></body>",
        assignee: USER_GID,
        due_at: "2026-11-20T17:00:00Z",
        start_on: "2026-11-18",
        resource_subtype: "milestone",
        workspace: WORKSPACE.gid,
        memberships: [{ project: PROJECT_GID, section: SECTION_GID }],
        parent: PARENT_GID,
      },
    });
    assert.match(post.query.opt_fields, /permalink_url/);
    assert.equal(fake.requests.at(-1), post);
  });

  it("adds a task to a project with no section, and a subtask to no project", async () => {
    fake.routes = { ...projectRoute(), ...taskRoute(PARENT_GID), "POST /tasks": dataReply({ gid: TASK_GID }) };
    await createTask(context, { name: "A", notes: "plain", project_gid: PROJECT_GID });
    await createTask(context, { name: "B", parent_gid: PARENT_GID, assignee: "me" });
    assert.deepEqual(
      fake.requestsTo("POST", "/tasks").map((request) => request.body),
      [
        { data: { name: "A", notes: "plain", workspace: WORKSPACE.gid, projects: [PROJECT_GID] } },
        { data: { name: "B", assignee: "me", workspace: WORKSPACE.gid, parent: PARENT_GID } },
      ],
    );
    assert.ok(!fake.requests.some((request) => request.path.startsWith("/users")));
  });

  it("refuses conflicting or missing placement and fields before calling Asana", async () => {
    for (const [input, message] of [
      [{ name: "A" }, "pass 'project_gid', 'parent_gid', or both."],
      [{ name: "A", parent_gid: PARENT_GID, section_gid: SECTION_GID }, "pass 'project_gid' with 'section_gid'."],
      [{ name: "A", project_gid: PROJECT_GID, notes: "a", html_notes: "<body>a</body>" }, /'notes' or 'html_notes'/],
      [{ name: "A", project_gid: PROJECT_GID, due_on: "2026-11-20", due_at: "2026-11-20T17:00:00Z" }, /'due_on'/],
    ] as const) {
      await assert.rejects(createTask(context, input), { message });
    }
    assert.deepEqual(fake.requests, []);
  });

  it("refuses a project, parent, or assignee outside the workspace, or a stray section, before writing", async () => {
    for (const [routes, input, message] of [
      [projectRoute(ELSEWHERE), { project_gid: PROJECT_GID }, `project ${PROJECT_GID} ${NOT_PINNED}`],
      [projectRoute(null), { project_gid: PROJECT_GID }, `project ${PROJECT_GID} ${NOT_PINNED}`],
      [
        { ...projectRoute(), ...sectionRoute("1400000000000999") },
        { project_gid: PROJECT_GID, section_gid: SECTION_GID },
        `section ${SECTION_GID} is not in project ${PROJECT_GID}.`,
      ],
      [taskRoute(PARENT_GID, ELSEWHERE), { parent_gid: PARENT_GID }, `task ${PARENT_GID} ${NOT_PINNED}`],
      [
        { ...projectRoute(), ...taskRoute(PARENT_GID, ELSEWHERE) },
        { project_gid: PROJECT_GID, parent_gid: PARENT_GID },
        `task ${PARENT_GID} ${NOT_PINNED}`,
      ],
      [
        { ...projectRoute(ELSEWHERE), ...taskRoute(PARENT_GID) },
        { project_gid: PROJECT_GID, parent_gid: PARENT_GID },
        `project ${PROJECT_GID} ${NOT_PINNED}`,
      ],
      [
        { ...projectRoute(), ...sectionRoute("1400000000000999"), ...taskRoute(PARENT_GID) },
        { project_gid: PROJECT_GID, section_gid: SECTION_GID, parent_gid: PARENT_GID },
        `section ${SECTION_GID} is not in project ${PROJECT_GID}.`,
      ],
      [
        { ...projectRoute(), ...userRoute([ELSEWHERE]) },
        { project_gid: PROJECT_GID, assignee: USER_GID },
        `user ${USER_GID} ${NOT_PINNED}`,
      ],
    ] as const) {
      fake.routes = { ...routes, "POST /tasks": dataReply(CREATED) };
      await assert.rejects(createTask(context, { name: "A", ...input }), { message });
    }
    assert.deepEqual(writes(), []);
  });

  it("says a create may have gone through only when Asana gave no clear refusal", async () => {
    fake.routes = { ...projectRoute(), "POST /tasks": errorReply(502, "Bad Gateway") };
    await assert.rejects(createTask(context, { name: "A", project_gid: PROJECT_GID }), {
      message:
        "creating a task: Asana answered 502: Bad Gateway\n\n" +
        "The write may have gone through; list_tasks shows whether it did.",
    });
    for (const [reply, message] of [
      [errorReply(400, "assignee: Not a recognized ID"), "Asana answered 400: assignee: Not a recognized ID"],
      [
        errorReply(429, "Too many requests", { "retry-after": "5" }),
        "Asana answered 429: Too many requests. Retry after 5 seconds.",
      ],
    ] as const) {
      fake.routes["POST /tasks"] = reply;
      await assert.rejects(createTask(context, { name: "A", project_gid: PROJECT_GID }), {
        message: `creating a task: ${message}`,
      });
    }
  });

  it("does not hint when a check before the create cannot reach Asana", async () => {
    const unreachable = { ...context, asana: await unreachableClient() };
    await assert.rejects(createTask(unreachable, { name: "A", project_gid: PROJECT_GID }), (err: Error) => {
      assert.match(err.message, /^reading project .*: cannot reach Asana/);
      assert.doesNotMatch(err.message, /gone through/);
      return true;
    });
  });
});
