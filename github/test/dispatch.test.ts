import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchEntry, Dropped } from "../src/allowlist.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { checkInputs, dispatch, dispatchInputs, listWorkflows, loadDispatch, type InputSpec } from "../src/dispatch.js";
import { RESERVED_VERBS, buildServer, dispatchInstructions, type Context } from "../src/server.js";
import { GitHub } from "../src/github.js";
import {
  ACTIONS,
  FakeGit,
  FakeGitHubApi,
  ORIGIN,
  REPO_ROUTE,
  TOKEN,
  allowlistRoute,
  branchTipRoute,
  contextFor,
  dispatchRoute,
  workflowFileRoute,
  type FetchCall,
} from "./fakes.js";

const PUSHED = "1111111111111111111111111111111111111111";
const MAIN = "4444444444444444444444444444444444444444";
const TIPS = { "refs/heads/main": MAIN, "refs/heads/feature": PUSHED };
const PRODUCTION: DispatchEntry = { verb: "deploy_production", file: "deploy.yml", ref: "default" };
const STAGING: DispatchEntry = { verb: "deploy_staging", file: "deploy.yml", ref: "current" };
const CONTENTS = "/repos/acme/widgets/contents/.github/workflows/deploy.yml";
const ALLOWLIST_PATH = "/repos/acme/widgets/contents/.github/swarmforge-dispatch.yml";
const LISTING = [
  "deploy_production: { workflow: deploy.yml, ref: default }",
  "deploy_staging: { workflow: deploy.yml, ref: current }",
  "deploy_again: { workflow: deploy.yml, ref: default }",
  "lint: { workflow: lint.yml, ref: default }",
].join("\n");
/** What every dispatch re-reads first: the default branch's name and its allowlist. */
const LISTED = { ...REPO_ROUTE, ...allowlistRoute(LISTING) };
const DISPATCHES = `POST ${ACTIONS}/workflows/deploy.yml/dispatches`;

const DEPLOY = `
on:
  push:
  workflow_dispatch:
    inputs:
      note: { type: string }
      dry_run: { type: boolean, default: false }
      replicas: { type: number }
      tier: { type: choice, options: [small, large], required: true, default: small }
`;

function pushedGit(branch = "feature"): FakeGit {
  const git = new FakeGit({ branch, head: PUSHED });
  git.refs.set(`refs/remotes/origin/${branch}`, PUSHED);
  return git;
}

function deployApi(yaml = DEPLOY, dispatched: FetchCall[] = [], tips: Record<string, string> = TIPS): FakeGitHubApi {
  const route = dispatchRoute("deploy.yml")[DISPATCHES];
  return new FakeGitHubApi({
    ...LISTED,
    ...branchTipRoute(tips),
    ...workflowFileRoute("deploy.yml", yaml),
    [DISPATCHES]: (call) => {
      dispatched.push(call);
      return route;
    },
  });
}

const contextWith = (api: FakeGitHubApi, git = pushedGit()) =>
  contextFor(api, git, { defaultBranch: "main", entries: [PRODUCTION, STAGING], dropped: [] });

function readRefs(api: FakeGitHubApi): string[] {
  return api.calls
    .map((call) => new URL(call.url))
    .filter((url) => url.pathname === CONTENTS)
    .map((url) => url.searchParams.get("ref") ?? "");
}

function askedTips(api: FakeGitHubApi): string[] {
  return api.calls
    .filter((call) => call.url.endsWith("/graphql"))
    .map((call) => (call.body as { variables: { ref: string } }).variables.ref);
}

