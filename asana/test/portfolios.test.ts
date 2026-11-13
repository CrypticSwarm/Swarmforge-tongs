import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { addToPortfolio, getPortfolio, listPortfolios, removeFromPortfolio, type Context } from "../src/server.js";
import { FakeAsana, USER, WORKSPACE, dataReply, errorReply, pageReply, type Routes } from "./fakes.js";

const PORTFOLIO_GID = "2100000000000001";
const PROJECT_GID = "1400000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid };
const ELSEWHERE = { gid: "1100000000000999" };
const NOT_PINNED = `is not in workspace Acme (gid ${WORKSPACE.gid}).`;
const PORTFOLIO_PATH = `/portfolios/${PORTFOLIO_GID}`;
const ITEMS_PATH = `${PORTFOLIO_PATH}/items`;
const CUSTOM_FIELD_VALUES =
  "custom_fields.name,custom_fields.resource_subtype,custom_fields.display_value,custom_fields.enum_value.name," +
  "custom_fields.multi_enum_values.name,custom_fields.number_value,custom_fields.text_value," +
  "custom_fields.date_value,custom_fields.people_value.name";

const HEALTH = {
  gid: "1600000000000011",
  name: "Health",
  resource_subtype: "enum",
  enum_options: [
    { gid: "1620000000000011", name: "Green", enabled: true },
    { gid: "1620000000000012", name: "Red", enabled: false },
  ],
};

const FULL_PORTFOLIO = {
  gid: PORTFOLIO_GID,
  name: "Roadmap",
  workspace: IN_WORKSPACE,
  archived: false,
  permalink_url: "https://app.asana.com/0/portfolio/2100000000000001",
  color: "dark-green",
  owner: { gid: USER.gid, name: USER.name },
  start_on: "2026-10-01",
  due_on: "2026-12-31",
  current_status_update: { gid: "2300000000000001", title: "Week 3\n- forged" },
  custom_field_settings: [{ gid: "1610000000000011", custom_field: HEALTH }],
};

function item(gid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name: `Item ${gid.slice(-1)}`, resource_type: "project", workspace: IN_WORKSPACE, ...extra };
}

function portfolioRoute(workspace: unknown = IN_WORKSPACE): Routes {
  return { [`GET ${PORTFOLIO_PATH}`]: dataReply({ gid: PORTFOLIO_GID, workspace }) };
}

