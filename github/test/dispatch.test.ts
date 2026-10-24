import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchEntry, Dropped } from "../src/allowlist.js";
import { checkInputs, dispatch, dispatchInputs, loadDispatch, type InputSpec } from "../src/dispatch.js";
import { RESERVED_VERBS, buildServer, dispatchInstructions } from "../src/server.js";
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
const LISTING = "deploy_production: { workflow: deploy.yml, ref: default }\ndeploy_staging: { workflow: deploy.yml, ref: current }\n";
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
      { name: "x", type: "string", required: false, hasDefault: false, options: [] },
    ]);
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
      ['on:\n  workflow_dispatch:\n    inputs:\n      __proto__: {}\n', /input __proto__ has a name this tong cannot pass/],
      ["on: push\non: workflow_dispatch\n", /not valid YAML/],
      ["on: push\n---\non: workflow_dispatch\n", /not valid YAML/],
      ["%YAML 1.1\n---\non: workflow_dispatch\n", /YAML version other than 1\.2/],
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
    options: [],
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