describe("dispatching", () => {
  it("runs a default-branch verb on the default branch, checked at GitHub's tip", async () => {
    const dispatched: FetchCall[] = [];
    const api = deployApi(DEPLOY, dispatched);

    const text = await dispatch(contextWith(api), PRODUCTION, { inputs: { note: "hi", dry_run: true, replicas: 2.5 } });

    assert.deepEqual(askedTips(api), ["refs/heads/main"]);
    assert.deepEqual(readRefs(api), [MAIN]);
    assert.deepEqual(dispatched[0].body, {
      ref: "refs/heads/main",
      inputs: { note: "hi", dry_run: "true", replicas: "2.5" },
      return_run_details: true,
    });
    assert.equal(
      text,
      "Dispatched deploy.yml on main, checked at 444444444444, as run 555.\n" +
        "https://github.com/acme/widgets/actions/runs/555\nFollow it with ci_status run=555.",
    );
  });

  it("runs a current-branch verb on the checked-out branch, at the commit GitHub and HEAD agree on", async () => {
    const dispatched: FetchCall[] = [];
    const api = deployApi(DEPLOY, dispatched);

    const text = await dispatch(contextWith(api), STAGING, {});

    assert.deepEqual(askedTips(api), ["refs/heads/main", "refs/heads/feature"]);
    assert.deepEqual(readRefs(api), [PUSHED]);
    assert.equal((dispatched[0].body as { ref: string }).ref, "refs/heads/feature");
    assert.match(text, /^Dispatched deploy\.yml on feature, checked at 111111111111, as run 555\./);
  });

  it("refuses a current-branch verb unless HEAD is a branch GitHub has at HEAD, other than the default", async () => {
    const moved = pushedGit();
    moved.head = "2".repeat(40);
    const cases: Array<[FakeGit, Record<string, string>, RegExp]> = [
      [new FakeGit({ branch: null }), TIPS, /HEAD is detached/],
      [pushedGit("main"), TIPS, /main is the default branch/],
      [pushedGit(), { "refs/heads/main": MAIN }, /GitHub has no branch feature; push it first/],
      [moved, TIPS, /HEAD is at 222222222222, but GitHub's feature is at 111111111111; push or pull first/],
    ];
    for (const [git, tips, expected] of cases) {
      const dispatched: FetchCall[] = [];
      const api = deployApi(DEPLOY, dispatched, tips);
      await assert.rejects(() => dispatch(contextWith(api, git), STAGING, {}), expected);
      assert.deepEqual([readRefs(api), dispatched.length], [[], 0], String(expected));
    }
  });

  it("trusts GitHub's tip over the workspace's own tracking ref", async () => {
    const dispatched: FetchCall[] = [];
    const api = deployApi(DEPLOY, dispatched, { ...TIPS, "refs/heads/feature": "5".repeat(40) });

    await assert.rejects(() => dispatch(contextWith(api), STAGING, {}), /GitHub's feature is at 555555555555/);
    assert.equal(dispatched.length, 0);
  });

  it("qualifies a branch named like a ref, so it cannot stand in for the default branch or a tag", async () => {
    const dispatched: FetchCall[] = [];
    const api = deployApi(DEPLOY, dispatched);
    const git = new FakeGit({ branch: "refs/heads/main", head: MAIN });

    await assert.rejects(() => dispatch(contextWith(api, git), STAGING, {}), /GitHub has no branch refs\/heads\/main/);
    assert.deepEqual(askedTips(api), ["refs/heads/main", "refs/heads/refs/heads/main"]);
    assert.equal(dispatched.length, 0);
  });

  it("refuses a workflow with no workflow_dispatch trigger on that branch, and dispatches nothing", async () => {
    const dispatched: FetchCall[] = [];
    const api = deployApi("on: push\n", dispatched);

    await assert.rejects(() => dispatch(contextWith(api), PRODUCTION, {}), /deploy\.yml on main has no workflow_dispatch/);
    assert.equal(dispatched.length, 0);
  });

  it("refuses inputs the workflow file does not accept, and dispatches nothing", async () => {
    const dispatched: FetchCall[] = [];
    const api = deployApi(DEPLOY, dispatched);

    await assert.rejects(
      () => dispatch(contextWith(api), PRODUCTION, { inputs: { notes: "x" } }),
      /no input notes; it takes note, dry_run, replicas, tier\./,
    );
    assert.equal(dispatched.length, 0);
  });

  it("says when GitHub reports no run id, and where to look", async () => {
    const api = new FakeGitHubApi({
      ...LISTED,
      ...branchTipRoute(TIPS),
      ...workflowFileRoute("deploy.yml", DEPLOY),
      [DISPATCHES]: { status: 204 },
    });

    assert.equal(
      await dispatch(contextWith(api), PRODUCTION, {}),
      `Dispatched deploy.yml on main, checked at 444444444444, but GitHub reported no run id; find the run with ci_status sha=${MAIN}.`,
    );
  });

  it("says a dispatch behind a 5xx or no answer may have started, and a 4xx did not", async () => {
    const respond = (answer: () => Response | Promise<Response>) => {
      const api = new FakeGitHubApi({ ...LISTED, ...branchTipRoute(TIPS), ...workflowFileRoute("deploy.yml", DEPLOY) });
      const fetch = api.fetch;
      const context = contextWith(api);
      context.github = new GitHub(
        async (input, init) => (String(input).endsWith("/dispatches") ? answer() : fetch(input, init)),
        ORIGIN,
        TOKEN,
      );
      return context;
    };
    const status = (code: number) => () => new Response(JSON.stringify({ message: "nope" }), { status: code });

    await assert.rejects(() => dispatch(respond(status(502)), PRODUCTION, {}), /may have started anyway/);
    await assert.rejects(
      () =>
        dispatch(
          respond(() => Promise.reject(new TypeError("socket hang up"))),
          PRODUCTION,
          {},
        ),
      /cannot reach .*socket hang up\n\nThe run may have started anyway/s,
    );
    await assert.rejects(
      () => dispatch(respond(status(422)), PRODUCTION, {}),
      (err: Error) => /422/.test(err.message) && !/may have started/.test(err.message),
    );
  });

  it("refuses a verb the allowlist no longer lists as at startup, or a renamed default branch", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [allowlistRoute("deploy_staging: { workflow: deploy.yml, ref: current }\n"), /no longer lists deploy_production as it did/],
      [allowlistRoute("deploy_production: { workflow: other.yml, ref: default }\n"), /no longer lists deploy_production/],
      [allowlistRoute("deploy_production: { workflow: deploy.yml, ref: current }\n"), /no longer lists deploy_production/],
      [{ [`GET ${ALLOWLIST_PATH}`]: { status: 404, json: { message: "Not Found" } } }, /no longer lists deploy_production/],
      [allowlistRoute("- deploy\n"), /swarmforge-dispatch\.yml on main is unusable now: it is not a map/],
      [{ "GET /repos/acme/widgets": { status: 200, json: { default_branch: "trunk" } } }, /default branch is now trunk, not main/],
      [branchTipRoute({ "refs/heads/feature": PUSHED }), /^Error: GitHub has no branch main\.$/],
      [
        { [`GET ${ALLOWLIST_PATH}`]: { status: 503, json: { message: "Service Unavailable" } } },
        /^Error: checking \.github\/swarmforge-dispatch\.yml failed, so nothing was dispatched: GitHub returned 503/,
      ],
      [
        { [`GET ${ALLOWLIST_PATH}`]: { status: 403, json: { message: "no" } } },
        /^Error: checking .* failed, so nothing was dispatched: GitHub refused the request \(403\)/,
      ],
    ];
    for (const [routes, expected] of cases) {
      const dispatched: FetchCall[] = [];
      const api = deployApi(DEPLOY, dispatched);
      Object.assign(api.routes, routes);
      await assert.rejects(() => dispatch(contextWith(api), PRODUCTION, {}), expected);
      assert.deepEqual([readRefs(api), dispatched.length], [[], 0], String(expected));
    }
  });

  it("skips a verb shadowing a built-in one, rather than failing every request", () => {
    const shadow: DispatchEntry = { verb: "push_branch", file: "deploy.yml", ref: "default" };
    assert.doesNotThrow(() =>
      buildServer(contextFor(deployApi(), pushedGit(), { defaultBranch: "main", entries: [shadow, PRODUCTION], dropped: [] })),
    );
  });

  it("refuses when the tong has no dispatch verbs", async () => {
    await assert.rejects(() => dispatch(contextFor(deployApi()), PRODUCTION, {}), /has no dispatch verbs/);
  });
});

