import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LOG_OUTPUT_CHARS, ciJob, ciLog, ciStatus, clean, parseLog, stepRange } from "../src/ci.js";
import { GitHub } from "../src/github.js";
import {
  FakeGit,
  ACTIONS,
  FakeGitHubApi,
  ORIGIN,
  TOKEN,
  contextFor,
  getPrRoute,
  jobRoute,
  jobsRoute,
  logRoutes,
  runRoute,
  runsRoute,
  type JobState,
} from "./fakes.js";

const PUSHED = "1111111111111111111111111111111111111111";
const OTHER = "3333333333333333333333333333333333333333";

const pushedContext = (api: FakeGitHubApi, git = pushedGit()) => contextFor(api, git);

function pushedGit(head = PUSHED): FakeGit {
  const git = new FakeGit({ head });
  git.refs.set("refs/remotes/origin/feature", PUSHED);
  return git;
}

function runsOf(api: FakeGitHubApi): string[] {
  return api.calls
    .map((call) => new URL(call.url))
    .filter((url) => url.pathname.endsWith("/actions/runs"))
    .map((url) => url.searchParams.get("head_sha") ?? "");
}

describe("ci_status", () => {
  it("defaults to the checked-out branch as origin has it", async () => {
    const api = new FakeGitHubApi({ ...runsRoute([{ id: 100 }]), ...jobsRoute(100, [{ id: 7 }]) });

    const text = await ciStatus(pushedContext(api), {});

    assert.deepEqual(runsOf(api), [PUSHED]);
    assert.match(text, /^CI for origin\/feature at 111111111111: 1 workflow run, newest first\./);
    assert.doesNotMatch(text, /HEAD is at/);
  });

  it("says when HEAD is not what origin has", async () => {
    const api = new FakeGitHubApi(runsRoute([]));

    const text = await ciStatus(pushedContext(api, pushedGit(OTHER)), {});

    assert.deepEqual(runsOf(api), [PUSHED]);
    assert.match(text, /HEAD is at 333333333333, which is not what origin\/feature has\./);
  });

  it("checks a pull request's head", async () => {
    const api = new FakeGitHubApi({
      ...getPrRoute({ number: 9, title: "t", body: "b", base: "main", head: "topic", headSha: OTHER }),
      ...runsRoute([]),
    });

    const text = await ciStatus(pushedContext(api), { pr: 9 });

    assert.deepEqual(runsOf(api), [OTHER]);
    assert.match(text, /#9 \(topic at 333333333333\)/);
  });

  it("checks a given sha", async () => {
    const api = new FakeGitHubApi(runsRoute([]));

    await ciStatus(pushedContext(api), { sha: OTHER });

    assert.deepEqual(runsOf(api), [OTHER]);
  });

  it("refuses more than one of a sha, a pull request, and a run", async () => {
    const api = new FakeGitHubApi();

    await assert.rejects(() => ciStatus(pushedContext(api), { sha: OTHER, pr: 9 }), /at most one of/);
    await assert.rejects(() => ciStatus(pushedContext(api), { pr: 9, run: 100 }), /at most one of/);
    await assert.rejects(() => ciStatus(pushedContext(api), { sha: OTHER, run: 100 }), /at most one of/);
    assert.equal(api.calls.length, 0);
  });

  it("needs a branch origin has, by default", async () => {
    const api = new FakeGitHubApi();

    await assert.rejects(() => ciStatus(pushedContext(api, new FakeGit({ branch: null })), {}), /HEAD is detached/);
    await assert.rejects(() => ciStatus(pushedContext(api, new FakeGit()), {}), /origin has no feature; push it first/);
    assert.equal(api.calls.length, 0);
  });

  it("says runs may not have started yet", async () => {
    const api = new FakeGitHubApi(runsRoute([]));

    assert.match(await ciStatus(pushedContext(api), {}), /No workflow runs for .*\. If it was just pushed, runs can take/);
  });

  it("names each job's state, timing, and the step it failed at", async () => {
    const api = new FakeGitHubApi({
      ...runsRoute([{ id: 100, name: "CI", conclusion: "failure", attempt: 2 }]),
      ...jobsRoute(100, [
        { id: 7, name: "lint" },
        { id: 8, conclusion: "failure", steps: [{ name: "Set up job" }, { name: "Run tests", conclusion: "failure" }] },
        { id: 9, name: "deploy", status: "queued", conclusion: null },
      ]),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^CI \(push\): failure · ran 3m12s · run 100, attempt 2$/m);
    assert.match(text, /^https:\/\/github\.com\/acme\/widgets\/actions\/runs\/100$/m);
    assert.match(text, /^ {2}job 7 lint: success · queued 4s · ran 2m50s$/m);
    assert.match(text, /^ {2}job 8 test: failure at step 2 \(Run tests\) · queued 4s · ran 2m50s$/m);
    assert.match(text, /^ {2}job 9 deploy: queued · queued 4s · since 2026-10-07T12:00:04Z$/m);
  });

  it("says a running job's failed step failed, rather than that the job is at it", async () => {
    const api = new FakeGitHubApi({
      ...runsRoute([{ id: 100, status: "in_progress", conclusion: null }]),
      ...jobsRoute(100, [{ id: 8, status: "in_progress", conclusion: null, steps: [{ name: "Test", conclusion: "failure" }] }]),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^CI \(push\): in_progress · since 2026-10-07T12:00:00Z · run 100$/m);
    assert.match(text, /job 8 test: in_progress, step 1 \(Test\) failed/);
  });

  it("says when there are more runs or jobs than it shows", async () => {
    const api = new FakeGitHubApi({
      ...runsRoute([{ id: 1 }, { id: 2 }], 11),
      ...jobsRoute(1, [{ id: 1 }], 2),
      ...jobsRoute(2, [{ id: 2 }]),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /: 2\+ workflow runs, newest first\./);
    assert.equal(text.match(/\.\.\.and more jobs than the 1 shown/g)?.length, 1);
  });

  it("shows GitHub's names on one line, without control characters", async () => {
    const api = new FakeGitHubApi({ ...runsRoute([{ id: 100 }]), ...jobsRoute(100, [{ id: 7, name: "lint\njob 9 x: success\x1b[2J" }]) });

    assert.match(await ciStatus(pushedContext(api), {}), /^ {2}job 7 lint job 9 x: success: success · /m);
  });

  it("reports one run by id, with the commit it is for", async () => {
    const api = new FakeGitHubApi({ ...runRoute({ id: 100 }), ...jobsRoute(100, [{ id: 7 }]) });

    const text = await ciStatus(pushedContext(api), { run: 100 });

    assert.match(text, /^CI for run 100: feature at 1111111111111111111111111111111111111111\.$/m);
    assert.match(text, /^CI \(push\): success · ran 3m12s · run 100$/m);
    assert.match(text, /^ {2}job 7 test: success · /m);
    assert.equal(runsOf(api).length, 0);
  });

  it("cleans a run's branch, and copes with no branch or commit", async () => {
    const shown = async (run: Parameters<typeof runRoute>[0]) =>
      (await ciStatus(pushedContext(new FakeGitHubApi({ ...runRoute(run), ...jobsRoute(run.id, [{ id: 7 }]) })), { run: run.id }))
        .split("\n")[0];

    assert.equal(await shown({ id: 1, headBranch: "x\x1b[2J\njob 9" }), `CI for run 1: x job 9 at ${"1".repeat(40)}.`);
    assert.equal(await shown({ id: 2, headBranch: null }), `CI for run 2: ${"1".repeat(40)}.`);
    const unreported = { ...runRoute({ id: 3 }), ...jobsRoute(3, []) };
    delete (unreported[`GET ${ACTIONS}/runs/3`].json as { head_sha?: string }).head_sha;
    const text = await ciStatus(pushedContext(new FakeGitHubApi(unreported)), { run: 3 });
    assert.match(text, /^CI for run 3: feature at an unreported commit\.$/m);
    assert.doesNotMatch(text, /no jobs yet/);
  });

  it("says what holds a waiting or pending run, and when it has no jobs yet", async () => {
    const api = new FakeGitHubApi({
      ...runsRoute([
        { id: 100, status: "waiting", conclusion: null },
        { id: 101, status: "pending", conclusion: null },
      ]),
      ...jobsRoute(100, [{ id: 7, name: "deploy", status: "waiting", conclusion: null }]),
      ...jobsRoute(101, []),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^CI \(push\): waiting on environment protection rules, such as a required review · /m);
    assert.match(text, /^ {2}job 7 deploy: waiting · /m);
    assert.match(text, /^CI \(push\): pending, as when a concurrency group holds it · .*\n.*\n {2}no jobs yet$/m);
  });

  it("says when a successful run skipped jobs, or every job, and only then", async () => {
    const api = new FakeGitHubApi({
      ...runsRoute([{ id: 100 }, { id: 101, name: "Deploy" }, { id: 102, name: "Lint", conclusion: "failure" }]),
      ...jobsRoute(100, [{ id: 7 }, { id: 8, name: "deploy", conclusion: "skipped" }]),
      ...jobsRoute(101, [{ id: 9, name: "deploy", conclusion: "skipped" }]),
      ...jobsRoute(102, [{ id: 10, conclusion: "failure" }, { id: 11, conclusion: "skipped" }]),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^CI \(push\): success, 1 of 2 jobs skipped · /m);
    assert.match(text, /^Deploy \(push\): success, every job skipped · /m);
    assert.match(text, /^Lint \(push\): failure · /m);
    assert.match(text, /^ {2}job 8 deploy: skipped/m);
  });

  it("claims nothing about jobs past the first page", async () => {
    const api = new FakeGitHubApi({
      ...runsRoute([{ id: 100 }, { id: 101, name: "Deploy", conclusion: "cancelled" }]),
      ...jobsRoute(100, [{ id: 7, conclusion: "skipped" }], 101),
      ...jobsRoute(101, [{ id: 8, conclusion: "cancelled" }], 101),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^CI \(push\): success, 1 of the 1 jobs shown skipped · /m);
    assert.match(text, /^Deploy \(push\): cancelled · /m);
  });

  it("says when a run was cancelled before any step started", async () => {
    const unstarted = { name: "Migrate", conclusion: "cancelled", started_at: null, completed_at: null };
    const api = new FakeGitHubApi({
      ...runsRoute([
        { id: 100, conclusion: "cancelled" },
        { id: 101, conclusion: "cancelled" },
      ]),
      ...jobsRoute(100, [{ id: 7, conclusion: "cancelled" }, { id: 8, conclusion: "cancelled", steps: [unstarted] }]),
      ...jobsRoute(101, [{ id: 9, conclusion: "cancelled", steps: [{ name: "Migrate", conclusion: "cancelled" }] }]),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^CI \(push\): cancelled before any step ran · /m);
    assert.match(text, /^CI \(push\): cancelled · /m);
    assert.match(text, /job 9 test: cancelled at step 1 \(Migrate\)/);
  });

  it("names the steps a successful job skipped, up to a few", async () => {
    const skip = (name: string) => ({ name, conclusion: "skipped", started_at: null, completed_at: null });
    const api = new FakeGitHubApi({
      ...runsRoute([{ id: 100, conclusion: "failure" }]),
      ...jobsRoute(100, [
        { id: 7, steps: [{ name: "Build" }, skip("Deploy\x1b[2J")] },
        { id: 8, steps: [skip("a"), skip("b"), skip("c"), skip("d"), skip("e")] },
        { id: 9, conclusion: "failure", steps: [{ name: "Test", conclusion: "failure" }, skip("Upload")] },
      ]),
    });

    const text = await ciStatus(pushedContext(api), {});

    assert.match(text, /^ {2}job 7 test: success · queued 4s · ran 2m50s · skipped step 2 \(Deploy\)$/m);
    assert.match(text, /^ {2}job 8 test: success · .* · skipped steps 1 \(a\), 2 \(b\), 3 \(c\), and 2 more$/m);
    assert.match(text, /^ {2}job 9 test: failure at step 1 \(Test\) · queued 4s · ran 2m50s$/m);
  });

  it("refuses a pull request GitHub reports no head commit for", async () => {
    const pr = getPrRoute({ number: 9, title: "t", body: "b", base: "main", head: "topic" });
    (pr["GET /repos/acme/widgets/pulls/9"].json.head as { sha?: string }).sha = undefined;

    await assert.rejects(() => ciStatus(pushedContext(new FakeGitHubApi(pr)), { pr: 9 }), /no head commit for pull request #9/);
  });
});

describe("ci_job", () => {
  it("times each step against the job's start", async () => {
    const api = new FakeGitHubApi(
      jobRoute({
        id: 8,
        steps: [
          { name: "Set up job", started_at: "2026-10-07T12:00:04Z", completed_at: "2026-10-07T12:00:06Z" },
          { name: "Run tests", started_at: "2026-10-07T12:00:44Z", completed_at: "2026-10-07T12:02:54Z" },
          { name: "Deploy", conclusion: "skipped", started_at: null, completed_at: null },
        ],
      }),
    );

    const text = await ciJob(pushedContext(api), { job_id: 8 });

    assert.match(text, /^job 8 test: success · run 100, attempt 1$/m);
    assert.match(text, /^runner GitHub Actions 12 \(ubuntu-latest\) · queued 4s · ran 2m50s$/m);
    assert.match(text, /^ {2}1\. Set up job: success · at \+0s · took 2s$/m);
    assert.match(text, /^ {2}2\. Run tests: success · at \+40s · took 2m10s$/m);
    assert.match(text, /^ {2}3\. Deploy: skipped$/m);
  });
});

const T = (s: number) => `2026-10-07T12:00:${String(s).padStart(2, "0")}.5000000Z`;

/** Steps at 4-5s, 6-9s, and 10-12s, with one log line per second. */
const STEPPED: JobState = {
  id: 8,
  conclusion: "failure",
  steps: [
    { name: "Set up job", started_at: "2026-10-07T12:00:04Z", completed_at: "2026-10-07T12:00:05Z" },
    {
      name: "Run tests",
      conclusion: "failure",
      started_at: "2026-10-07T12:00:06Z",
      completed_at: "2026-10-07T12:00:09Z",
    },
    { name: "Post", started_at: "2026-10-07T12:00:10Z", completed_at: "2026-10-07T12:00:12Z" },
  ],
};
const STEPPED_LOG = Array.from({ length: 9 }, (_, i) => `${T(i + 4)} line ${i + 4}`).join("\n") + "\n";

function logApi(job: JobState, log: string): FakeGitHubApi {
  return new FakeGitHubApi({ ...jobRoute(job), ...logRoutes(job.id, log) });
}

function body(text: string): string[] {
  return text.split("\n\n")[1].split("\n");
}

describe("ci_log", () => {
  it("opens a failed job's log at the step that failed", async () => {
    const text = await ciLog(pushedContext(logApi(STEPPED, STEPPED_LOG)), { job_id: 8 });

    assert.match(text, /^job 8 test \(failure\): step 2 \(Run tests\), log lines 3-6; showing 3-6\.$/m);
    assert.deepEqual(body(text), [6, 7, 8, 9].map((s) => `${T(s)} line ${s}`));
  });

  it("shows the end of a job that did not fail", async () => {
    const job = { ...STEPPED, conclusion: "success", steps: [] };

    const text = await ciLog(pushedContext(logApi(job, STEPPED_LOG)), { job_id: 8, limit: 2 });

    assert.match(text, /log lines 1-9; showing 8-9\./);
    assert.match(text, /Earlier: call ci_log with limit=2, start=6\.$/);
  });

  it("reads a named step, and pages forward within it", async () => {
    const api = logApi(STEPPED, STEPPED_LOG);

    const first = await ciLog(pushedContext(api), { job_id: 8, step: 3, start: 7, limit: 2 });

    assert.deepEqual(body(first), [`${T(10)} line 10`, `${T(11)} line 11`]);
    assert.match(first, /Later: call ci_log with step=3, limit=2, start=9\.$/);
  });

  it("pages the whole log once 'start' is given", async () => {
    const text = await ciLog(pushedContext(logApi(STEPPED, STEPPED_LOG)), { job_id: 8, start: 1, limit: 3 });

    assert.match(text, /log lines 1-9; showing 1-3\./);
    assert.match(text, /Later: call ci_log with limit=3, start=4\.$/);
  });

  it("refuses a start outside the range, and says when a step has no lines", async () => {
    const api = logApi(STEPPED, STEPPED_LOG);

    await assert.rejects(() => ciLog(pushedContext(api), { job_id: 8, start: 10 }), /start=10 is outside log lines 1-9/);
    await assert.rejects(() => ciLog(pushedContext(api), { job_id: 8, step: 3, start: 2 }), /outside step 3 \(Post\), log lines 7-9/);
    const late = { ...STEPPED, steps: [{ name: "Late", started_at: "2026-10-07T12:05:00Z", completed_at: null }] };
    assert.match(await ciLog(pushedContext(logApi(late, STEPPED_LOG)), { job_id: 8, step: 1 }), /step 1 has no lines\.$/);
  });

  it("opens at the whole log when the failed step never started", async () => {
    const job = { ...STEPPED, conclusion: "cancelled", steps: [{ name: "Wait", conclusion: "cancelled", started_at: null }] };

    assert.match(await ciLog(pushedContext(logApi(job, STEPPED_LOG)), { job_id: 8 }), /: log lines 1-9; showing 1-9\./);
  });

  it("reads the end of a job still running", async () => {
    const job = { ...STEPPED, status: "in_progress", conclusion: null };

    assert.match(await ciLog(pushedContext(logApi(job, STEPPED_LOG)), { job_id: 8, limit: 1 }), /showing 9-9\.\n\n.* line 12$/m);
  });

  it("refuses a step the job does not have, and one that never ran", async () => {
    const job = { ...STEPPED, steps: [...STEPPED.steps!, { name: "Skipped", started_at: null, completed_at: null }] };
    const api = logApi(job, STEPPED_LOG);

    await assert.rejects(() => ciLog(pushedContext(api), { job_id: 8, step: 9 }), /has no step 9/);
    await assert.rejects(() => ciLog(pushedContext(api), { job_id: 8, step: 4 }), /never started/);
    assert.ok(!api.calls.some((call) => call.url.includes("/logs")), "a bad step must not download the log");
  });

  it("strips terminal escapes and clips very long lines", async () => {
    const log = `${T(4)} \x1b[36;1mcolored\x1b[0m\x07\x1b]8;;https://evil\x07\u202e\u009b\n${T(5)} ${"y".repeat(5000)}\n`;
    const job = { ...STEPPED, conclusion: "success" };

    const lines = body(await ciLog(pushedContext(logApi(job, log)), { job_id: 8 }));

    assert.equal(lines[0], `${T(4)} colored`);
    assert.match(lines[1], /y{900}\.\.\. \(\d+ more characters\)$/);
    assert.ok(lines[1].length < 1100);
  });

  describe("however many lines are asked for, the output is capped", () => {
    const log = Array.from({ length: 1000 }, (_, i) => `${T(4)} ${String(i).padStart(4, "0")} ${"z".repeat(500)}`).join("\n");
    const job = { ...STEPPED, conclusion: "success" };
    const shown = (text: string) => text.match(/showing (\d+)-(\d+)\./)!.slice(1).map(Number);

    it("keeping the end, and stepping back by what it showed", async () => {
      const text = await ciLog(pushedContext(logApi(job, log)), { job_id: 8, limit: 1000 });

      assert.ok(text.length < MAX_LOG_OUTPUT_CHARS + 200, String(text.length));
      assert.match(body(text).at(-1)!, / 0999 z+$/);
      const [from, to] = shown(text);
      assert.equal(to, 1000);
      assert.match(text, new RegExp(`Earlier: call ci_log with limit=1000, start=${from - (to - from + 1)}\\.$`));
    });

    it("paging forward from where it stopped", async () => {
      const text = await ciLog(pushedContext(logApi(job, log)), { job_id: 8, start: 1, limit: 1000 });

      assert.ok(text.length < MAX_LOG_OUTPUT_CHARS + 200, String(text.length));
      const [from, to] = shown(text);
      assert.equal(from, 1);
      assert.match(text, new RegExp(`Later: call ci_log with limit=1000, start=${to + 1}\\.$`));
    });

    it("stepping back by what it showed, when paging forward", async () => {
      const text = await ciLog(pushedContext(logApi(job, log)), { job_id: 8, start: 500, limit: 1000 });

      const [from, to] = shown(text);
      assert.equal(from, 500);
      assert.match(text, new RegExp(`Earlier: call ci_log with limit=1000, start=${from - (to - from + 1)}\\.$`, "m"));
    });
  });

  it("says when only the end of the log was kept", async () => {
    const api = logApi({ ...STEPPED, conclusion: "success" }, STEPPED_LOG);
    const github = new GitHub(api.fetch, ORIGIN, TOKEN);
    github.jobLog = async () => ({ text: STEPPED_LOG, truncated: true });

    const text = await ciLog({ ...contextFor(api), github }, { job_id: 8 });

    assert.match(text, /Only the end of this log was kept/);
  });
});

describe("clean", () => {
  it("keeps tabs and printable text, and puts a name on one line", () => {
    assert.equal(clean("a\tb\nc\r\u200bd"), "a\tb cd");
    assert.equal(clean("a\u2028b\u2029c\u2060\ufeff\u061cd"), "abcd");
  });
});

describe("log parsing", () => {

  it("gives an unstamped line the time of the one before", () => {
    const lines = parseLog(`﻿${T(4)} a\r\ncontinued\n${T(6)} b\n`);

    assert.deepEqual(
      lines.map((line) => line.text),
      [`${T(4)} a`, "continued", `${T(6)} b`],
    );
    assert.equal(lines[1].time, lines[0].time);
  });

  it("takes in the whole first and last second of a step", () => {
    const lines = parseLog(STEPPED_LOG);

    assert.deepEqual(stepRange(lines, "2026-10-07T12:00:06Z", "2026-10-07T12:00:09Z"), [2, 6]);
    assert.deepEqual(stepRange(lines, "2026-10-07T12:00:06Z", null), [2, 9]);
    assert.deepEqual(stepRange(lines, "2026-10-07T12:01:00Z", "2026-10-07T12:01:01Z"), [9, 9]);
  });
});
