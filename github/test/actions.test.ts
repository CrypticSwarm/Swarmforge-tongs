import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, GitHubError, MAX_LOG_BYTES, MAX_LOG_READ_BYTES, NoAnswer, type Fetch } from "../src/github.js";
import { ACTIONS, FakeGitHubApi, LOG_HOST, ORIGIN, TOKEN, branchTipRoute, dispatchRoute, getPrRoute, jobsRoute, logRoutes, runRoute, runsRoute, workflowFileRoute } from "./fakes.js";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

function client(api: FakeGitHubApi): GitHub {
  return new GitHub(api.fetch, ORIGIN, TOKEN);
}

/** A log served straight from the API, `chunks` at a time, as a real body arrives. */
function streamed(chunks: () => Iterator<Uint8Array>): GitHub {
  const fetchImpl: Fetch = async () => {
    const source = chunks();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = source.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    return new Response(body, { status: 200 });
  };
  return new GitHub(fetchImpl, ORIGIN, TOKEN);
}

function* repeat(chunk: Uint8Array, times: number, suffix?: Uint8Array): Iterator<Uint8Array> {
  for (let i = 0; i < times; i++) yield chunk;
  if (suffix) yield suffix;
}

describe("every request", () => {
  // A timeout of its own, so a request that is never abandoned fails rather than hangs.
  it("gives up on one GitHub never answers, so it cannot hold up serialized pull request writes", { timeout: 2000 }, async () => {
    const stalled: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const github = new GitHub(stalled, ORIGIN, TOKEN, undefined, 10);
    await assert.rejects(() => github.pullRequest(7), /cannot reach https:\/\/api\.github\.com: .*timeout/);
  });

  it("keeps an error's status when its body is cut off partway", async () => {
    const cut: Fetch = async () =>
      new Response(new ReadableStream({ start: (stream) => stream.error(new TypeError("terminated")) }), { status: 502 });
    await assert.rejects(
      () => new GitHub(cut, ORIGIN, TOKEN).pullRequest(7),
      (err) => err instanceof GitHubError && err.status === 502,
    );
  });

  it("reports an answer cut off partway as no answer", async () => {
    const cut: Fetch = async () =>
      new Response(new ReadableStream({ start: (stream) => stream.error(new TypeError("terminated")) }), { status: 200 });
    await assert.rejects(
      () => new GitHub(cut, ORIGIN, TOKEN).pullRequest(7),
      (err) => err instanceof NoAnswer && /cut off: terminated/.test(err.message),
    );
  });
});

describe("workflow runs", () => {
  it("asks for one commit's runs in the pinned repository", async () => {
    const api = new FakeGitHubApi(runsRoute([{ id: 100 }]));

    await client(api).workflowRuns(SHA);

    const url = new URL(api.calls[0].url);
    assert.equal(url.pathname, "/repos/acme/widgets/actions/runs");
    assert.equal(url.searchParams.get("head_sha"), SHA);
  });

  it("reports the conclusion once a run completes, and the status until then", async () => {
    const api = new FakeGitHubApi(
      runsRoute([
        { id: 1, conclusion: "failure" },
        { id: 2, status: "in_progress", conclusion: null },
      ]),
    );

    const { runs } = await client(api).workflowRuns(SHA);

    assert.deepEqual(
      runs.map((run) => [run.state, run.completed]),
      [
        ["failure", true],
        ["in_progress", false],
      ],
    );
  });

  it("says when there were more runs than it reports", async () => {
    const api = new FakeGitHubApi(runsRoute([{ id: 1 }], 11));

    const { runs, more } = await client(api).workflowRuns(SHA);

    assert.equal(new URL(api.calls[0].url).searchParams.get("per_page"), "10");
    assert.equal(runs.length, 1);
    assert.equal(more, true);
  });

  it("reads one run by id, with the commit and branch it ran on", async () => {
    const api = new FakeGitHubApi(runRoute({ id: 100, status: "waiting", conclusion: null }));

    const run = await client(api).workflowRun(100);

    assert.equal(new URL(api.calls[0].url).pathname, "/repos/acme/widgets/actions/runs/100");
    assert.deepEqual([run.id, run.state, run.completed, run.headBranch], [100, "waiting", false, "feature"]);
    assert.match(run.headSha, /^1{40}$/);
  });

  it("refuses anything but a full sha before calling GitHub", async () => {
    const api = new FakeGitHubApi();
    for (const value of ["abc123", SHA.toUpperCase(), `${SHA}&per_page=1`, "main"]) {
      await assert.rejects(() => client(api).workflowRuns(value), /is not a commit sha/);
    }
    assert.equal(api.calls.length, 0);
  });
});