describe("dispatchInputs", () => {
  it("reads each shape of the workflow_dispatch trigger", () => {
    assert.deepEqual(dispatchInputs("on: workflow_dispatch\n"), []);
    assert.deepEqual(dispatchInputs("on: [push, workflow_dispatch]\n"), []);
    assert.deepEqual(dispatchInputs("on:\n  workflow_dispatch:\n"), []);
    assert.deepEqual(dispatchInputs("on:\n  workflow_dispatch:\n    inputs:\n"), []);
    assert.deepEqual(dispatchInputs("on:\n  workflow_dispatch:\n    inputs:\n      x:\n"), [
      { name: "x", type: "string", required: false, hasDefault: false, default: "", options: [], description: "" },
    ]);
    assert.deepEqual(
      dispatchInputs("on:\n  workflow_dispatch:\n    inputs:\n      x: { default: ~ }\n      y: { default: }\n")!.map((spec) => spec.hasDefault),
      [false, false],
    );
  });

  it("returns null without the trigger", () => {
    for (const text of ["on: push\n", "on: [push]\n", "on:\n  push:\n", "name: x\n", "", "just a string\n"]) {
      assert.equal(dispatchInputs(text), null, JSON.stringify(text));
    }
  });

  it("reads each input's type, whether it is required, its default, and its options", () => {
    const specs = dispatchInputs(DEPLOY)!;

    assert.deepEqual(
      specs.map((spec) => [spec.name, spec.type, spec.required, spec.hasDefault, spec.options]),
      [
        ["note", "string", false, false, []],
        ["dry_run", "boolean", false, true, []],
        ["replicas", "number", false, false, []],
        ["tier", "choice", true, true, ["small", "large"]],
      ],
    );
  });

  it("refuses a file it cannot read safely", () => {
    const cases: Array<[string, RegExp]> = [
      ["on: [\n", /not valid YAML/],
      ["on:\n  workflow_dispatch:\n    inputs: [a]\n", /inputs is not a map/],
      ["on:\n  workflow_dispatch:\n    inputs:\n      x: { type: secret }\n", /type 'secret', which this tong does not know/],
      ["on:\n  workflow_dispatch:\n    inputs:\n      x: { type: choice }\n", /lists no options/],
      ['on:\n  workflow_dispatch:\n    inputs:\n      "a b": {}\n', /name GitHub does not accept/],
      [`on:\n  workflow_dispatch:\n    inputs:\n      a${"b".repeat(100)}: {}\n`, /name GitHub does not accept/],
      ['on:\n  workflow_dispatch:\n    inputs:\n      __proto__: {}\n', /input __proto__ has a name this tong cannot pass/],
      ["on: push\non: workflow_dispatch\n", /not valid YAML/],
      ["on: push\n---\non: workflow_dispatch\n", /not valid YAML/],
      ["%YAML 1.1\n---\non: workflow_dispatch\n", /YAML version other than 1\.2/],
      [`on:\n  workflow_dispatch:\n    inputs:\n${Array.from({ length: 26 }, (_, i) => `      i${i}:\n`).join("")}`, /declares 26 inputs; GitHub allows 25/],
    ];
    for (const [text, expected] of cases) assert.throws(() => dispatchInputs(text), expected, text);
  });

  it("expands only the trigger, so anchors elsewhere are fine and an alias bomb in it is refused", () => {
    const reused = `x: &s {run: echo}\n${Array.from({ length: 150 }, (_, i) => `j${i}: *s`).join("\n")}\non: workflow_dispatch\n`;
    assert.deepEqual(dispatchInputs(reused), []);

    const rows = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 12; i++) {
      const name = "b".repeat(i);
      rows.push(`${name}: &${name} [${Array(10).fill(i === 1 ? "*a" : `*${"b".repeat(i - 1)}`).join(", ")}]`);
    }
    const bomb = `${rows.join("\n")}\non:\n  workflow_dispatch:\n    inputs:\n      x: { options: *${"b".repeat(11)} }\n`;
    assert.throws(() => dispatchInputs(bomb), /the workflow file's 'on' cannot be read: Excessive alias count/);
  });
});

