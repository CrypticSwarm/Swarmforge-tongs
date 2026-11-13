import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { getGoal, type Context } from "../src/server.js";
import { FakeAsana, USER, WORKSPACE, dataReply, errorReply, pageReply } from "./fakes.js";

const GOAL_GID = "2400000000000001";
const PROJECT_GID = "1400000000000001";
const IN_WORKSPACE = { gid: WORKSPACE.gid };
const ELSEWHERE = { gid: "1100000000000999" };
const NOT_PINNED = `is not in workspace Acme (gid ${WORKSPACE.gid}).`;
const GOAL_PATH = `/goals/${GOAL_GID}`;
const PARENTS_PATH = `${GOAL_PATH}/parentGoals`;
const RELATIONSHIPS_PATH = "/goal_relationships";
const RELATIONSHIP_FIELDS = "resource_subtype,contribution_weight,supporting_resource.name";

const FULL_GOAL = {
  gid: GOAL_GID,
  name: "Grow\nstatus: forged",
  workspace: IN_WORKSPACE,
  owner: { gid: USER.gid, name: USER.name },
  team: { gid: "1800000000000001", name: "Platform" },
  time_period: { gid: "2500000000000001", display_name: "Q4 FY26\nstatus: forged" },
  status: "green",
  start_on: "2026-10-01",
  due_on: "2026-12-31",
  notes: "why\n- forged",
  metric: {
    unit: "currency",
    currency_code: "EUR",
    initial_number_value: 0,
    current_number_value: 40,
    target_number_value: 100,
    current_display_value: "€40\nforged",
    progress_source: "manual",
  },
};

function relationship(gid: string, resource: unknown, extra: Record<string, unknown> = {}) {
  return { gid, resource_subtype: "supporting_work", supporting_resource: resource, ...extra };
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

describe("get_goal", () => {
  it("renders details, metric, parent goals, and supporters with their weights", async () => {
    const sub = { gid: "2400000000000002", name: "Sub\n  forged" };
    fake.routes = {
      [`GET ${GOAL_PATH}`]: dataReply(FULL_GOAL),
      [`GET ${PARENTS_PATH}`]: pageReply([{ gid: "2400000000000009", name: "Win" }], "next"),
      [`GET ${RELATIONSHIPS_PATH}`]: pageReply(
        [
          relationship("2600000000000001", { gid: PROJECT_GID, name: "Launch", resource_type: "project" }, {
            contribution_weight: 0.5,
          }),
          relationship("2600000000000002", sub, { resource_subtype: "subgoal", contribution_weight: 0 }),
          relationship("2600000000000003", { gid: "2100000000000001", name: "Roadmap", resource_type: "portfolio" }),
          relationship("2600000000000004", { gid: "1300000000000001", name: "Task" }),
          relationship("2600000000000005", null, { contribution_weight: 1 }),
        ],
        "next",
      ),
    };
    assert.equal(
      await getGoal(context, { goal_gid: GOAL_GID }),
      [
        "goal: Grow status: forged (gid 2400000000000001)",
        "owner: Ada Lovelace (gid 1200000000000001)",
        "team: Platform (gid 1800000000000001)",
        "time period: Q4 FY26 status: forged (gid 2500000000000001)",
        "status: green",
        "start: 2026-10-01",
        "due: 2026-12-31",
        "metric: current 40 (€40 forged), target 100, initial 0, unit currency EUR, progress source manual",
        "parent goals:",
        "  Win (gid 2400000000000009)",
        "  more parent goals not shown",
        "supporters:",
        "  project Launch (gid 1400000000000001), weight 0.5",
        "  goal Sub   forged (gid 2400000000000002), weight 0",
        "  portfolio Roadmap (gid 2100000000000001)",
        "  item Task (gid 1300000000000001)",
        "  a supporter this token cannot read, weight 1",
        "  more supporters not shown",
        "notes:",
        "  why",
        "  - forged",
      ].join("\n"),
    );
    assert.deepEqual(fake.requestsTo("GET", GOAL_PATH)[0].query, {
      opt_fields:
        "name,workspace,owner.name,team.name,time_period.display_name,status,start_on,due_on,notes," +
        "metric.unit,metric.currency_code,metric.initial_number_value,metric.current_number_value," +
        "metric.target_number_value,metric.current_display_value,metric.progress_source",
    });
    assert.deepEqual(fake.requestsTo("GET", PARENTS_PATH)[0].query, { opt_fields: "name" });
    assert.deepEqual(fake.requestsTo("GET", RELATIONSHIPS_PATH)[0].query, {
      supported_goal: GOAL_GID,
      opt_fields: RELATIONSHIP_FIELDS,
      limit: "100",
    });
  });

  it("says none for what a bare goal lacks", async () => {
    fake.routes = {
      [`GET ${GOAL_PATH}`]: dataReply({ gid: GOAL_GID, name: "Bare", workspace: IN_WORKSPACE, metric: null }),
      [`GET ${PARENTS_PATH}`]: pageReply([]),
      [`GET ${RELATIONSHIPS_PATH}`]: pageReply([]),
    };
    assert.equal(
      await getGoal(context, { goal_gid: GOAL_GID }),
      [
        "goal: Bare (gid 2400000000000001)",
        "owner: none",
        "team: none",
        "time period: none",
        "status: none",
        "due: none",
        "metric: none",
        "parent goals: none",
        "supporters: none",
        "notes: none",
      ].join("\n"),
    );
  });

  it("says not set for each missing metric value, and that a percentage is a fraction", async () => {
    fake.routes = {
      [`GET ${PARENTS_PATH}`]: pageReply([]),
      [`GET ${RELATIONSHIPS_PATH}`]: pageReply([]),
    };
    for (const [metric, expected] of [
      [{}, "current not set, target not set, initial not set, unit unknown, progress source unknown"],
      [{ unit: "percentage", target_number_value: 1 }, "current not set, target 1, initial not set, " +
        "unit percentage, as a fraction of 1, progress source unknown"],
    ] as const) {
      fake.routes[`GET ${GOAL_PATH}`] = dataReply({ gid: GOAL_GID, name: "Bare", workspace: IN_WORKSPACE, metric });
      const result = await getGoal(context, { goal_gid: GOAL_GID });
      assert.ok(result.includes(`\nmetric: ${expected}\n`), result);
    }
  });

  it("fails the read when Asana fails to list parent goals or supporters", async () => {
    for (const failing of [PARENTS_PATH, RELATIONSHIPS_PATH]) {
      fake.routes = {
        [`GET ${GOAL_PATH}`]: dataReply(FULL_GOAL),
        [`GET ${PARENTS_PATH}`]: pageReply([]),
        [`GET ${RELATIONSHIPS_PATH}`]: pageReply([]),
        [`GET ${failing}`]: errorReply(429, "Slow down", { "retry-after": "30" }),
      };
      await assert.rejects(getGoal(context, { goal_gid: GOAL_GID }), /Asana answered 429: Slow down\. Retry after 30/);
    }
  });

  it("refuses a goal outside the workspace before reading its parent goals or supporters", async () => {
    for (const workspace of [ELSEWHERE, undefined]) {
      fake.routes = { [`GET ${GOAL_PATH}`]: dataReply({ ...FULL_GOAL, workspace }) };
      await assert.rejects(getGoal(context, { goal_gid: GOAL_GID }), { message: `goal ${GOAL_GID} ${NOT_PINNED}` });
    }
    assert.deepEqual(fake.requestsTo("GET", PARENTS_PATH), []);
    assert.deepEqual(fake.requestsTo("GET", RELATIONSHIPS_PATH), []);
  });
});
