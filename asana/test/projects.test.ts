import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { findProjects, getProject, updateProject, type Context } from "../src/server.js";
import { FakeAsana, USER, WORKSPACE, dataReply, errorReply, meRoute, pageReply, typeaheadRoute } from "./fakes.js";

const PROJECT_GID = "1400000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid, resource_type: "workspace" };
const ELSEWHERE = { gid: "1100000000000999", resource_type: "workspace" };
const TEAM = { gid: "1800000000000001", name: "Platform" };
const PROJECT_ROUTE = `GET /projects/${PROJECT_GID}`;
const SECTIONS_ROUTE = `GET /projects/${PROJECT_GID}/sections`;
const PORTFOLIOS_ROUTE = `GET /projects/${PROJECT_GID}/project_portfolio_settings`;
const GOALS_ROUTE = "GET /goals";
const PORTFOLIO = { gid: "2100000000000001", name: "Roadmap" };
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
      custom_field: { gid: "1600000000000002", name: "Estimate", resource_subtype: "number", is_formula_field: true },
    },
    { gid: "1610000000000003", custom_field: { gid: "1600000000000003", name: "Mystery" } },
    { gid: "1610000000000004" },
  ],
  custom_fields: [
    {
      gid: "1600000000000011",
      name: "Health",
      resource_subtype: "enum",
      enum_value: { gid: "1620000000000011", name: "Green" },
    },
    { gid: "1600000000000012", name: "Budget", resource_subtype: "number", number_value: null },
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
  it("renders details, sections, portfolios, goals, and custom fields with their enum options", async () => {
    fake.routes = {
      [PROJECT_ROUTE]: dataReply(FULL_PROJECT),
      [SECTIONS_ROUTE]: pageReply([{ gid: "1500000000000001", name: "Inbox" }], "next"),
      [PORTFOLIOS_ROUTE]: pageReply([{ gid: "2200000000000001", portfolio: PORTFOLIO }, { gid: "2200000000000002" }]),
      [GOALS_ROUTE]: pageReply([{ gid: "2400000000000001", name: "Grow" }], "next"),
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
        "portfolios:",
        "  Roadmap (gid 2100000000000001)",
        "goals:",
        "  Grow (gid 2400000000000001)",
        "  more goals not shown",
        "custom fields:",
        "  Priority (gid 1600000000000001): enum",
        "    High (gid 1620000000000001)",
        "    Old (gid 1620000000000002), disabled",
        "    Unflagged (gid 1620000000000003)",
        "  Estimate (gid 1600000000000002): number, read-only",
        "  Mystery (gid 1600000000000003): unknown type",
        "custom field values:",
        "  Health (gid 1600000000000011), enum: Green (gid 1620000000000011)",
        "  Budget (gid 1600000000000012), number: not set",
        "notes:",
        "  goal one",
        "  team: forged",
      ].join("\n"),
    );
    assert.equal(
      fake.requestsTo("GET", `/projects/${PROJECT_GID}`)[0].query.opt_fields.split(",").sort().join(","),
      "archived,completed,custom_field_settings.custom_field.enum_options.enabled," +
        "custom_field_settings.custom_field.enum_options.name,custom_field_settings.custom_field.is_formula_field," +
        "custom_field_settings.custom_field.is_value_read_only,custom_field_settings.custom_field.name," +
        "custom_field_settings.custom_field.resource_subtype,custom_fields.date_value,custom_fields.display_value," +
        "custom_fields.enum_value.name,custom_fields.multi_enum_values.name,custom_fields.name," +
        "custom_fields.number_value,custom_fields.people_value.name,custom_fields.resource_subtype," +
        "custom_fields.text_value,due_on,name,notes,owner.name,permalink_url,start_on,team.name,workspace",
    );
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}/sections`)[0].query, {
      opt_fields: "name",
      limit: "100",
    });
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}/project_portfolio_settings`)[0].query, {
      opt_fields: "portfolio.name",
      limit: "100",
    });
    assert.deepEqual(fake.requestsTo("GET", "/goals")[0].query, {
      project: PROJECT_GID,
      opt_fields: "name",
      limit: "100",
    });
  });

  it("says none for what a bare project lacks", async () => {
    fake.routes = {
      [PROJECT_ROUTE]: dataReply({ gid: PROJECT_GID, name: "Bare", workspace: IN_WORKSPACE, archived: true }),
      [SECTIONS_ROUTE]: pageReply([]),
      [PORTFOLIOS_ROUTE]: pageReply([]),
      [GOALS_ROUTE]: pageReply([]),
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
        "portfolios: none",
        "goals: none",
        "custom fields: none",
        "custom field values: none",
        "notes: none",
      ].join("\n"),
    );
  });

  it("says when Asana fails to list portfolios or goals, and notes a second page", async () => {
    fake.routes = {
      [PROJECT_ROUTE]: dataReply({ gid: PROJECT_GID, name: "Bare", workspace: IN_WORKSPACE }),
      [SECTIONS_ROUTE]: pageReply([]),
    };
    for (const status of [402, 403, 500]) {
      fake.routes[PORTFOLIOS_ROUTE] = errorReply(status, "No portfolios");
      fake.routes[GOALS_ROUTE] = errorReply(status, "No goals");
      const result = await getProject(context, { project_gid: PROJECT_GID });
      for (const [title, reason] of [
        ["portfolios", `listing project ${PROJECT_GID}'s portfolios: Asana answered ${status}: No portfolios`],
        ["goals", `listing project ${PROJECT_GID}'s goals: Asana answered ${status}: No goals`],
      ]) {
        assert.ok(result.includes(`\n${title}: not available (${reason})\n`), result);
      }
    }
    const forged = { ...PORTFOLIO, name: "Roadmap\nnotes: forged" };
    fake.routes[PORTFOLIOS_ROUTE] = pageReply([{ gid: "2200000000000001", portfolio: forged }], "next");
    assert.match(
      await getProject(context, { project_gid: PROJECT_GID }),
      /\nportfolios:\n {2}Roadmap notes: forged \(gid 2100000000000001\)\n {2}more portfolios not shown\n/,
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
    assert.deepEqual(fake.requestsTo("GET", `/projects/${PROJECT_GID}/project_portfolio_settings`), []);
    assert.deepEqual(fake.requestsTo("GET", "/goals"), []);
  });
});