describe("checkInputs", () => {
  const spec = (name: string, type: InputSpec["type"], more: Partial<InputSpec> = {}): InputSpec => ({
    name,
    type,
    required: false,
    hasDefault: false,
    default: "",
    options: [],
    description: "",
    ...more,
  });

  it("turns each typed value into the string GitHub takes", () => {
    const specs = [spec("s", "string"), spec("b", "boolean"), spec("n", "number"), spec("c", "choice", { options: ["x", "y"] })];

    assert.deepEqual(checkInputs(specs, { s: "", b: false, n: -3, c: "y" }), { s: "", b: "false", n: "-3", c: "y" });
  });

  it("refuses a value of the wrong type, or a choice not offered", () => {
    const cases: Array<[InputSpec, unknown, RegExp]> = [
      [spec("b", "boolean"), "true", /b is a boolean input/],
      [spec("n", "number"), "3", /n is a number input/],
      [spec("s", "string"), 3, /s is a string input/],
      [spec("c", "choice", { options: ["x"] }), "z", /c takes one of these strings: x\./],
      [spec("c", "choice", { options: ["1"] }), 1, /c takes one of these strings: 1\./],
    ];
    for (const [s, value, expected] of cases) {
      assert.throws(() => checkInputs([s], { [s.name]: value as string }), expected);
    }
  });

  it("needs every required input with no default, and a boolean with none, all named at once", () => {
    const specs = [spec("r", "string", { required: true }), spec("q", "number", { required: true }), spec("b", "boolean")];

    assert.throws(
      () => checkInputs(specs, {}),
      /^Error: the workflow requires r, q; pass them\. b is a boolean with no default, which GitHub refuses unset; pass it\.$/,
    );
    assert.throws(() => checkInputs(specs, { r: "x", q: 1 }), /^Error: b is a boolean with no default, which GitHub refuses unset; pass it\.$/);
    assert.throws(
      () => checkInputs([...specs, spec("c", "boolean")], { r: "x", q: 1 }),
      /^Error: b, c are booleans with no default, which GitHub refuses unset; pass them\.$/,
    );
    assert.throws(
      () => checkInputs([...specs, spec("t", "boolean", { required: true })], { r: "x", q: 1, b: true }),
      /^Error: the workflow requires t; pass it\.$/,
    );
    assert.throws(() => checkInputs(specs, { z: 1 }), /it takes r \(required\), q \(required\), b \(boolean, must pass\)\./);
    assert.deepEqual(checkInputs([spec("r", "string", { required: true, hasDefault: true }), spec("b", "boolean", { hasDefault: true })], {}), {});
  });

  it("never sets an environment input", () => {
    const env = spec("environment", "environment");

    assert.throws(() => checkInputs([env], { environment: "production" }), /environment is an environment input, which this tong never sets/);
    assert.throws(() => checkInputs([{ ...env, required: true }], {}), /requires environment input environment, which this tong never sets/);
    assert.deepEqual(checkInputs([{ ...env, required: true, hasDefault: true }], {}), {});
    assert.deepEqual(checkInputs([env], {}), {});
    assert.throws(() => checkInputs([env, spec("x", "string")], { y: "" }), /no input y; it takes x\./);
  });

  it("treats names like __proto__ and constructor as plain names", () => {
    const specs = [spec("constructor", "string", { required: true }), spec("__proto__", "string")];

    assert.throws(() => checkInputs(specs, {}), /requires constructor/);
    const given = JSON.parse('{"constructor": "a", "__proto__": "b"}');
    const out = checkInputs(specs, given);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(Object.entries(out), [
      ["constructor", "a"],
      ["__proto__", "b"],
    ]);
    assert.throws(() => checkInputs([], { toString: "x" }), /no input toString; it takes none/);
  });
});

