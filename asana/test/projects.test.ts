import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { findProjects, getProject, type Context } from "../src/server.js";
import { FakeAsana, USER, WORKSPACE, dataReply, pageReply, typeaheadRoute } from "./fakes.js";

const PROJECT_GID = "1400000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid, resource_type: "workspace" };
const ELSEWHERE = { gid: "1100000000000999", resource_type: "workspace" };
const TEAM = { gid: "1800000000000001", name: "Platform" };
const PROJECT_ROUTE = `GET /projects/${PROJECT_GID}`;
const SECTIONS_ROUTE = `GET /projects/${PROJECT_GID}/sections`;
const TYPEAHEAD_ROUTE = `GET /workspaces/${WORKSPACE.gid}/typeahead`;

const FULL_PROJECT = {
  gid: PROJECT_GID,
  name: "Launch",
  workspace: IN_WORKSPACE,
  permalink_url: "https://app.asana.com/0/1400000000000001",
  archived: false,
  completed: false,
  owner: { gid: USER.gid, name: USER.name },
  team: TEAM,
  start_on: "2026-10-01",
  due_on: "2026-12-01",
  notes: "goal one\nteam: forged",
  custom_field_settings: [
    {
      gid: "1610000000000001",
      custom_field: {
        gid: "1600000000000001",
        name: "Priority",
        resource_subtype: "enum",
        enum_options: [
          { gid: "1620000000000001", name: "High", enabled: true },
          { gid: "1620000000000002", name: "Old", enabled: false },
          { gid: "1620000000000003", name: "Unflagged" },
          { name: "no gid" },
        ],
      },
    },
    {
      gid: "1610000000000002",
      custom_field: { gid: "1600000000000002", name: "Estimate", resource_subtype: "number" },
    },
    { gid: "1610000000000003", custom_field: { gid: "1600000000000003", name: "Mystery" } },
    { gid: "1610000000000004" },
  ],
};

function projectSummary(gid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name: `Project ${gid.slice(-1)}`, archived: false, workspace: IN_WORKSPACE, ...extra };
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

describe("get_project", () => {
  it("renders details, sections, and custom fields with their enum options", async () => {
    fake.routes = {
      [PROJECT_ROUTE]: dataReply(FULL_PROJECT),
      [SECTIONS_ROUTE]: pageReply([{ gid: "1500000000000001", name: "Inbox" }], "next"),
    };
    assert.equal(
      await getProject(context, { project_gid: PROJECT_GID }),
      [
        "project: Launch (gid 1400000000000001)",
        "url: https://app.asana.com/0/1400000000000001",
        "archived: no",
        "completed: no",
        "owner: Ada Lovelace (gid 1200000000000001)",
        "team: Platform (gid 1800000000000001)",
        "start: 2026-10-01",
        "due: 2026-12-01",
        "sections:",
        "  Inbox (gid 1500000000000001)",
        "  more sections not shown",
        "custom fields:",
        "  Priority (gid 1600000000000001): enum",
        "    High (gid 1620000000000001)",
        "    Old (gid 1620000000000002), disabled",
        "    Unflagged (gid 1620000000000003)",
        "  Estimate (gid 1600000000000002): number",
        "  Mystery (gid 1600000000000003): unknown type",
        "notes:",
        "  goal one",
        "  team: forged",
      ].join("\n"),
    );
    assert.equal(
      fake.requestsTo("GET", `/projects/${PROJECT_GID}`)[0].query.opt_fields.split(",").sort().join(","),
      "archived,completed,custom_field_settings.custom_field.enum_options.enabled," +
        "custom_field_settings.custom_field.enum_options.name,custom_field_settings.custom_field.name," +
        "custom_field_settings.custom_field.resource_subtype,due_on,name,notes,owner.name,permalink_url,start_on," +
        "team.name,workspace",
    );
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}/sections`)[0].query, {
      opt_fields: "name",
      limit: "100",
    });
  });

  it("says none for what a bare project lacks", async () => {
    fake.routes = {
      [PROJECT_ROUTE]: dataReply({ gid: PROJECT_GID, name: "Bare", workspace: IN_WORKSPACE, archived: true }),
      [SECTIONS_ROUTE]: pageReply([]),
    };
    assert.equal(
      await getProject(context, { project_gid: PROJECT_GID }),
      [
        "project: Bare (gid 1400000000000001)",
        "url: none",
        "archived: yes",
        "completed: no",
        "owner: none",
        "team: none",
        "due: none",
        "sections: none",
        "custom fields: none",
        "notes: none",
      ].join("\n"),
    );
  });

  it("refuses a project outside the workspace before reading its sections", async () => {
    for (const workspace of [ELSEWHERE, undefined]) {
      fake.routes = { [PROJECT_ROUTE]: dataReply({ ...FULL_PROJECT, workspace }) };
      await assert.rejects(getProject(context, { project_gid: PROJECT_GID }), {
        message: `project ${PROJECT_GID} is not in workspace Acme (gid ${WORKSPACE.gid}).`,
      });
    }
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}/sections`), []);
  });
});

describe("find_projects", () => {
  it("asks typeahead for projects in the pinned workspace and says when the page is full", async () => {
    fake.routes = {
      [TYPEAHEAD_ROUTE]: typeaheadRoute("project", [
        projectSummary("1400000000000001", { team: TEAM }),
        projectSummary("1400000000000002", { archived: true }),
      ]),
    };
    assert.equal(
      await findProjects(context, { query: "launch", limit: 2 }),
      [
        "matching projects, most recently used first:",
        "- Project 1 (gid 1400000000000001), team Platform (gid 1800000000000001)",
        "- Project 2 (gid 1400000000000002), archived",
        "more may match: narrow the query",
      ].join("\n"),
    );
    assert.deepEqual(fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}/typeahead`)[0].query, {
      resource_type: "project",
      query: "launch",
      count: "2",
      opt_fields: "name,archived,team.name,workspace",
    });
  });

  it("asks for 50 by default and says none when nothing matches", async () => {
    fake.routes = { [TYPEAHEAD_ROUTE]: typeaheadRoute("project", []) };
    assert.equal(await findProjects(context, { query: "x" }), "matching projects, most recently used first: none");
    assert.equal(fake.requestsTo("GET", `/workspaces/${WORKSPACE.gid}/typeahead`)[0].query.count, "50");
  });

  it("refuses the page if any result is outside the workspace, or in none", async () => {
    for (const workspace of [ELSEWHERE, undefined]) {
      const projects = [projectSummary("1400000000000001"), projectSummary("1400000000000002", { workspace })];
      fake.routes = { [TYPEAHEAD_ROUTE]: typeaheadRoute("project", projects) };
      await assert.rejects(findProjects(context, { query: "x" }), {
        message: `a matching project is not in workspace Acme (gid ${WORKSPACE.gid}).`,
      });
    }
  });
});
