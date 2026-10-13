import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunError } from "../src/exec.js";
import { GitHub, GitHubError, MAX_FIND_RESULTS, type MergeMethod } from "../src/github.js";
import { mergePr } from "../src/server.js";
import {
  FakeGit,
  FakeGitHubApi,
  ORIGIN,
  TOKEN,
  contextFor,
  mergeRoutes,
  prConnection,
  type FakeResponse,
  type FetchCall,
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

  it("reports an already merged pull request without merging or deleting", async () => {
    const api = apiFor({ state: "MERGED", status: "UNKNOWN" });
    const git = new FakeGit();
    assert.match(await mergePr(contextFor(api, git), { number: 7 }), /already merged; nothing to do/);
    assert.deepEqual(api.calls.map((call) => call.method), ["POST"]);
    assert.equal(git.calls.length, 0);
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

  it("strips control and bidi characters from the base it names", async () => {
    assert.match(await mergePr(contextFor(apiFor({ base: "r\u202eel" })), { number: 7 }), /^Merged #7 into rel /);
    for (const pr of [{ status: "BEHIND" }, { mergeQueue: true }]) {
      await assert.rejects(
        () => mergePr(contextFor(apiFor({ base: "r\u202eel", ...pr })), { number: 7 }),
        (err: Error) => /\brel\b/.test(err.message) && !/\u202e/.test(err.message),
      );
    }
  });

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

describe("merge_pr delete_branch", () => {
  const SHA = "2".repeat(40);
  const MERGE_STATE = ["POST /graphql", "PUT /repos/acme/widgets/pulls/7/merge"];
  const routes = (api: FakeGitHubApi) => api.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
  const STALE = { stdout: "!\t(delete):refs/heads/feature\t[rejected] (stale info)\n", stderr: "error: failed to push" };
  const isBranchRead = (call: FetchCall) => /\bref\(qualifiedName:/.test((call.body as { query?: string })?.query ?? "");

  async function mergeDeleting(pr: Partial<MergeableState> = {}, git = new FakeGit(), api = apiFor(pr)) {
    const text = await mergePr(contextFor(api, git), { number: 7, delete_branch: true });
    return { api, git, text };
  }

  /** apiFor, but the head branch read answers `reply`. */
  function branchReadAnswering(reply: FakeResponse): FakeGitHubApi {
    const api = apiFor();
    const read = api.routes["POST /graphql"] as (call: FetchCall) => FakeResponse;
    api.routes["POST /graphql"] = (call) => (isBranchRead(call) ? reply : read(call));
    return api;
  }

  for (const input of [{}, { delete_branch: false }]) {
    it(`does nothing more with ${JSON.stringify(input)}`, async () => {
      const api = apiFor();
      const git = new FakeGit();
      const text = await mergePr(contextFor(api, git), { number: 7, ...input });
      assert.deepEqual(routes(api), MERGE_STATE);
      assert.equal(git.calls.length, 0);
      assert.doesNotMatch(text, /delete/);
    });
  }

  it("deletes the head after the merge, with a push leased to the merged sha", async () => {
    const { api, git, text } = await mergeDeleting({ head: "feature/x" });

    assert.deepEqual(routes(api), [...MERGE_STATE, "GET /repos/acme/widgets", "POST /graphql"]);
    assert.ok(git.pushCall!.verb.includes(`--force-with-lease=refs/heads/feature/x:${SHA}`));
    assert.equal(git.pushCall!.verb.at(-1), ":refs/heads/feature/x");
    assert.match(text, /^Merged #7 into main \(merge\) as 333333333333; deleted `feature\/x`\.\nhttps:/);
  });

  it("deletes the head of an earlier merge", async () => {
    const { api, git, text } = await mergeDeleting({ state: "MERGED", status: "UNKNOWN" });
    assert.ok(!merged(api));
    assert.equal(git.pushCall!.verb.at(-1), ":refs/heads/feature");
    assert.match(text, /^#7 is already merged; deleted `feature`\./);
  });

  it("deletes a head whose only open pull request is this one", async () => {
    const { git, text } = await mergeDeleting({ heads: [7] });
    assert.ok(git.pushCall);
    assert.match(text, /; deleted `feature`\./);
  });

  it("checks for a fork before reading anything else", async () => {
    const { api, git, text } = await mergeDeleting({ crossRepository: true, head: "main", headDeleted: true });
    assert.match(text, /; did not delete `main`: it is in a fork\.\n/);
    assert.deepEqual(routes(api), MERGE_STATE);
    assert.equal(git.calls.length, 0);
  });

  const kept: Array<[string, Partial<MergeableState>, RegExp]> = [
    ["the default branch", { head: "main", base: "release" }, /did not delete `main`: it is the default branch\./],
    [
      "the head of another open pull request",
      { heads: [31] },
      /did not delete `feature`: deleting it would close open pull request #31, which has the same head\./,
    ],
    [
      "the head of two other open pull requests",
      { heads: [7, 31, 32] },
      /would close open pull requests #31, #32, which have the same head\./,
    ],
    [
      "the base of an open pull request",
      { dependents: [12] },
      new RegExp(
        "did not delete `feature`: it is the base of open pull request #12\\. Retarget it to another base " +
          "with update_pr, then call merge_pr again with delete_branch\\.\\n",
      ),
    ],
    [
      "the base of two open pull requests",
      { dependents: [20, 21] },
      /it is the base of open pull requests #20, #21\. Retarget them to another base/,
    ],
    [
      "the base of more open pull requests than one read lists",
      { dependents: Array.from({ length: MAX_FIND_RESULTS + 1 }, (_, i) => 20 + i) },
      /it is the base of open pull requests #20, .*#29, and 1 more\. Retarget them/,
    ],
    [
      "a branch its protection keeps",
      { restrictedBy: "protection" },
      /restricts deleting it, and the tong uses no bypass\./,
    ],
    ["a branch a ruleset keeps", { restrictedBy: "ruleset" }, /restricts deleting it, and the tong uses no bypass\./],
  ];
  for (const [what, pr, message] of kept) {
    it(`leaves ${what}, and still reports the merge`, async () => {
      const { api, git, text } = await mergeDeleting(pr);
      assert.ok(merged(api));
      assert.match(text, /^Merged #7 into \S+ \(merge\) as 333333333333; did not delete /);
      assert.match(text, message);
      assert.equal(git.pushCall, undefined);
    });
  }

  const unlisted: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "heads",
      {
        ref: { refUpdateRule: null, rules, associatedPullRequests: { totalCount: 2, nodes: [{ number: 7 }] } },
        pullRequests: none,
      },
      /; did not delete `feature`: deleting it would close 1 open pull request, which has the same head\./,
    ],
    [
      "dependents",
      { ref: { refUpdateRule: null, rules, associatedPullRequests: none }, pullRequests: { totalCount: 1, nodes: [] } },
      /; did not delete `feature`: it is the base of 1 open pull request\. Retarget it/,
    ],
  ];
  for (const [what, repository, message] of unlisted) {
    it(`counts ${what} GitHub did not list`, async () => {
      const { git, text } = await mergeDeleting({}, new FakeGit(), branchReadAnswering(branchReply(repository)));
      assert.match(text, message);
      assert.equal(git.pushCall, undefined);
    });
  }

  it("leaves the head of another open pull request after an earlier merge", async () => {
    const { git, text } = await mergeDeleting({ state: "MERGED", heads: [31] });
    assert.match(text, /^#7 is already merged; did not delete `feature`: deleting it would close open pull request #31/);
    assert.equal(git.pushCall, undefined);
  });

  it("says a head that is already gone is gone, without pushing", async () => {
    const { git, text } = await mergeDeleting({ headDeleted: true });
    assert.match(text, /^Merged #7 .*; `feature` is gone\.\n/);
    assert.equal(git.pushCall, undefined);
  });

  const unread: Array<[string, FakeResponse, RegExp]> = [
    ["fails", { status: 502, json: { message: "Bad Gateway" } }, /GitHub returned 502: Bad Gateway\./],
    [
      "leaves out the rules",
      branchReply({ ref: { refUpdateRule: null, associatedPullRequests: none }, pullRequests: none }),
      /GitHub did not fully describe the branch\./,
    ],
  ];
  for (const [what, reply, message] of unread) {
    it(`leaves the branch when the branch read ${what}, and says to retry`, async () => {
      const { git, text } = await mergeDeleting({}, new FakeGit(), branchReadAnswering(reply));
      assert.match(text, /^Merged #7 .*; did not delete `feature`: /);
      assert.match(text, message);
      assert.match(text, / Call merge_pr again with delete_branch to retry\.\n/);
      assert.equal(git.pushCall, undefined);
    });
  }

  it("leaves the branch when reading the repository fails, and still reports the merge", async () => {
    const api = apiFor();
    api.routes["GET /repos/acme/widgets"] = { status: 502, json: { message: "Bad Gateway" } };
    const { git, text } = await mergeDeleting({}, new FakeGit(), api);
    assert.match(text, /^Merged #7 .*; did not delete `feature`: GitHub returned 502: Bad Gateway\./);
    assert.equal(git.pushCall, undefined);
  });

  const timedOut = () => new FakeGit({ pushThrows: new RunError("git timed out after 60s") });
  const unsure: Array<[string, Partial<MergeableState>, FakeGit, RegExp]> = [
    [
      "a refused push, with the branch still there",
      {},
      new FakeGit({ pushFails: STALE }),
      /; did not delete `feature`: git refused the push: .*stale info.* error: failed to push\.\n/,
    ],
    [
      "a refused push, with an incomplete answer",
      { refAfterPush: "partial" },
      new FakeGit({ pushFails: STALE }),
      /; `feature` may be gone: git refused the push: .*stale info.* failed to push\. Call merge_pr again .* to check\.\n/,
    ],
    [
      "a refused push, with the branch gone",
      { refAfterPush: "absent" },
      new FakeGit({ pushFails: STALE }),
      /; `feature` is gone\.\n/,
    ],
    [
      "a push that could not run",
      {},
      new FakeGit({ pushThrows: new RunError("cannot run git: spawn git ENOENT") }),
      /; did not delete `feature`: cannot run git: spawn git ENOENT\.\n/,
    ],
    ["a killed push, with the branch still there", {}, timedOut(), /; did not delete `feature`: git timed out after 60s\.\n/],
    ["a killed push, with the branch gone", { refAfterPush: "absent" }, timedOut(), /; `feature` is gone\.\n/],
    [
      "a killed push, with an incomplete answer",
      { refAfterPush: "partial" },
      timedOut(),
      /; `feature` may be gone: git timed out after 60s\. Call merge_pr again with delete_branch to check\.\n/,
    ],
  ];
  for (const [what, pr, git, message] of unsure) {
    it(`reads the branch again after ${what}`, async () => {
      const { api, text } = await mergeDeleting(pr, git);
      assert.match(text, message);
      assert.equal(api.calls.filter(isBranchRead).length, 2);
    });
  }

  for (const head of ["a:b", "a:b‮c"]) {
    it(`reports the refusal to push ${JSON.stringify(head)} without asking again whether it is gone`, async () => {
      const { api, git, text } = await mergeDeleting({ head, refAfterPush: "absent" });
      assert.match(text, /did not delete `a:bc?`: branch name 'a:bc?' is not one this tong will build a refspec from\./);
      assert.doesNotMatch(text, /‮/);
      assert.equal(git.pushCall, undefined);
      assert.equal(api.calls.filter(isBranchRead).length, 1);
    });
  }

  it("pushes the head's raw name, and strips control and bidi characters from what it shows", async () => {
    const head = "x‮y\u0085z";
    const stale = { stdout: `!\t(delete):refs/heads/${head}\t[rejected] (stale info)\n`, stderr: "" };
    const { git, text } = await mergeDeleting({ head }, new FakeGit({ pushFails: stale }));
    assert.equal(git.pushCall!.verb.at(-1), `:refs/heads/${head}`);
    assert.ok(git.pushCall!.verb.includes(`--force-with-lease=refs/heads/${head}:${SHA}`));
    assert.match(text, /did not delete `xyz`: git refused the push: .*refs\/heads\/xyz/);
    assert.doesNotMatch(text, /[‮\u0085]/);
  });

  const notMerged: Array<[string, Partial<MergeableState>, FakeResponse | undefined]> = [
    ["refused", { status: "BLOCKED" }, undefined],
    ["failed", {}, { status: 409, json: { message: "moved" } }],
  ];
  for (const [what, pr, merge] of notMerged) {
    it(`deletes nothing when the merge is ${what}`, async () => {
      const api = apiFor(pr, merge);
      const git = new FakeGit();
      await assert.rejects(() => mergePr(contextFor(api, git), { number: 7, delete_branch: true }));
      assert.equal(git.calls.length, 0);
      assert.deepEqual(routes(api), merge ? MERGE_STATE : ["POST /graphql"]);
    });
  }
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