describe("loadDispatch", () => {
  const load = (api: FakeGitHubApi) => loadDispatch(new GitHub(api.fetch, ORIGIN, TOKEN), "main", RESERVED_VERBS);
  const listing = (...entries: Array<[string, string]>) =>
    entries.map(([verb, file]) => `${verb}: { workflow: ${file}, ref: default }`).join("\n");

  it("keeps the verbs dispatchable from the default branch's tip, and says why it drops each other one", async () => {
    const api = new FakeGitHubApi({
      ...branchTipRoute(TIPS),
      ...allowlistRoute(
        listing(["deploy", "deploy.yml"], ["lint", "lint.yml"], ["broken", "broken.yml"], ["pick", "pick.yml"], ["gone", "gone.yml"]) +
          "\nBad: { workflow: deploy.yml, ref: default }\n",
      ),
      ...workflowFileRoute("deploy.yml", DEPLOY),
      ...workflowFileRoute("lint.yml", "on: push\n"),
      ...workflowFileRoute("broken.yml", "on: [\n"),
      ...workflowFileRoute("pick.yml", "on:\n  workflow_dispatch:\n    inputs:\n      e: { type: environment, required: true }\n"),
      "GET /repos/acme/widgets/contents/.github/workflows/gone.yml": { status: 404, json: { message: "Not Found" } },
    });

    const { entries, dropped, unusable } = await load(api);

    assert.deepEqual(
      entries.map((e) => e.verb),
      ["deploy"],
    );
    assert.deepEqual(
      dropped.map((d) => d.verb),
      ["at entry 6", "lint", "broken", "pick", "gone"],
    );
    assert.match(dropped[0].why, /^\.github\/swarmforge-dispatch\.yml: a verb name takes/);
    assert.equal(dropped[1].why, "lint.yml: no workflow_dispatch trigger on main");
    assert.match(dropped[2].why, /^broken\.yml: the workflow file is not valid YAML/);
    assert.equal(dropped[3].why, "pick.yml: it requires environment input e, which this tong never sets");
    assert.match(dropped[4].why, /^gone\.yml: GitHub cannot see that workflow file .* not on that ref/);
    assert.equal(unusable, undefined);
    assert.deepEqual(askedTips(api), ["refs/heads/main"]);
    assert.deepEqual(readRefs(api), [MAIN]);
    const allowlistRead = api.calls.map((call) => new URL(call.url)).find((url) => url.pathname === ALLOWLIST_PATH);
    assert.equal(allowlistRead?.searchParams.get("ref"), MAIN);
  });

  it("serves no verbs, and says nothing, when the default branch has no allowlist", async () => {
    const api = new FakeGitHubApi({
      ...branchTipRoute(TIPS),
      [`GET ${ALLOWLIST_PATH}`]: { status: 404, json: { message: "Not Found" } },
    });

    assert.deepEqual(await load(api), { entries: [], dropped: [] });
    assert.equal(api.calls.length, 2);
  });

  it("serves no verbs, saying why, when the allowlist cannot be read or used", async () => {
    const cases: Array<[FakeGitHubApi, string | RegExp]> = [
      [new FakeGitHubApi(branchTipRoute({})), "GitHub has no branch main to read .github/swarmforge-dispatch.yml from"],
      [
        new FakeGitHubApi({ "POST /graphql": { status: 502, json: { message: "Bad Gateway" } } }),
        ".github/swarmforge-dispatch.yml on main cannot be read: GitHub returned 502: Bad Gateway; a new session tries again",
      ],
      [
        new FakeGitHubApi({ ...branchTipRoute(TIPS), [`GET ${ALLOWLIST_PATH}`]: { status: 403, json: { message: "no" } } }),
        /^\.github\/swarmforge-dispatch\.yml on main cannot be read: GitHub refused the request \(403\).*Contents: read, on a fine-grained token$/,
      ],
      [
        new FakeGitHubApi({ ...branchTipRoute(TIPS), ...allowlistRoute("- deploy\n") }),
        ".github/swarmforge-dispatch.yml on main is unusable: it is not a map of verb names to entries",
      ],
    ];
    for (const [api, why] of cases) {
      const { entries, dropped, unusable } = await load(api);
      assert.deepEqual([entries, dropped], [[], []]);
      if (typeof why === "string") assert.equal(unusable, why);
      else assert.match(unusable ?? "", why);
      assert.equal(readRefs(api).length, 0);
    }
  });

  it("says a workflow GitHub did not answer for may be fine", async () => {
    const api = new FakeGitHubApi({
      ...branchTipRoute(TIPS),
      ...allowlistRoute(listing(["deploy", "deploy.yml"])),
      [`GET ${CONTENTS}`]: { status: 503, json: { message: "Service Unavailable" } },
    });

    assert.deepEqual((await load(api)).dropped, [
      { verb: "deploy", why: "deploy.yml: GitHub returned 503: Service Unavailable; a new session tries again" },
    ]);
  });
});

