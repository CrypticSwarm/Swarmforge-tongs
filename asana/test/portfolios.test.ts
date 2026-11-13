import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { addToPortfolio, removeFromPortfolio, type Context } from "../src/server.js";
import { FakeAsana, WORKSPACE, dataReply, errorReply, type Routes } from "./fakes.js";

const PORTFOLIO_GID = "2100000000000001";
const PROJECT_GID = "1400000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid };
const ELSEWHERE = { gid: "1100000000000999" };
const NOT_PINNED = `is not in workspace Acme (gid ${WORKSPACE.gid}).`;
const PORTFOLIO_PATH = `/portfolios/${PORTFOLIO_GID}`;

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
