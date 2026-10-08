import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, MAX_LOG_BYTES, MAX_LOG_READ_BYTES, type Fetch } from "../src/github.js";
import type { Origin } from "../src/origin.js";
import { ACTIONS, FakeGitHubApi, LOG_HOST, getPrRoute, jobsRoute, logRoutes, runsRoute } from "./fakes.js";

const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
const TOKEN = "ghp_thisIsTheSecretTokenValue";
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
    });

    await assert.rejects(() => client(api).job(7), /cannot see that job in acme\/widgets \(404\)/);
    await assert.rejects(() => client(api).jobLog(7), /cannot see that job log .* no log yet/);
    await assert.rejects(() => client(api).runJobs(100), /cannot see that workflow run/);
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