describe("jobs", () => {
  it("parses each job's steps", async () => {
    const api = new FakeGitHubApi(
      jobsRoute(100, [{ id: 7, conclusion: "failure", steps: [{ name: "Set up job" }, { name: "Test", conclusion: "failure" }] }]),
    );

    const { jobs, more } = await client(api).runJobs(100);

    assert.equal(more, false);
    assert.equal(jobs[0].state, "failure");
    assert.deepEqual(
      jobs[0].steps.map((step) => [step.number, step.name, step.state]),
      [
        [1, "Set up job", "success"],
        [2, "Test", "failure"],
      ],
    );
  });

  it("says when a run has more jobs than one page", async () => {
    const api = new FakeGitHubApi(jobsRoute(100, [{ id: 7 }], 101));

    assert.equal((await client(api).runJobs(100)).more, true);
  });

  it("keeps an id that slipped past the schema out of the URL", async () => {
    const api = new FakeGitHubApi();
    const github = client(api);

    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await assert.rejects(() => github.job(value), /is not a job id/);
      await assert.rejects(() => github.jobLog(value), /is not a job id/);
      await assert.rejects(() => github.runJobs(value), /is not a run id/);
      await assert.rejects(() => github.workflowRun(value), /is not a run id/);
    }
    assert.equal(api.calls.length, 0);
  });

  it("names Actions: read on a 403 from Actions, and only there", async () => {
    const forbidden = { status: 403, json: { message: "Resource not accessible" } };
    const api = new FakeGitHubApi({ [`GET ${ACTIONS}/jobs/7`]: forbidden, "GET /repos/acme/widgets/pulls/7": forbidden });

    await assert.rejects(() => client(api).job(7), /Actions: read/);
    await assert.rejects(() => client(api).pullRequest(7), (err: Error) => !err.message.includes("Actions"));
  });

  it("blames the id for a 404", async () => {
    const missing = { status: 404, json: {} };
    const api = new FakeGitHubApi({
      [`GET ${ACTIONS}/jobs/7`]: missing,
      [`GET ${ACTIONS}/jobs/7/logs`]: missing,
      [`GET ${ACTIONS}/runs/100/jobs`]: missing,
      [`GET ${ACTIONS}/runs/100`]: missing,
    });

    await assert.rejects(() => client(api).job(7), /cannot see that job in acme\/widgets \(404\)/);
    await assert.rejects(() => client(api).jobLog(7), /cannot see that job log .* no log yet/);
    await assert.rejects(() => client(api).runJobs(100), /cannot see that workflow run/);
    await assert.rejects(() => client(api).workflowRun(100), /cannot see that workflow run/);
  });
});