describe("dispatchInstructions", () => {
  const setup = (verbs: string[], dropped: Dropped[] = [], unusable?: string) => ({
    entries: verbs.map((verb) => ({ verb, file: "deploy.yml", ref: "default" as const })),
    dropped,
    unusable,
  });
  const dropped = [{ verb: "deploy_old", why: "old.yml: no workflow_dispatch trigger on main" }];

  it("says nothing when dispatch is off, and where verbs come from when it is on", () => {
    assert.equal(dispatchInstructions(undefined), undefined);
    assert.equal(
      dispatchInstructions(setup([])),
      "Dispatch verbs come from .github/swarmforge-dispatch.yml on the default branch. A verb added there appears from the next\n" +
        "session; one removed or changed is refused at once.",
    );
  });

  it("names the verbs, each one dropped, and why the allowlist was unusable", () => {
    assert.match(dispatchInstructions(setup(["a"]))!, /^a dispatches one allowlisted/m);
    assert.match(dispatchInstructions(setup(["a"]))!, /list_workflows shows each verb's inputs\./);
    assert.match(dispatchInstructions(setup(["a", "b"]))!, /^Each of a, b dispatches one allowlisted/m);
    assert.match(
      dispatchInstructions(setup([], dropped))!,
      /\nDispatch verb deploy_old was dropped at startup: old\.yml: no workflow_dispatch trigger on main\.$/,
    );
    assert.match(
      dispatchInstructions(setup([], [], "GitHub has no branch main to read it from"))!,
      /\nNo dispatch verbs this session: GitHub has no branch main to read it from\.$/,
    );
  });
});

describe("listWorkflows", () => {
  const DESCRIBED = `
on:
  workflow_dispatch:
    inputs:
      tier: { type: choice, options: [small, large], required: true, default: small, description: "Which size\\nof box" }
      dry_run: { type: boolean, description: "${"x".repeat(250)}" }
      note: { default: "" }
      flag: { default: true }
      count: { type: number, default: 3 }
      target: { type: environment }
`;
  const listed = (api: FakeGitHubApi, git = pushedGit(), entries = [PRODUCTION, STAGING], dropped: Array<{ verb: string; why: string }> = []) =>
    listWorkflows(contextFor(api, git, { defaultBranch: "main", entries, dropped }));

  it("lists each verb's inputs as the JSON it takes, from the file on its branch, and each verb dropped", async () => {
    const api = deployApi(DESCRIBED);

    const text = await listed(api, pushedGit(), [PRODUCTION, STAGING], [
      { verb: "deploy_old", why: "old.yml: no workflow_dispatch trigger on main" },
    ]);

    assert.deepEqual(readRefs(api), [MAIN, PUSHED]);
    const [production, staging, dropped] = text.split("\n\n");
    assert.equal(
      production,
      [
        "deploy_production: .github/workflows/deploy.yml on main (default branch), at 444444444444",
        '  tier (choice): one of "small", "large"; default "small" · Which size of box',
        `  dry_run (boolean, must pass) · ${"x".repeat(200)}…`,
        '  note (string): default ""',
        '  flag (string): default "true"',
        "  count (number): default 3",
        "  target (environment): never set by this tong",
      ].join("\n"),
    );
    assert.match(staging, /^deploy_staging: \.github\/workflows\/deploy\.yml on feature \(checked out\), at 111111111111\n {2}tier /);
    assert.equal(dropped, "deploy_old: dropped at startup\n  old.yml: no workflow_dispatch trigger on main.");
  });

  it("still lists a verb that would be refused now, from the branch GitHub has or else the default", async () => {
    const moved = pushedGit();
    moved.head = "2".repeat(40);
    const one = "on:\n  workflow_dispatch:\n    inputs:\n      a: {}\n";

    assert.equal(
      await listed(deployApi(one), moved, [STAGING]),
      "deploy_staging: .github/workflows/deploy.yml on feature (checked out), at 111111111111\n" +
        "  cannot dispatch now: HEAD is at 222222222222, but GitHub's feature is at 111111111111; push or pull first.\n" +
        "  a (string)",
    );
    for (const [git, why] of [
      [new FakeGit({ branch: null }), "HEAD is detached; check out the branch to dispatch on."],
      [pushedGit("main"), "main is the default branch; this verb runs only on other branches."],
      [pushedGit("unpushed"), "GitHub has no branch unpushed; push it first."],
    ] as const) {
      const api = deployApi(one);
      assert.equal(
        await listed(api, git, [STAGING]),
        "deploy_staging: .github/workflows/deploy.yml on the checked-out branch (inputs as on main), at 444444444444\n" +
          `  cannot dispatch now: ${why}\n  a (string)`,
      );
      assert.deepEqual(readRefs(api), [MAIN]);
    }
  });

  it("cleans an agent-chosen branch name, and clips a long error", async () => {
    const api = deployApi("on: workflow_dispatch\n", [], { ...TIPS, "refs/heads/a\u202eb": PUSHED });
    assert.match(await listed(api, pushedGit("a\u202eb"), [STAGING]), /^deploy_staging: \S+ on ab \(checked out\), at /);

    const long = new FakeGitHubApi({ ...REPO_ROUTE, "POST /graphql": { status: 502, text: "e".repeat(2000) } });
    const lines = (await listed(long, pushedGit(), [PRODUCTION])).split("\n").slice(1);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.length, "  cannot dispatch now: ".length + 501);
      assert.match(line, /e…$/);
    }
  });

  it("gives every reason a fallback read cannot dispatch", async () => {
    assert.equal(
      await listed(deployApi("on: push\n"), new FakeGit({ branch: null }), [STAGING]),
      "deploy_staging: .github/workflows/deploy.yml on the checked-out branch (inputs as on main), at 444444444444\n" +
        "  cannot dispatch now: HEAD is detached; check out the branch to dispatch on.\n" +
        "  cannot dispatch now: deploy.yml on main has no workflow_dispatch trigger.",
    );
  });

  it("says when the file on the branch has no trigger, or requires an environment input", async () => {
    assert.equal(
      await listed(deployApi("on: push\n"), pushedGit(), [PRODUCTION]),
      "deploy_production: .github/workflows/deploy.yml on main (default branch), at 444444444444\n" +
        "  cannot dispatch now: deploy.yml on main has no workflow_dispatch trigger.",
    );
    assert.equal(
      await listed(deployApi("on:\n  workflow_dispatch:\n    inputs:\n      t: { type: environment, required: true }\n"), pushedGit(), [STAGING]),
      "deploy_staging: .github/workflows/deploy.yml on feature (checked out), at 111111111111\n" +
        "  cannot dispatch now: the workflow requires environment input t, which this tong never sets.\n" +
        "  t (environment, required): never set by this tong",
    );
  });

  it("asks GitHub once per branch and per file at one tip, and lists the rest when one fails", async () => {
    const other: DispatchEntry = { verb: "deploy_again", file: "deploy.yml", ref: "default" };
    const api = deployApi("on: workflow_dispatch\n");

    await listed(api, pushedGit(), [PRODUCTION, other]);
    assert.deepEqual([askedTips(api), readRefs(api)], [["refs/heads/main"], [MAIN]]);

    const two = new FakeGitHubApi({
      ...LISTED,
      ...branchTipRoute(TIPS),
      ...workflowFileRoute("deploy.yml", "on:\n  workflow_dispatch:\n    inputs:\n      a: {}\n"),
      ...workflowFileRoute("lint.yml", "on:\n  workflow_dispatch:\n    inputs:\n      b: {}\n"),
    });
    const lint: DispatchEntry = { verb: "lint", file: "lint.yml", ref: "default" };
    assert.match(await listed(two, pushedGit(), [PRODUCTION, lint]), /^deploy_production: [^\n]*\n {2}a \(string\)\n\nlint: [^\n]*\n {2}b \(string\)$/);

    const failing = new FakeGitHubApi({ ...REPO_ROUTE, "POST /graphql": { status: 502, text: "<html>\n\nBad gateway</html>" } });
    const text = await listed(failing, pushedGit(), [PRODUCTION, other]);
    assert.match(
      text,
      /^deploy_production: \.github\/workflows\/deploy\.yml\n {2}cannot dispatch now: checking \S+ failed: GitHub returned 502: <html> {2}Bad gateway<\/html>\.\n {2}cannot dispatch now: GitHub returned 502: <html> {2}Bad gateway<\/html>\.$/m,
    );
    assert.match(text, /^deploy_again: \.github\/workflows\/deploy\.yml\n {2}cannot dispatch now: /m);
  });

  it("says when the allowlist no longer lists a verb as at startup, or cannot be checked now", async () => {
    const one = "on: workflow_dispatch\n";
    const api = deployApi(one);
    Object.assign(api.routes, allowlistRoute("deploy_production: { workflow: other.yml, ref: default }\n"));
    assert.equal(
      await listed(api, pushedGit(), [PRODUCTION]),
      "deploy_production: .github/workflows/deploy.yml on main (default branch), at 444444444444\n" +
        "  cannot dispatch now: .github/swarmforge-dispatch.yml on main no longer lists deploy_production as it did at startup.\n" +
        "  no inputs",
    );

    const gone = deployApi(one);
    Object.assign(gone.routes, {
      ...allowlistRoute("other: { workflow: other.yml, ref: default }\n"),
      [`GET ${CONTENTS}`]: { status: 404, json: { message: "Not Found" } },
    });
    assert.deepEqual((await listed(gone, pushedGit(), [PRODUCTION])).split("\n").slice(0, 3), [
      "deploy_production: .github/workflows/deploy.yml",
      "  cannot dispatch now: .github/swarmforge-dispatch.yml on main no longer lists deploy_production as it did at startup.",
      "  cannot dispatch now: GitHub cannot see that workflow file in acme/widgets (404). Either it is not on that ref, or the token is no longer scoped to this repository.",
    ]);

    const down = deployApi(one);
    Object.assign(down.routes, { [`GET ${ALLOWLIST_PATH}`]: { status: 503, json: { message: "Service Unavailable" } } });
    assert.match(
      await listed(down, pushedGit(), [PRODUCTION]),
      /^ {2}cannot dispatch now: checking \.github\/swarmforge-dispatch\.yml failed: GitHub returned 503: Service Unavailable\.$/m,
    );
  });

  it("says why there are no verbs", async () => {
    const setup = (unusable?: string) =>
      listWorkflows(contextFor(new FakeGitHubApi(), pushedGit(), { defaultBranch: "main", entries: [], dropped: [], unusable }));

    assert.equal(await setup(), "No dispatch verbs this session: .github/swarmforge-dispatch.yml on main had none at startup.");
    assert.equal(await setup("GitHub has no branch main to read it from"), "No dispatch verbs this session: GitHub has no branch main to read it from.");
  });

  it("caps what it shows of an agent-written file", async () => {
    const options = Array.from({ length: 25 }, (_, i) => `o${i}`);
    const long = "v".repeat(100);
    const one = `on:\n  workflow_dispatch:\n    inputs:\n      c: { type: choice, options: [${options.join(", ")}], default: ${long} }\n`;

    const line = (await listed(deployApi(one), pushedGit(), [PRODUCTION])).split("\n")[1];
    assert.equal(line, `  c (choice): one of ${options.slice(0, 20).map((o) => `"${o}"`).join(", ")}, and 5 more; default "${"v".repeat(79)}…`);

    const unsafe = 'on:\n  workflow_dispatch:\n    inputs:\n      c: { type: choice, options: ["a\\u2028b\\u001b[2J"], default: "x\\u202ey" }\n';
    assert.equal((await listed(deployApi(unsafe), pushedGit(), [PRODUCTION])).split("\n")[1], '  c (choice): one of "ab\\u001b[2J"; default "xy"');

    const wide = (i: number) => `      i${i}: { type: choice, options: [${Array.from({ length: 20 }, () => "w".repeat(90)).join(", ")}], description: ${"d".repeat(250)} }`;
    const big = `on:\n  workflow_dispatch:\n    inputs:\n${Array.from({ length: 25 }, (_, i) => wide(i)).join("\n")}\n`;
    const lint: DispatchEntry = { verb: "lint", file: "lint.yml", ref: "default" };
    const api = deployApi(big);
    Object.assign(api.routes, workflowFileRoute("lint.yml", "on: workflow_dispatch\n"));
    const text = await listed(api, pushedGit(), [PRODUCTION, STAGING, lint], [{ verb: "old", why: "old.yml: gone" }]);
    assert.ok(text.length < 50_500, String(text.length));
    assert.equal(text.match(/^ {2}\.\.\.and \d+ more inputs$/gm)?.length, 2);
    assert.match(text, /\n\nlint: [^\n]*\n {2}no inputs\n\nold: dropped at startup\n {2}old\.yml: gone\.$/);

    const typed = 'on:\n  workflow_dispatch:\n    inputs:\n      n: { type: number, default: "1; default 2" }\n      h: { type: number, default: " 0x10" }\n      f: { type: boolean, default: false }\n      b: { type: boolean, default: "yes" }\n';
    assert.deepEqual((await listed(deployApi(typed), pushedGit(), [PRODUCTION])).split("\n").slice(1), [
      '  n (number): default "1; default 2"',
      '  h (number): default " 0x10"',
      "  f (boolean): default false",
      '  b (boolean): default "yes"',
    ]);
  });
});

describe("list_workflows", () => {
  async function toolNames(context: Context): Promise<string[]> {
    const [server, client] = InMemoryTransport.createLinkedPair();
    await buildServer(context).connect(server);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(client);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    await mcp.close();
    return names;
  }

  it("is listed only when dispatch is on", async () => {
    assert.ok(!(await toolNames(contextFor())).includes("list_workflows"));
    assert.ok((await toolNames(contextFor(undefined, undefined, { defaultBranch: "main", entries: [], dropped: [] }))).includes("list_workflows"));
    assert.ok((await toolNames(contextWith(deployApi()))).includes("list_workflows"));
  });
});