function projectRoute(workspace: unknown = IN_WORKSPACE): Routes {
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

describe("list_portfolios", () => {
  it("lists the token user's portfolios in the pinned workspace by default", async () => {
    const forged = item("2100000000000001", { name: "Item 1\ncursor: x" });
    const portfolios = [forged, item("2100000000000002", { archived: true })];
    fake.routes = { "GET /portfolios": pageReply(portfolios, "next") };
    assert.equal(
      await listPortfolios(context, {}),
      [
        "portfolios owned by the token's user:",
        "- Item 1 cursor: x (gid 2100000000000001)",
        "- Item 2 (gid 2100000000000002), archived",
        "cursor: next",
      ].join("\n"),
    );
    assert.deepEqual(fake.requestsTo("GET", "/portfolios")[0].query, {
      workspace: WORKSPACE.gid,
      owner: "me",
      limit: "50",
      opt_fields: "name,archived,workspace",
    });
  });

  it("passes another owner, limit, and cursor through", async () => {
    fake.routes = { "GET /portfolios": pageReply([]) };
    const owner = "1200000000000009";
    const result = await listPortfolios(context, { owner, limit: 5, cursor: "c" });
    assert.equal(result, `portfolios owned by user ${owner}: none`);
    assert.deepEqual(fake.requestsTo("GET", "/portfolios")[0].query, {
      workspace: WORKSPACE.gid,
      owner,
      limit: "5",
      offset: "c",
      opt_fields: "name,archived,workspace",
    });
  });

  it("refuses the page if any portfolio is outside the workspace, or in none", async () => {
    for (const workspace of [ELSEWHERE, undefined]) {
      const portfolios = [item("2100000000000001"), item("2100000000000002", { workspace })];
      fake.routes = { "GET /portfolios": pageReply(portfolios) };
      await assert.rejects(listPortfolios(context, {}), { message: `a listed portfolio ${NOT_PINNED}` });
    }
  });
});

describe("get_portfolio", () => {
  it("renders details, custom fields, and items with their values for the portfolio's fields only", async () => {
    const health = { ...HEALTH, enum_value: { gid: "1620000000000011", name: "Green" } };
    const other = { gid: "1600000000000099", name: "Other", resource_subtype: "text", text_value: "hidden" };
    fake.routes = {
      [`GET ${PORTFOLIO_PATH}`]: dataReply(FULL_PORTFOLIO),
      [`GET ${ITEMS_PATH}`]: pageReply(
        [
          item("1400000000000001", { name: "Launch\n- project Forged", custom_fields: [health, other] }),
          item("2100000000000002", { resource_type: "portfolio", archived: true }),
        ],
        "next",
      ),
    };
    assert.equal(
      await getPortfolio(context, { portfolio_gid: PORTFOLIO_GID }),
      [
        "portfolio: Roadmap (gid 2100000000000001)",
        "url: https://app.asana.com/0/portfolio/2100000000000001",
        "archived: no",
        "owner: Ada Lovelace (gid 1200000000000001)",
        "color: dark-green",
        "latest status update: Week 3 - forged",
        "start: 2026-10-01",
        "due: 2026-12-31",
        "custom fields:",
        "  Health (gid 1600000000000011): enum",
        "    Green (gid 1620000000000011)",
        "    Red (gid 1620000000000012), disabled",
        "items:",
        "- project Launch - project Forged (gid 1400000000000001)",
        "  Health (gid 1600000000000011), enum: Green (gid 1620000000000011)",
        "- portfolio Item 2 (gid 2100000000000002), archived",
        "cursor: next",
      ].join("\n"),
    );
    assert.equal(
      fake.requestsTo("GET", PORTFOLIO_PATH)[0].query.opt_fields,
      "name,archived,workspace,permalink_url,color,owner.name,start_on,due_on,current_status_update.title," +
        "custom_field_settings.custom_field.name," +
        "custom_field_settings.custom_field.resource_subtype,custom_field_settings.custom_field.is_formula_field," +
        "custom_field_settings.custom_field.is_value_read_only,custom_field_settings.custom_field.enum_options.name," +
        "custom_field_settings.custom_field.enum_options.enabled",
    );
    assert.deepEqual(fake.requestsTo("GET", ITEMS_PATH)[0].query, {
      opt_fields: `name,archived,resource_type,${CUSTOM_FIELD_VALUES}`,
      limit: "50",
    });
  });

  it("says none for what a bare portfolio lacks, and passes a cursor through", async () => {
    fake.routes = {
      [`GET ${PORTFOLIO_PATH}`]: dataReply({ gid: PORTFOLIO_GID, name: "Bare", workspace: IN_WORKSPACE }),
      [`GET ${ITEMS_PATH}`]: pageReply([]),
    };
    assert.equal(
      await getPortfolio(context, { portfolio_gid: PORTFOLIO_GID, limit: 10, cursor: "c" }),
      [
        "portfolio: Bare (gid 2100000000000001)",
        "url: none",
        "archived: no",
        "owner: none",
        "latest status update: none",
        "due: none",
        "custom fields: none",
        "items: none",
      ].join("\n"),
    );
    const { limit, offset } = fake.requestsTo("GET", ITEMS_PATH)[0].query;
    assert.deepEqual({ limit, offset }, { limit: "10", offset: "c" });
  });

  it("refuses a portfolio outside the workspace before reading its items", async () => {
    for (const workspace of [ELSEWHERE, undefined]) {
      fake.routes = { [`GET ${PORTFOLIO_PATH}`]: dataReply({ ...FULL_PORTFOLIO, workspace }) };
      await assert.rejects(getPortfolio(context, { portfolio_gid: PORTFOLIO_GID }), {
        message: `portfolio ${PORTFOLIO_GID} ${NOT_PINNED}`,
      });
    }
    assert.deepEqual(fake.requestsTo("GET", ITEMS_PATH), []);
  });
});

for (const [verb, run, path, done] of [
  ["add_to_portfolio", addToPortfolio, "addItem", "added project 1400000000000001 to"],
  ["remove_from_portfolio", removeFromPortfolio, "removeItem", "removed project 1400000000000001 from"],
] as const) {
  const write = `${PORTFOLIO_PATH}/${path}`;
  const input = { portfolio_gid: PORTFOLIO_GID, project_gid: PROJECT_GID };

  describe(verb, () => {
    it("checks the portfolio and project are pinned, then writes the project as the item", async () => {
      fake.routes = { ...portfolioRoute(), ...projectRoute(), [`POST ${write}`]: dataReply({}) };
      assert.equal(await run(context, input), `${done} portfolio ${PORTFOLIO_GID}`);
      assert.deepEqual(
        fake.requests.map((request) => `${request.method} ${request.path}`),
        [`GET ${PORTFOLIO_PATH}`, `GET /projects/${PROJECT_GID}`, `POST ${write}`],
      );
      assert.deepEqual(fake.requests[0].query, { opt_fields: "workspace" });
      assert.deepEqual(fake.requests[1].query, { opt_fields: "workspace" });
      assert.deepEqual(fake.requestsTo("POST", write)[0].body, { data: { item: PROJECT_GID } });
    });

    it("refuses a portfolio or project outside the workspace without writing", async () => {
      fake.routes = { ...portfolioRoute(ELSEWHERE), ...projectRoute() };
      await assert.rejects(run(context, input), { message: `portfolio ${PORTFOLIO_GID} ${NOT_PINNED}` });
      for (const workspace of [ELSEWHERE, null]) {
        fake.routes = { ...portfolioRoute(), ...projectRoute(workspace) };
        await assert.rejects(run(context, input), { message: `project ${PROJECT_GID} ${NOT_PINNED}` });
      }
      assert.ok(fake.requests.every((request) => request.method === "GET"));
    });

    it("says a 5xx may have landed, and a 4xx did not", async () => {
      fake.routes = { ...portfolioRoute(), ...projectRoute(), [`POST ${write}`]: errorReply(503, "busy") };
      await assert.rejects(run(context, input), /busy\n\nThe write may have gone through; get_project shows/);
      fake.routes[`POST ${write}`] = errorReply(400, "item: Not a project");
      await assert.rejects(run(context, input), (err: Error) => /Not a project$/.test(err.message));
    });
  });
}