describe("job logs", () => {
  it("follows the redirect by hand, without the token", async () => {
    const api = new FakeGitHubApi(logRoutes(7, "line one\nline two\n"));

    const log = await client(api).jobLog(7);

    assert.deepEqual(log, { text: "line one\nline two\n", truncated: false });
    const [apiCall, download] = api.calls;
    assert.equal(apiCall.redirect, "manual");
    assert.equal(apiCall.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(new URL(download.url).host, LOG_HOST);
    assert.equal(download.redirect, "error");
    assert.ok(!JSON.stringify(download.headers).includes(TOKEN), "the token must not reach the log host");
  });

  it("refuses a redirect to anywhere but an absolute https URL", async () => {
    for (const headers of [{ location: "http://evil.example/x" }, { location: "/relative" }, undefined]) {
      const api = new FakeGitHubApi({ [`GET ${ACTIONS}/jobs/7/logs`]: { status: 302, headers } });

      await assert.rejects(() => client(api).jobLog(7), /other than an https URL/);
      assert.equal(api.calls.length, 1);
    }
  });

  it("keeps the signed URL out of a failed download's message", async () => {
    const api = new FakeGitHubApi(logRoutes(7, ""));
    const failures: Error[] = [Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })];
    failures.push(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    for (const failure of failures) {
      const fetchImpl: Fetch = async (input, init) => {
        if (new URL(String(input)).host !== LOG_HOST) return api.fetch(input, init);
        failure.message = `${failure.message} ${String(input)}`;
        throw failure;
      };

      await assert.rejects(
        () => new GitHub(fetchImpl, ORIGIN, TOKEN).jobLog(7),
        (err: Error) => /ECONNRESET|timed out/.test(err.message) && !err.message.includes("sig="),
      );
    }
  });

  it("reads a log GitHub serves without a redirect", async () => {
    const api = new FakeGitHubApi({ [`GET ${ACTIONS}/jobs/7/logs`]: { status: 200, text: "inline\n" } });

    assert.deepEqual(await client(api).jobLog(7), { text: "inline\n", truncated: false });
    assert.equal(api.calls.length, 1);
  });

  it("says a log has expired on a 410", async () => {
    const api = new FakeGitHubApi({ [`GET ${ACTIONS}/jobs/7/logs`]: { status: 410, json: {} } });

    await assert.rejects(() => client(api).jobLog(7), /expire/);
  });

  // 128-byte lines in 64 KiB chunks: 9 MiB of them puts the cut on a line boundary.
  const LINE = new TextEncoder().encode(`${"x".repeat(127)}\n`);
  const CHUNK = new Uint8Array(64 * 1024).map((_, i) => LINE[i % LINE.length]);
  const NINE_MIB = (9 * 1024 * 1024) / CHUNK.length;

  it("keeps the end of a log too long to hold, whole lines only", async () => {
    const log = await streamed(() => repeat(CHUNK, NINE_MIB)).jobLog(7);

    assert.equal(log.truncated, true);
    assert.equal(Buffer.byteLength(log.text), MAX_LOG_BYTES, "a cut on a line boundary drops nothing more");
  });

  it("drops the partial line a cut leaves", async () => {
    const log = await streamed(() => repeat(CHUNK, NINE_MIB, new Uint8Array([0x78]))).jobLog(7);

    // One byte past a whole line moves the cut one byte into a line.
    assert.equal(Buffer.byteLength(log.text), MAX_LOG_BYTES - LINE.length + 1);
    assert.ok(log.text.startsWith(`${"x".repeat(127)}\n`));
  });

  it("refuses a log over the read limit without holding it", async () => {
    const chunks = MAX_LOG_READ_BYTES / CHUNK.length + 1;

    await assert.rejects(() => streamed(() => repeat(CHUNK, chunks)).jobLog(7), /more than this tong will read/);
  });
});

describe("pull request head", () => {
  it("reports the head commit", async () => {
    const api = new FakeGitHubApi(
      getPrRoute({ number: 7, title: "t", body: "b", base: "main", head: "feature", headSha: SHA }),
    );

    assert.equal((await client(api).pullRequest(7)).headSha, SHA);
  });
});

