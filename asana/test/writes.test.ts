import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createTask, deleteTask, updateTask, type Context } from "../src/server.js";
import { FakeAsana, USER, WORKSPACE, dataReply, errorReply, meRoute, unreachableClient, type Routes } from "./fakes.js";

const TASK_GID = "1300000000000001";
const PARENT_GID = "1300000000000002";
const PROJECT_GID = "1400000000000001";
const SECTION_GID = "1500000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid };
const ELSEWHERE = { gid: "1100000000000999" };
const USER_GID = "1200000000000009";
const NOT_PINNED = `is not in workspace Acme (gid ${WORKSPACE.gid}).`;
const TARGET_FIELDS = "name,workspace,memberships.project";
const GET_TASK_HINT = "\n\nThe write may have gone through; get_task shows whether it did.";

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

describe("update_task", () => {
  it("sends only the given fields, null clearing, and reports each new value", async () => {
    fake.routes = {
      ...taskRoute(TASK_GID),
      [`PUT /tasks/${TASK_GID}`]: dataReply({
        gid: TASK_GID,
        name: "Renamed",
        completed: true,
        resource_subtype: "milestone",
      }),
    };
    const result = await updateTask(context, {
      task_gid: TASK_GID,
      name: "Renamed",
      resource_subtype: "milestone",
      notes: null,
      assignee: null,
      due_on: null,
      start_on: null,
      completed: true,
    });
    assert.equal(
      result,
      [
        "updated task: Renamed (gid 1300000000000001)",
        "name: Renamed",
        "description: cleared",
        "assignee: none",
        "due: none",
        "start: none",
        "type: milestone",
        "completed: yes",
      ].join("\n"),
    );
    assert.deepEqual(fake.requestsTo("PUT", `/tasks/${TASK_GID}`)[0].body, {
      data: {
        name: "Renamed",
        notes: "",
        resource_subtype: "milestone",
        assignee: null,
        due_on: null,
        start_on: null,
        completed: true,
      },
    });
    assert.deepEqual(fake.requestsTo("GET", `/tasks/${TASK_GID}`)[0].query, { opt_fields: TARGET_FIELDS });
  });

  it("reports an approval status with the completion Asana derived", async () => {
    fake.routes = {
      ...taskRoute(TASK_GID),
      ...userRoute(),
      [`PUT /tasks/${TASK_GID}`]: dataReply({
        gid: TASK_GID,
        name: "Review",
        completed: true,
        resource_subtype: "approval",
        approval_status: "rejected",
        html_notes: "<body>x</body>",
        notes: "x",
        assignee: { gid: USER_GID, name: "Grace" },
      }),
    };
    assert.equal(
      await updateTask(context, {
        task_gid: TASK_GID,
        approval_status: "rejected",
        html_notes: "<body>x</body>",
        assignee: USER_GID,
      }),
      [
        "updated task: Review (gid 1300000000000001)",
        "description: replaced",
        `assignee: Grace (gid ${USER_GID})`,
        "approval status: rejected, completed: yes",
      ].join("\n"),
    );
  });

  it("refuses an empty update or a conflicting pair before calling Asana", async () => {
    await assert.rejects(updateTask(context, { task_gid: TASK_GID }), {
      message: "pass at least one change.",
    });
    await assert.rejects(updateTask(context, { task_gid: TASK_GID, approval_status: "approved", completed: true }), {
      message: "pass 'approval_status' or 'completed', not both: Asana sets 'completed' from 'approval_status'.",
    });
    await assert.rejects(updateTask(context, { task_gid: TASK_GID, due_on: null, due_at: "2026-11-20T17:00:00Z" }), {
      message: "pass 'due_on' or 'due_at', not both.",
    });
    assert.deepEqual(fake.requests, []);
  });

  it("refuses a task or an assignee outside the pinned workspace before writing", async () => {
    for (const workspace of [ELSEWHERE, null]) {
      fake.routes = { ...taskRoute(TASK_GID, workspace), [`PUT /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID }) };
      await assert.rejects(updateTask(context, { task_gid: TASK_GID, completed: true }), {
        message: `task ${TASK_GID} ${NOT_PINNED}`,
      });
    }
    fake.routes = {
      ...taskRoute(TASK_GID),
      ...userRoute([]),
      [`PUT /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID }),
    };
    await assert.rejects(updateTask(context, { task_gid: TASK_GID, assignee: USER_GID }), {
      message: `user ${USER_GID} ${NOT_PINNED}`,
    });
    assert.deepEqual(writes(), []);
  });

  it("says an update may have gone through when the answer is a 5xx or unreadable", async () => {
    for (const [reply, message] of [
      [errorReply(503, "Service Unavailable"), /^Asana answered 503: Service Unavailable$/],
      [dataReply({}), /^Asana's answer had no gid$/],
      [{ text: "<html>ok</html>" }, /^Asana answered 200: /],
    ] as const) {
      fake.routes = { ...taskRoute(TASK_GID), [`PUT /tasks/${TASK_GID}`]: reply };
      await assert.rejects(updateTask(context, { task_gid: TASK_GID, name: "x" }), (err: Error) => {
        const [first, ...rest] = err.message.split("\n\n");
        assert.match(first.replace(`updating task ${TASK_GID}: `, ""), message);
        assert.equal(`\n\n${rest.join("\n\n")}`, GET_TASK_HINT);
        return true;
      });
    }
  });
});

describe("delete_task", () => {
  it("deletes a task in the pinned workspace and says it went to the trash", async () => {
    fake.routes = { ...taskRoute(TASK_GID), [`DELETE /tasks/${TASK_GID}`]: dataReply({}) };
    assert.equal(
      await deleteTask(context, { task_gid: TASK_GID }),
      `deleted task ${TASK_GID}: it is in the token user's Asana trash, restorable for 30 days.`,
    );
    assert.equal(fake.requestsTo("DELETE", `/tasks/${TASK_GID}`).length, 1);
  });

  it("refuses a task outside the pinned workspace before deleting", async () => {
    fake.routes = { ...taskRoute(TASK_GID, ELSEWHERE), [`DELETE /tasks/${TASK_GID}`]: dataReply({}) };
    await assert.rejects(deleteTask(context, { task_gid: TASK_GID }), { message: `task ${TASK_GID} ${NOT_PINNED}` });
    assert.deepEqual(writes(), []);
  });

  it("passes a 404 through, and hints only on a 5xx", async () => {
    fake.routes = { ...taskRoute(TASK_GID), [`DELETE /tasks/${TASK_GID}`]: errorReply(404, "Not Found") };
    await assert.rejects(deleteTask(context, { task_gid: TASK_GID }), {
      message: `deleting task ${TASK_GID}: Asana answered 404: Not Found`,
    });
    fake.routes[`DELETE /tasks/${TASK_GID}`] = errorReply(500, "Server Error");
    await assert.rejects(deleteTask(context, { task_gid: TASK_GID }), {
      message: `deleting task ${TASK_GID}: Asana answered 500: Server Error${GET_TASK_HINT}`,
    });
  });

  it("does not hint when the workspace check cannot reach Asana", async () => {
    const unreachable = { ...context, asana: await unreachableClient() };
    await assert.rejects(deleteTask(unreachable, { task_gid: TASK_GID }), (err: Error) => {
      assert.match(err.message, /^reading task .*: cannot reach Asana/);
      assert.doesNotMatch(err.message, /gone through/);
      return true;
    });
  });
});

describe("custom_fields", () => {
  const PRIORITY = {
    gid: "1600000000000001",
    name: "Priority",
    resource_subtype: "enum",
    enum_options: [{ gid: "1610000000000001", name: "High", enabled: true }],
  };
  const REVIEWERS = { gid: "1600000000000002", name: "Reviewers", resource_subtype: "people" };
  const DUE = { gid: "1600000000000003", name: "Due", resource_subtype: "date" };
  const FIELD_OPTS = "name,resource_subtype,is_formula_field,is_value_read_only,enum_options.name,enum_options.enabled";
  const SET_PRIORITY = { ...PRIORITY, enum_value: { gid: "1610000000000001", name: "High" } };

  function projectFieldsRoute(workspace: unknown = IN_WORKSPACE): Routes {
    const custom_field_settings = [PRIORITY, REVIEWERS].map((field) => ({ custom_field: field }));
    return { [`GET /projects/${PROJECT_GID}`]: dataReply({ gid: PROJECT_GID, workspace, custom_field_settings }) };
  }

  function taskFieldsRoute(workspace: unknown = IN_WORKSPACE): Routes {
    const custom_fields = [PRIORITY, REVIEWERS, DUE];
    return { [`GET /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID, workspace, custom_fields }) };
  }

  it("creates a task with values resolved against the project's fields", async () => {
    fake.routes = { ...projectFieldsRoute(), ...userRoute(), ...meRoute(), "POST /tasks": dataReply(CREATED) };
    await createTask(context, {
      name: "A",
      project_gid: PROJECT_GID,
      custom_fields: { Priority: "High", Reviewers: ["me", USER_GID] },
    });
    const [read] = fake.requestsTo("GET", `/projects/${PROJECT_GID}`);
    const prefixed = FIELD_OPTS.split(",").map((field) => `custom_field_settings.custom_field.${field}`);
    assert.equal(read.query.opt_fields, ["workspace", ...prefixed].join(","));
    assert.deepEqual(fake.requestsTo("POST", "/tasks")[0].body, {
      data: {
        name: "A",
        custom_fields: { [PRIORITY.gid]: "1610000000000001", [REVIEWERS.gid]: [USER.gid, USER_GID] },
        workspace: WORKSPACE.gid,
        projects: [PROJECT_GID],
      },
    });
  });

  it("updates custom fields against the task's own and reports them by name", async () => {
    const answer = { gid: TASK_GID, name: "B", custom_fields: [SET_PRIORITY, { ...REVIEWERS, people_value: [] }] };
    fake.routes = { ...taskFieldsRoute(), [`PUT /tasks/${TASK_GID}`]: dataReply(answer) };
    const custom_fields = { Priority: "High", Reviewers: null, Due: "2026-11-20" };
    assert.equal(
      await updateTask(context, { task_gid: TASK_GID, name: "B", custom_fields }),
      [
        "updated task: B (gid 1300000000000001)",
        "name: B",
        "custom field Priority (gid 1600000000000001), enum: High (gid 1610000000000001)",
        "custom field Reviewers (gid 1600000000000002), people: not set",
        "custom field 1600000000000003: not in Asana's answer",
      ].join("\n"),
    );
    const [read] = fake.requestsTo("GET", `/tasks/${TASK_GID}`);
    const prefixed = FIELD_OPTS.split(",").map((field) => `custom_fields.${field}`);
    assert.equal(read.query.opt_fields, [TARGET_FIELDS, ...prefixed].join(","));
    assert.deepEqual(fake.requestsTo("PUT", `/tasks/${TASK_GID}`)[0].body, {
      data: {
        name: "B",
        custom_fields: { [PRIORITY.gid]: "1610000000000001", [REVIEWERS.gid]: null, [DUE.gid]: { date: "2026-11-20" } },
      },
    });
  });

  it("writes nothing when a field, a person, or the placement is refused", async () => {
    for (const [routes, run, message] of [
      [
        projectFieldsRoute(),
        () => createTask(context, { name: "A", project_gid: PROJECT_GID, custom_fields: { Nope: 1 } }),
        `project ${PROJECT_GID} has no custom field "Nope"; its custom fields are "Priority", "Reviewers".`,
      ],
      [
        projectFieldsRoute(ELSEWHERE),
        () => createTask(context, { name: "A", project_gid: PROJECT_GID, custom_fields: { Nope: 1 } }),
        `project ${PROJECT_GID} ${NOT_PINNED}`,
      ],
      [
        taskRoute(PARENT_GID),
        () => createTask(context, { name: "A", parent_gid: PARENT_GID, custom_fields: { Priority: "High" } }),
        "pass 'project_gid' with 'custom_fields'.",
      ],
      [
        { ...projectFieldsRoute(), ...userRoute([ELSEWHERE]) },
        () => createTask(context, { name: "A", project_gid: PROJECT_GID, custom_fields: { Reviewers: [USER_GID] } }),
        `user ${USER_GID} ${NOT_PINNED}`,
      ],
      [
        { ...taskFieldsRoute(), ...userRoute([ELSEWHERE]) },
        () => updateTask(context, { task_gid: TASK_GID, custom_fields: { Priority: "High", Reviewers: [USER_GID] } }),
        `user ${USER_GID} ${NOT_PINNED}`,
      ],
      [
        taskFieldsRoute(ELSEWHERE),
        () => updateTask(context, { task_gid: TASK_GID, custom_fields: { Nope: 1 } }),
        `task ${TASK_GID} ${NOT_PINNED}`,
      ],
    ] as const) {
      fake.routes = { ...routes, "POST /tasks": dataReply(CREATED), [`PUT /tasks/${TASK_GID}`]: dataReply(CREATED) };
      await assert.rejects(run(), { message });
    }
    assert.deepEqual(writes(), []);
  });
});

describe("placement and parent", () => {
  const OTHER_PROJECT = "1400000000000002";
  const relationPath = (action: string) => `POST /tasks/${TASK_GID}/${action}`;

  function relationRoutes(projects = [OTHER_PROJECT]): Routes {
    const target = {
      gid: TASK_GID,
      name: "Ship it",
      workspace: IN_WORKSPACE,
      memberships: projects.map((gid) => ({ project: { gid } })),
    };
    return {
      [`GET /tasks/${TASK_GID}`]: dataReply(target),
      ...projectRoute(),
      [`GET /projects/${OTHER_PROJECT}`]: dataReply({ gid: OTHER_PROJECT, workspace: IN_WORKSPACE }),
      ...sectionRoute(),
      ...taskRoute(PARENT_GID),
      [`PUT /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID, name: "Shipped" }),
      [relationPath("addProject")]: dataReply({}),
      [relationPath("removeProject")]: dataReply({}),
      [relationPath("setParent")]: dataReply({ gid: TASK_GID, parent: { gid: PARENT_GID, name: "Epic" } }),
    };
  }

  const EVERY_RELATION = {
    task_gid: TASK_GID,
    move_to: { project_gid: PROJECT_GID, section_gid: SECTION_GID },
    remove_from_project: OTHER_PROJECT,
    parent_gid: PARENT_GID,
  };

  it("writes the fields, then each relationship in a fixed order, and reports each", async () => {
    fake.routes = relationRoutes();
    assert.equal(
      await updateTask(context, { ...EVERY_RELATION, name: "Shipped" }),
      [
        "updated task: Shipped (gid 1300000000000001)",
        "name: Shipped",
        `added to project ${PROJECT_GID}, section ${SECTION_GID}`,
        `removed from project ${OTHER_PROJECT}`,
        "parent: Epic (gid 1300000000000002)",
      ].join("\n"),
    );
    const sent = fake.requests.filter((request) => request.method !== "GET");
    assert.deepEqual(
      sent.map((request) => [`${request.method} ${request.path}`, request.body]),
      [
        [`PUT /tasks/${TASK_GID}`, { data: { name: "Shipped" } }],
        [relationPath("addProject"), { data: { project: PROJECT_GID, section: SECTION_GID } }],
        [relationPath("removeProject"), { data: { project: OTHER_PROJECT } }],
        [relationPath("setParent"), { data: { parent: PARENT_GID } }],
      ],
    );
    assert.equal(fake.requests.findIndex((request) => request.method !== "GET"), fake.requests.length - sent.length);
  });

  it("accepts one non-field change alone, a null parent, and a move within a project", async () => {
    fake.routes = { ...relationRoutes(), [relationPath("setParent")]: dataReply({ gid: TASK_GID, parent: null }) };
    assert.equal(
      await updateTask(context, { task_gid: TASK_GID, parent_gid: null }),
      `updated task: Ship it (gid ${TASK_GID})\nparent: none`,
    );
    assert.deepEqual(fake.requestsTo("POST", `/tasks/${TASK_GID}/setParent`)[0].body, { data: { parent: null } });
    await updateTask(context, { task_gid: TASK_GID, move_to: { project_gid: PROJECT_GID } });
    assert.deepEqual(fake.requestsTo("POST", `/tasks/${TASK_GID}/addProject`)[0].body, {
      data: { project: PROJECT_GID },
    });
    fake.routes = relationRoutes([PROJECT_GID]);
    const move_to = { project_gid: PROJECT_GID, section_gid: SECTION_GID };
    assert.equal(
      await updateTask(context, { task_gid: TASK_GID, move_to }),
      `updated task: Ship it (gid ${TASK_GID})\nmoved to section ${SECTION_GID} of project ${PROJECT_GID}`,
    );
  });

  it("refuses a self-reference or a contradiction before calling Asana", async () => {
    const cases: [Partial<Parameters<typeof updateTask>[1]>, string][] = [
      [{ parent_gid: TASK_GID }, "a task cannot be its own parent."],
      [
        { move_to: { project_gid: PROJECT_GID }, remove_from_project: PROJECT_GID },
        "pass 'move_to' or 'remove_from_project' for a project, not both.",
      ],
    ];
    for (const [input, message] of cases) {
      await assert.rejects(updateTask(context, { task_gid: TASK_GID, ...input }), { message });
    }
    assert.deepEqual(fake.requests, []);
  });

  it("refuses a change that does not match the task's placement before writing", async () => {
    const cases: [string[], Partial<Parameters<typeof updateTask>[1]>, string][] = [
      [
        [PROJECT_GID],
        { move_to: { project_gid: PROJECT_GID } },
        `task ${TASK_GID} is already in project ${PROJECT_GID}; pass a 'section_gid' to move it.`,
      ],
      [[], { remove_from_project: OTHER_PROJECT }, `task ${TASK_GID} is not in project ${OTHER_PROJECT}.`],
    ];
    for (const [projects, input, message] of cases) {
      fake.routes = relationRoutes(projects);
      await assert.rejects(updateTask(context, { task_gid: TASK_GID, ...input }), { message });
    }
    assert.deepEqual(writes(), []);
  });

  it("refuses the task or any project, section, or parent it names outside the workspace", async () => {
    const elsewhereTask = { [`GET /tasks/${TASK_GID}`]: dataReply({ gid: TASK_GID, workspace: ELSEWHERE }) };
    for (const [routes, input, message] of [
      [elsewhereTask, { parent_gid: null }, `task ${TASK_GID} ${NOT_PINNED}`],
      [projectRoute(ELSEWHERE), EVERY_RELATION, `project ${PROJECT_GID} ${NOT_PINNED}`],
      [sectionRoute(OTHER_PROJECT), EVERY_RELATION, `section ${SECTION_GID} is not in project ${PROJECT_GID}.`],
      [
        { [`GET /projects/${OTHER_PROJECT}`]: dataReply({ gid: OTHER_PROJECT, workspace: ELSEWHERE }) },
        EVERY_RELATION,
        `project ${OTHER_PROJECT} ${NOT_PINNED}`,
      ],
      [taskRoute(PARENT_GID, ELSEWHERE), EVERY_RELATION, `task ${PARENT_GID} ${NOT_PINNED}`],
      [taskRoute(PARENT_GID, null), EVERY_RELATION, `task ${PARENT_GID} ${NOT_PINNED}`],
    ] as const) {
      fake.routes = { ...relationRoutes(), ...routes };
      await assert.rejects(updateTask(context, { ...input, task_gid: TASK_GID, name: "x" }), { message });
    }
    assert.deepEqual(writes(), []);
  });

  it("says which changes landed and which were not sent when a later call fails", async () => {
    fake.routes = { ...relationRoutes(), [relationPath("removeProject")]: errorReply(503, "Service Unavailable") };
    await assert.rejects(updateTask(context, { ...EVERY_RELATION, name: "Shipped" }), {
      message: [
        `removing task ${TASK_GID} from project ${OTHER_PROJECT}: Asana answered 503: Service Unavailable`,
        "",
        "already changed:",
        "  name: Shipped",
        `  added to project ${PROJECT_GID}, section ${SECTION_GID}`,
        "not sent: parent_gid",
      ].join("\n") + GET_TASK_HINT,
    });
    assert.equal(fake.requestsTo("POST", `/tasks/${TASK_GID}/setParent`).length, 0);

    fake.routes = { ...relationRoutes(), [relationPath("setParent")]: { text: "<html>" } };
    const reparent = { task_gid: TASK_GID, name: "x", parent_gid: PARENT_GID };
    await assert.rejects(updateTask(context, reparent), (err: Error) => {
      assert.match(err.message, /^setting task \d+'s parent: Asana answered 200: /);
      assert.ok(err.message.endsWith(`\n\nalready changed:\n  name: Shipped\nnot sent: none${GET_TASK_HINT}`));
      return true;
    });

    fake.routes = { ...relationRoutes(), [relationPath("addProject")]: errorReply(400, "section: Not in project") };
    await assert.rejects(updateTask(context, { task_gid: TASK_GID, move_to: { project_gid: PROJECT_GID } }), {
      message: `placing task ${TASK_GID} in project ${PROJECT_GID}: Asana answered 400: section: Not in project`,
    });
    fake.routes = { ...relationRoutes(), [`PUT /tasks/${TASK_GID}`]: errorReply(403, "Forbidden") };
    await assert.rejects(updateTask(context, { task_gid: TASK_GID, name: "x", parent_gid: null }), {
      message:
        `updating task ${TASK_GID}: Asana answered 403: Forbidden\n\n` + "already changed: none\nnot sent: parent_gid",
    });
  });
});
