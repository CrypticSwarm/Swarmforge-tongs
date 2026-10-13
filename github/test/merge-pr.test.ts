import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, GitHubError, MAX_FIND_RESULTS, type MergeMethod } from "../src/github.js";
import { mergePr } from "../src/server.js";
import {
  FakeGitHubApi,
  ORIGIN,
  TOKEN,
  contextFor,
  mergeRoutes,
  prConnection,
  type FakeResponse,
  type MergeableState,
} from "./fakes.js";

const MERGE = "PUT https://api.github.com/repos/acme/widgets/pulls/7/merge";

function apiFor(pr: Partial<MergeableState> = {}, merge?: FakeResponse): FakeGitHubApi {
  return new FakeGitHubApi(mergeRoutes({ number: 7, ...pr }, merge));
}

/** A GraphQL branch read answering `repository`. */
const branchReply = (repository: unknown): FakeResponse => ({ status: 200, json: { data: { repository } } });
const rules = { totalCount: 0, nodes: [] };
const none = prConnection([]);

const merged = (api: FakeGitHubApi) => api.calls.some((call) => `${call.method} ${call.url}` === MERGE);

describe("merge_pr", () => {
  it("merges with a merge commit by default, pinned to the head it checked", async () => {
    const api = apiFor({ headSha: "a".repeat(40) });

    const text = await mergePr(contextFor(api), { number: 7 });

    assert.deepEqual(api.lastBody, { merge_method: "merge", sha: "a".repeat(40) });
    assert.match(text, /^Merged #7 into main \(merge\) as 333333333333\.\nhttps:\/\/github\.com\/acme\/widgets\/pull\/7$/);
  });

  for (const method of ["squash", "rebase"] satisfies MergeMethod[]) {
    it(`passes ${method} through`, async () => {
      const api = apiFor();
      await mergePr(contextFor(api), { number: 7, method });
      assert.equal((api.lastBody as { merge_method: string }).merge_method, method);
    });
  }

  for (const status of ["HAS_HOOKS", "UNSTABLE"]) {
    it(`merges a pull request GitHub reports ${status}`, async () => {
      const api = apiFor({ status });
      await mergePr(contextFor(api), { number: 7 });
      assert.ok(merged(api));
    });
  }

  const refusals: Array<[Partial<MergeableState>, RegExp]> = [
    [{ status: "BLOCKED" }, /branch protection or a ruleset blocks it/],
    [{ status: "BEHIND", base: "release" }, /behind release/],
    [{ status: "DIRTY", base: "release" }, /conflicts with release/],
    [{ status: "UNKNOWN" }, /Try again/],
    [{ status: "SOMETHING_NEW\x1b[2J" }, /merge state as SOMETHING_NEW\.$/],
    [{ draft: true }, /is a draft/],
    [{ mergeQueue: true, base: "release" }, /release requires a merge queue/],
    [{ state: "CLOSED" }, /it is closed/],
    [{ headSha: "" }, /did not report the merge state/],
    [{ state: "open" as MergeableState["state"] }, /did not report the merge state/],
  ];
  for (const [pr, message] of refusals) {
    it(`refuses ${JSON.stringify(pr)} without asking GitHub to merge`, async () => {
      const api = apiFor(pr);
      await assert.rejects(() => mergePr(contextFor(api), { number: 7 }), message);
      assert.ok(!merged(api));
    });
  }

  it("reports an already merged pull request without merging again", async () => {
    const api = apiFor({ state: "MERGED", status: "UNKNOWN" });
    assert.match(await mergePr(contextFor(api), { number: 7 }), /already merged; nothing to do/);
    assert.ok(!merged(api));
  });

  const fields = [
    "url",
    "baseRefName",
    "headRefName",
    "isCrossRepository",
    "state",
    "isDraft",
    "headRefOid",
    "mergeStateStatus",
    "isMergeQueueEnabled",
  ];
  const malformed: Array<[string, unknown]> = [
    ...fields.flatMap((field) => [[field, undefined], [field, null]] as Array<[string, unknown]>),
    ["isCrossRepository", "false"],
    ["headRefName", 7],
  ];
  for (const [field, value] of malformed) {
    it(`refuses a reply with ${field} ${JSON.stringify(value) ?? "missing"} rather than assuming it`, async () => {
      const routes = mergeRoutes({ number: 7 });
      const read = routes["POST /graphql"];
      const api = new FakeGitHubApi({
        ...routes,
        "POST /graphql": (call) => {
          const reply = read(call);
          (reply.json.data.repository as { pullRequest: Record<string, unknown> }).pullRequest[field] = value;
          return reply;
        },
      });
      await assert.rejects(() => mergePr(contextFor(api), { number: 7 }), /did not report the merge state/);
      assert.ok(!merged(api));
    });
  }

  it("reads the merge state of the pinned repository through variables, not the query text", async () => {
    const api = apiFor();

    await mergePr(contextFor(api), { number: 7 });

    const { query, variables } = api.calls[0].body as { query: string; variables: unknown };
    assert.deepEqual(variables, { owner: "acme", name: "widgets", number: 7 });
    assert.doesNotMatch(query, /acme|widgets|\b7\b/);
    assert.deepEqual(
      api.calls.map((call) => `${call.method} ${call.url}`),
      ["POST https://api.github.com/graphql", MERGE],
    );
  });

  it("says a merge GitHub never answered may have landed", async () => {
    const api = new FakeGitHubApi({
      ...mergeRoutes({ number: 7 }),
      [MERGE.replace(" https://api.github.com", " ")]: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    await assert.rejects(() => mergePr(contextFor(api), { number: 7 }), /timeout\n\nThe merge may have landed anyway/);
  });

  it("does not say a merge refused before reaching GitHub may have landed", async () => {
    const context = contextFor(apiFor());
    context.github.merge = async () => {
      throw new GitHubError("'x' is not a commit sha", 0);
    };
    await assert.rejects(
      () => mergePr(context, { number: 7 }),
      (err: Error) => /is not a commit sha/.test(err.message) && !/may have landed/.test(err.message),
    );
  });

  it("says a merge behind a gateway error may have landed", async () => {
    const api = apiFor({}, { status: 502, json: { message: "Bad Gateway" } });
    await assert.rejects(() => mergePr(contextFor(api), { number: 7 }), /502: Bad Gateway\.\n\nThe merge may have landed/);
  });

  it("refuses a number that is not a pull request before calling GitHub", async () => {
    const api = apiFor();
    await assert.rejects(() => contextFor(api).github.mergeState(0), /is not a pull request number/);
    await assert.rejects(() => contextFor(api).github.merge(1.5, "merge", "2".repeat(40)), /is not a pull request number/);
    assert.equal(api.calls.length, 0);
  });

  const failures: Array<[number, string, RegExp]> = [
    [409, "Head branch was modified. Review and try the merge again.", /409: Head branch was modified/],
    [405, "Merge commits are not allowed on this repository.", /405: Merge commits are not allowed/],
    [403, "Resource not accessible by personal access token", /Contents: read and write/],
    [404, "Not Found", /the number names no pull request/],
  ];
  for (const [status, message, expected] of failures) {
    it(`explains GitHub's ${status} on the merge`, async () => {
      const api = apiFor({}, { status, json: { message } });
      await assert.rejects(
        () => mergePr(contextFor(api), { number: 7 }),
        (err: Error) => expected.test(err.message) && !/may have landed/.test(err.message),
      );
      assert.equal((api.lastBody as { sha: string }).sha, "2".repeat(40));
    });
  }

  it("names the pull request when GitHub cannot see it", async () => {
    const api = new FakeGitHubApi({
      "POST /graphql": {
        status: 200,
        json: { errors: [{ message: "Could not resolve to a PullRequest with the number of 7." }] },
      },
    });
    await assert.rejects(() => mergePr(contextFor(api), { number: 7 }), /Could not resolve to a PullRequest/);
  });
});

describe("head branch lookups", () => {
  const client = (api: FakeGitHubApi) => new GitHub(api.fetch, ORIGIN, TOKEN);
  const branchApi = (repository: unknown) => new FakeGitHubApi({ "POST /graphql": branchReply(repository) });
  const ref = (fields: Record<string, unknown>) => ({
    ref: { refUpdateRule: null, rules, associatedPullRequests: none, ...fields },
    pullRequests: none,
  });

  it("reads the head branch and whether it is in a fork", async () => {
    const state = await client(apiFor({ head: "topic", crossRepository: true })).mergeState(7);
    assert.equal(state.head, "topic");
    assert.equal(state.crossRepository, true);
  });

  it("reads a branch through variables, against the pinned repository", async () => {
    const api = apiFor({ head: "feature", heads: [31], dependents: [12, 13] });

    assert.deepEqual(await client(api).deleteState("feature"), {
      restricted: false,
      heads: { items: [31], total: 1 },
      dependents: { items: [12, 13], total: 2 },
    });
    assert.equal(await client(apiFor({ headDeleted: true })).deleteState("feature"), null);

    const { query, variables } = api.calls[0].body as { query: string; variables: unknown };
    assert.deepEqual(variables, { owner: "acme", name: "widgets", ref: "refs/heads/feature", branch: "feature" });
    assert.doesNotMatch(query, /acme|widgets|feature/);
    assert.match(query, /rules\(first: 100\)/);
    assert.match(query, /associatedPullRequests\(states: OPEN, first: 10\)/);
    assert.match(query, /pullRequests\(baseRefName: \$branch, states: OPEN, first: 10\)/);
  });

  const readings: Array<[string, Record<string, unknown>, boolean]> = [
    ["protection that allows deletion", { refUpdateRule: { allowsDeletions: true } }, false],
    ["protection that forbids deletion", { refUpdateRule: { allowsDeletions: false } }, true],
    ["a lone deletion rule", { rules: { totalCount: 1, nodes: [{ type: "DELETION" }] } }, true],
    ["more rules than it listed", { rules: { totalCount: 101, nodes: Array(100).fill({ type: "PULL_REQUEST" }) } }, true],
    ["a rule it was not shown", { rules: { totalCount: 1, nodes: [] } }, true],
  ];
  for (const [what, fields, restricted] of readings) {
    it(`reads ${what} as ${restricted ? "restricted" : "unrestricted"}`, async () => {
      assert.equal((await client(branchApi(ref(fields))).deleteState("feature"))?.restricted, restricted);
    });
  }

  const unknowns: Array<[string, unknown]> = [
    ["no ref field", {}],
    ["no repository", null],
    ["no protection field", { ...ref({}), ref: { rules, associatedPullRequests: none } }],
    ["a malformed protection rule", ref({ refUpdateRule: { allowsDeletions: "false" } })],
    ["no rules", ref({ rules: null })],
    ["no head pull requests", ref({ associatedPullRequests: undefined })],
    ["no dependents", { ...ref({}), pullRequests: undefined }],
    ["a list without a count", ref({ rules: { nodes: [] } })],
    ["a list without nodes", ref({ rules: { totalCount: 0 } })],
    ["a null node", ref({ rules: { totalCount: 2, nodes: [null, { type: "DELETION" }] } })],
    ["a node without its field", ref({ rules: { totalCount: 1, nodes: [{}] } })],
    [
      "a later node of the wrong type",
      ref({ associatedPullRequests: { totalCount: 2, nodes: [{ number: 8 }, { number: "9" }] } }),
    ],
    ["a fractional head pull request number", ref({ associatedPullRequests: { totalCount: 1, nodes: [{ number: 1.5 }] } })],
    ["a fractional dependent number", { ...ref({}), pullRequests: { totalCount: 1, nodes: [{ number: 1.5 }] } }],
  ];
  for (const [what, repository] of unknowns) {
    it(`refuses to read ${what} as anything but unknown`, async () => {
      await assert.rejects(() => client(branchApi(repository)).deleteState("feature"), /did not fully describe/);
    });
  }
});