describe("workflows", () => {
  const CONTENTS = "/repos/acme/widgets/contents/.github/workflows/deploy.yml";

  it("asks GitHub for a branch's tip with the qualified ref as a GraphQL variable", async () => {
    const api = new FakeGitHubApi(branchTipRoute({ "refs/heads/a\"b": SHA }));

    assert.equal(await client(api).branchTip('a"b'), SHA);
    const { query, variables } = api.lastBody as { query: string; variables: Record<string, string> };
    assert.deepEqual(variables, { owner: "acme", name: "widgets", ref: 'refs/heads/a"b' });
    assert.doesNotMatch(query, /a"b/);
    assert.equal(await client(api).branchTip("gone"), null);
  });

  it("refuses a branch tip that is not a commit sha", async () => {
    const answer = (repository: unknown) =>
      client(new FakeGitHubApi({ "POST /graphql": { status: 200, json: { data: { repository } } } })).branchTip("main");

    await assert.rejects(() => answer({ ref: { target: { oid: "abc" } } }), /did not report the commit main points at/);
    await assert.rejects(() => answer({ ref: {} }), /did not report the commit main points at/);
    await assert.rejects(() => answer(null), /did not report the commit main points at/);
  });

  it("reads a workflow file at a ref, which stays one query value", async () => {
    const api = new FakeGitHubApi(workflowFileRoute("deploy.yml", "on: workflow_dispatch\n"));

    assert.equal(await client(api).workflowFile("deploy.yml", "a&ref=main#x"), "on: workflow_dispatch\n");
    const url = new URL(api.calls[0].url);
    assert.equal(url.pathname, CONTENTS);
    assert.deepEqual([...url.searchParams], [["ref", "a&ref=main#x"]]);
  });

  it("refuses a workflow file GitHub does not send inline, or that is not a file", async () => {
    const answer = (json: unknown) => new FakeGitHubApi({ [`GET ${CONTENTS}`]: { status: 200, json } });

    await assert.rejects(() => client(answer({ type: "file", encoding: "none", size: 2_000_000, content: "" })).workflowFile("deploy.yml", "main"), /over 1 MB/);
    await assert.rejects(() => client(answer({ type: "file", encoding: "base64", size: 2_000_000, content: "" })).workflowFile("deploy.yml", "main"), /over 1 MB/);
    await assert.rejects(() => client(answer({ type: "file", encoding: "none", size: 10, content: "" })).workflowFile("deploy.yml", "main"), /over 1 MB/);
    await assert.rejects(() => client(answer([{ type: "file" }])).workflowFile("deploy.yml", "main"), /is not a file on main/);
  });

  it("dispatches on a branch, asking for the run's details", async () => {
    const api = new FakeGitHubApi(dispatchRoute("deploy.yml", 9));

    const result = await client(api).dispatchWorkflow("deploy.yml", "main", { a: "1" });

    assert.equal(new URL(api.calls[0].url).pathname, `${ACTIONS}/workflows/deploy.yml/dispatches`);
    assert.equal(api.calls[0].method, "POST");
    assert.deepEqual(api.lastBody, { ref: "main", inputs: { a: "1" }, return_run_details: true });
    assert.deepEqual(result, { runId: 9, url: "https://github.com/acme/widgets/actions/runs/9" });
  });

  it("reports no run id when GitHub sends none, or one that is not an id", async () => {
    const route = `POST ${ACTIONS}/workflows/deploy.yml/dispatches`;
    const ids = ["9", -1, 1.5];
    for (const response of [{ status: 204 }, ...ids.map((workflow_run_id) => ({ status: 200, json: { workflow_run_id } }))]) {
      const api = new FakeGitHubApi({ [route]: response });
      assert.deepEqual(await client(api).dispatchWorkflow("deploy.yml", "main", {}), { runId: null, url: "" });
    }
  });

  it("keeps a file name that is not a workflow file name out of the URL", async () => {
    const api = new FakeGitHubApi();
    for (const file of ["../deploy.yml", "a/b.yml", "deploy.yml?x=1", "deploy", "%2e%2e.yml"]) {
      await assert.rejects(() => client(api).workflowFile(file, "main"), /is not a workflow file name/);
      await assert.rejects(() => client(api).dispatchWorkflow(file, "main", {}), /is not a workflow file name/);
    }
    assert.equal(api.calls.length, 0);
  });

  it("names the permission a 403 lacks, and what a 404 most likely means", async () => {
    const forbidden = { status: 403, json: { message: "Resource not accessible" } };
    const missing = { status: 404, json: {} };
    const route = `POST ${ACTIONS}/workflows/deploy.yml/dispatches`;

    await assert.rejects(() => client(new FakeGitHubApi({ [route]: forbidden })).dispatchWorkflow("deploy.yml", "main", {}), /Actions: read and write/);
    await assert.rejects(() => client(new FakeGitHubApi({ [`GET ${CONTENTS}`]: forbidden })).workflowFile("deploy.yml", "main"), /Contents: read,/);
    await assert.rejects(
      () => client(new FakeGitHubApi({ [route]: missing })).dispatchWorkflow("deploy.yml", "main", {}),
      /cannot see that workflow in acme\/widgets \(404\)\. Either no workflow on the default branch has that file name/,
    );
    await assert.rejects(
      () => client(new FakeGitHubApi({ [`GET ${CONTENTS}`]: missing })).workflowFile("deploy.yml", "main"),
      /cannot see that workflow file in acme\/widgets \(404\)\. Either it is not on that ref/,
    );
  });
});