describe("update_project", () => {
  const OWN_FIELDS =
    "name,workspace,custom_fields.name,custom_fields.resource_subtype,custom_fields.is_formula_field," +
    "custom_fields.is_value_read_only,custom_fields.enum_options.name,custom_fields.enum_options.enabled";
  const HEALTH = {
    gid: "1600000000000011",
    name: "Health",
    resource_subtype: "enum",
    enum_options: [{ gid: "1620000000000011", name: "Green", enabled: true }],
  };
  const LEADS = { gid: "1600000000000013", name: "Leads", resource_subtype: "people" };
  const COLLEAGUE = "1200000000000009";
  const target = (workspace: unknown = IN_WORKSPACE) =>
    dataReply({ gid: PROJECT_GID, name: "Launch", workspace, custom_fields: [HEALTH, LEADS] });

  it("resolves values against the project's own fields and people in the workspace, then writes them", async () => {
    fake.routes = {
      ...meRoute(),
      [PROJECT_ROUTE]: target(),
      [`GET /users/${COLLEAGUE}`]: dataReply({ gid: COLLEAGUE, workspaces: [IN_WORKSPACE] }),
      [`PUT /projects/${PROJECT_GID}`]: dataReply({
        gid: PROJECT_GID,
        name: "Launch",
        custom_fields: [
          { ...HEALTH, enum_value: { gid: "1620000000000011", name: "Green" } },
          { ...LEADS, people_value: [{ gid: USER.gid, name: USER.name }, { gid: COLLEAGUE, name: "Bo" }] },
        ],
      }),
    };
    const customFields = { Health: "Green", Leads: ["me", COLLEAGUE] };
    assert.equal(
      await updateProject(context, { project_gid: PROJECT_GID, custom_fields: customFields }),
      [
        "updated project: Launch (gid 1400000000000001)",
        "custom field Health (gid 1600000000000011), enum: Green (gid 1620000000000011)",
        "custom field Leads (gid 1600000000000013), people: Ada Lovelace (gid 1200000000000001), " +
          "Bo (gid 1200000000000009)",
      ].join("\n"),
    );
    assert.equal(fake.requestsTo("GET", `/projects/${PROJECT_GID}`)[0].query.opt_fields, OWN_FIELDS);
    const [put] = fake.requestsTo("PUT", `/projects/${PROJECT_GID}`);
    assert.deepEqual(put.body, {
      data: { custom_fields: { [HEALTH.gid]: "1620000000000011", [LEADS.gid]: [USER.gid, COLLEAGUE] } },
    });
    assert.equal(
      put.query.opt_fields,
      "name,custom_fields.name,custom_fields.resource_subtype,custom_fields.display_value," +
        "custom_fields.enum_value.name,custom_fields.multi_enum_values.name,custom_fields.number_value," +
        "custom_fields.text_value,custom_fields.date_value,custom_fields.people_value.name",
    );
  });

  it("refuses a project outside the workspace, an unknown field, or a person elsewhere, without writing", async () => {
    fake.routes = { [PROJECT_ROUTE]: target(ELSEWHERE) };
    await assert.rejects(updateProject(context, { project_gid: PROJECT_GID, custom_fields: { Health: "Green" } }), {
      message: `project ${PROJECT_GID} is not in workspace Acme (gid ${WORKSPACE.gid}).`,
    });
    fake.routes = { [PROJECT_ROUTE]: target() };
    await assert.rejects(updateProject(context, { project_gid: PROJECT_GID, custom_fields: { Budget: 1 } }), {
      message: `project ${PROJECT_GID} has no custom field "Budget"; its custom fields are "Health", "Leads".`,
    });
    fake.routes[`GET /users/${COLLEAGUE}`] = dataReply({ gid: COLLEAGUE, workspaces: [ELSEWHERE] });
    await assert.rejects(updateProject(context, { project_gid: PROJECT_GID, custom_fields: { Leads: [COLLEAGUE] } }), {
      message: `user ${COLLEAGUE} is not in workspace Acme (gid ${WORKSPACE.gid}).`,
    });
    assert.ok(fake.requests.every((request) => request.method === "GET"));
  });

  it("says a 5xx may have landed, and a 4xx did not", async () => {
    fake.routes = { [PROJECT_ROUTE]: target(), [`PUT /projects/${PROJECT_GID}`]: errorReply(500, "boom") };
    await assert.rejects(
      updateProject(context, { project_gid: PROJECT_GID, custom_fields: { Health: null } }),
      /boom\n\nThe write may have gone through; get_project shows whether it did\.$/,
    );
    assert.deepEqual(fake.requestsTo("PUT", `/projects/${PROJECT_GID}`)[0].body, {
      data: { custom_fields: { [HEALTH.gid]: null } },
    });
    fake.routes[`PUT /projects/${PROJECT_GID}`] = errorReply(400, "custom_fields: Invalid");
    await assert.rejects(
      updateProject(context, { project_gid: PROJECT_GID, custom_fields: { Health: null } }),
      (err: Error) => /Invalid$/.test(err.message),
    );
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
