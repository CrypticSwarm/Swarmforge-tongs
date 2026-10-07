// In-memory stand-ins for `git` and `fetch`, wired in through the seams in
// src/exec.ts and src/github.ts, so the whole push-and-open-a-PR path is tested
// without git installed, without a token, and without a network.

import type { Run, RunResult } from "../src/exec.js";
import type { Fetch } from "../src/github.js";

export const WORKSPACE = "/workspace";
export const ASKPASS = "/app/askpass.sh";

export type GitCall = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: Buffer | undefined;
  /** argv with the `-c key=value` hardening pairs and `-C <workspace>` removed. */
  verb: string[];
};

/** Output for a rejection path. `--porcelain` puts the per-ref verdict on stdout. */
export type GitFailure = { stderr: string; stdout?: string };

export type FakeGitOptions = {
  branch?: string | null;
  head?: string;
  originUrl?: string | null;
  isRepo?: boolean;
  pushFails?: GitFailure;
  pushUpToDate?: boolean;
  /** `fetch --porcelain` stdout on success. */
  fetchOutput?: string;
  fetchFails?: GitFailure;
  updateRefFails?: boolean;
  /** What rev-list reports as reachable from HEAD but from no origin ref, oldest first. */
  unpushed?: string[];
  /** Which of those carry a `gpgsig` header. */
  signed?: string[];
  /** Commit messages, for the shas that need a specific one. Defaults to the sha. */
  messages?: Record<string, string>;
  /** Shas `cat-file --batch` answers `missing` for, as a truncated batch also would. */
  missingObjects?: string[];
};

export class FakeGit {
  readonly calls: GitCall[] = [];
  readonly refs = new Map<string, string>();

  branch: string | null;
  head: string;
  originUrl: string | null;
  isRepo: boolean;
  pushFails: GitFailure | undefined;
  pushUpToDate: boolean;
  fetchOutput: string;
  fetchFails: GitFailure | undefined;
  updateRefFails: boolean;
  unpushed: string[];
  signed: Set<string>;
  messages: Record<string, string>;
  missingObjects: Set<string>;

  constructor(options: FakeGitOptions = {}) {
    this.branch = options.branch === undefined ? "feature" : options.branch;
    this.head = options.head ?? "1111111111111111111111111111111111111111";
    this.originUrl = options.originUrl === undefined ? "git@github.com:acme/widgets.git" : options.originUrl;
    this.isRepo = options.isRepo ?? true;
    this.pushFails = options.pushFails;
    this.pushUpToDate = options.pushUpToDate ?? false;
    this.fetchOutput = options.fetchOutput ?? "";
    this.fetchFails = options.fetchFails;
    this.updateRefFails = options.updateRefFails ?? false;
    this.unpushed = options.unpushed ?? [];
    this.signed = new Set(options.signed ?? []);
    this.messages = options.messages ?? {};
    this.missingObjects = new Set(options.missingObjects ?? []);
  }

  /** The push call, for asserting on argv and environment. */
  get pushCall(): GitCall | undefined {
    return this.calls.find((call) => call.verb[0] === "push");
  }

  get fetchCall(): GitCall | undefined {
    return this.calls.find((call) => call.verb[0] === "fetch");
  }

  callsTo(verb: string): GitCall[] {
    return this.calls.filter((call) => call.verb[0] === verb);
  }

  private ok(stdout = ""): RunResult {
    return { exitCode: 0, stdout: Buffer.from(stdout, "utf8"), stderr: "" };
  }

  private fail(message: string, stdout = ""): RunResult {
    return { exitCode: 1, stdout: Buffer.from(stdout, "utf8"), stderr: message };
  }

  readonly run: Run = async (command, args, options) => {
    if (command !== "git") return this.fail(`unexpected command ${command}`);

    const argv = [...args];
    const verb = [...argv];
    while (verb[0] === "-c" || verb[0] === "-C") verb.splice(0, 2);
    this.calls.push({ args: argv, env: options?.env ?? {}, stdin: options?.stdin, verb });

    return this.runGit(verb, options?.stdin);
  };

  /**
   * The bytes git stores, so the signature check runs against a real commit object
   * rather than against something shaped like the answer it is looking for.
   */
  private commitObject(sha: string): Buffer {
    const headers = [
      `tree ${"0".repeat(40)}`,
      "author A U Thor <a@example.com> 1700000000 +0000",
      "committer A U Thor <a@example.com> 1700000000 +0000",
      ...(this.signed.has(sha)
        ? ["gpgsig -----BEGIN PGP SIGNATURE-----", " ", " iQIzBAABCgAdFiEE", " -----END PGP SIGNATURE-----"]
        : []),
    ];
    return Buffer.from(`${headers.join("\n")}\n\n${this.messages[sha] ?? `commit ${sha}\n`}`, "utf8");
  }

  /** `<oid> <type> <size>\n<contents>\n` per requested object, as git writes it. */
  private catFileBatch(stdin: Buffer | undefined): RunResult {
    const requested = (stdin?.toString("utf8") ?? "")
      .split("\n")
      .filter((line) => line.length > 0);

    const parts: Buffer[] = [];
    for (const sha of requested) {
      if (this.missingObjects.has(sha)) {
        parts.push(Buffer.from(`${sha} missing\n`, "utf8"));
        continue;
      }
      const raw = this.commitObject(sha);
      parts.push(Buffer.from(`${sha} commit ${raw.length}\n`, "utf8"), raw, Buffer.from("\n", "utf8"));
    }
    return { exitCode: 0, stdout: Buffer.concat(parts), stderr: "" };
  }

  private runGit(verb: string[], stdin?: Buffer): RunResult {
    const [name, ...rest] = verb;

    switch (name) {
      case "rev-parse":
        if (rest[0] === "--is-inside-work-tree") return this.isRepo ? this.ok("true\n") : this.fail("not a work tree");
        if (rest[0] === "HEAD") return this.ok(`${this.head}\n`);
        if (rest[0] === "--verify") {
          const sha = this.refs.get(rest[rest.length - 1]);
          return sha ? this.ok(`${sha}\n`) : this.fail("no such ref");
        }
        return this.fail(`unexpected rev-parse: ${rest.join(" ")}`);

      case "rev-list":
        return this.ok(this.unpushed.map((sha) => `${sha}\n`).join(""));

      case "cat-file":
        return this.catFileBatch(stdin);

      case "config":
        return this.originUrl ? this.ok(`${this.originUrl}\n`) : this.fail("no such key");

      case "symbolic-ref":
        return this.branch ? this.ok(`${this.branch}\n`) : this.fail("HEAD is detached");

      case "push":
        if (this.pushFails) return this.fail(this.pushFails.stderr, this.pushFails.stdout);
        return this.ok(
          this.pushUpToDate
            ? `To github.com\n=\trefs/heads/x:refs/heads/x\t[up to date]\nDone\n`
            : `To github.com\n\trefs/heads/x:refs/heads/x\t0000000..${this.head.slice(0, 7)}\nDone\n`,
        );

      case "fetch":
        if (this.fetchFails) return this.fail(this.fetchFails.stderr, this.fetchFails.stdout);
        return this.ok(this.fetchOutput);

      case "update-ref": {
        if (this.updateRefFails) return this.fail("cannot lock ref");
        const [ref, sha] = rest.slice(2);
        this.refs.set(ref, sha);
        return this.ok();
      }

      default:
        return this.fail(`unexpected git verb: ${name}`);
    }
  }
}

/** The `-c key=value` pairs of an argv. */
export function configPairs(args: readonly string[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-c") continue;
    const [key, ...rest] = args[i + 1].split("=");
    pairs.set(key, rest.join("="));
  }
  return pairs;
}

export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestRedirect | undefined;
};

/** `text` is sent as is; otherwise `json`, serialized. */
export type FakeResponse = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

export class FakeGitHubApi {
  readonly calls: FetchCall[] = [];

  constructor(readonly routes: Record<string, FakeResponse | ((call: FetchCall) => FakeResponse)> = {}) {}

  get lastBody(): unknown {
    return this.calls[this.calls.length - 1]?.body;
  }

  readonly fetch: Fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call: FetchCall = {
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    this.calls.push(call);

    const parsed = new URL(url);
    // Off api.github.com, the host is part of the route.
    const key = `${method} ${parsed.host === "api.github.com" ? "" : parsed.host}${parsed.pathname}`;
    const route = this.routes[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `no fake route for ${key}` }), { status: 500 });
    }
    const { status, json, text, headers } = typeof route === "function" ? route(call) : route;
    return new Response(text ?? JSON.stringify(json), { status, headers });
  };
}

export const REPO_ROUTE = {
  "GET /repos/acme/widgets": { status: 200, json: { default_branch: "main" } },
};

export function prRoute(number: number, base: string, head: string, draft = false) {
  return {
    "POST /repos/acme/widgets/pulls": {
      status: 201,
      json: {
        number,
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        draft,
        base: { ref: base },
        head: { ref: head },
      },
    },
  };
}

export type PrState = {
  number: number;
  title: string;
  body: string | null;
  base: string;
  head: string;
  draft?: boolean;
  state?: "open" | "closed";
  merged?: boolean;
  headSha?: string;
};

/** A pull request as GitHub reports it, for the read and edit paths. */
export function prJson(pr: PrState) {
  return {
    number: pr.number,
    node_id: `PR_node_${pr.number}`,
    html_url: `https://github.com/acme/widgets/pull/${pr.number}`,
    title: pr.title,
    body: pr.body,
    draft: pr.draft ?? false,
    state: pr.state ?? "open",
    merged: pr.merged ?? false,
    base: { ref: pr.base },
    head: { ref: pr.head, sha: pr.headSha ?? "2222222222222222222222222222222222222222" },
  };
}

/**
 * A pull request as the list endpoint reports it: no `merged` key, only `merged_at`.
 * Reusing prJson here would hide exactly the difference the tong has to cope with.
 */
export function listedPrJson(pr: PrState) {
  const { merged, ...rest } = prJson(pr);
  return { ...rest, merged_at: merged ? "2026-10-01T12:00:00Z" : null };
}

export function listPrsRoute(prs: PrState[]) {
  return { "GET /repos/acme/widgets/pulls": { status: 200, json: prs.map(listedPrJson) } };
}

export function getPrRoute(pr: PrState) {
  return { [`GET /repos/acme/widgets/pulls/${pr.number}`]: { status: 200, json: prJson(pr) } };
}

/**
 * GET and PATCH over one mutable pull request, so an edit is visible to the read
 * that follows it -- which is what lets a test tell "GitHub changed it" apart from
 * "the tong said it did".
 */
export function editablePrRoutes(initial: PrState) {
  const state: PrState = { ...initial };
  const path = `/repos/acme/widgets/pulls/${initial.number}`;
  return {
    [`GET ${path}`]: () => ({ status: 200, json: prJson(state) }),
    [`PATCH ${path}`]: (call: FetchCall) => {
      Object.assign(state, call.body as Partial<PrState>);
      return { status: 200, json: prJson(state) };
    },
    // Draft lives behind GraphQL, which addresses the pull request by node id and
    // reports failure as an `errors` array inside a 200.
    "POST /graphql": (call: FetchCall) => {
      const { query, variables } = call.body as { query: string; variables: { id?: string } };
      if (variables?.id !== `PR_node_${state.number}`) {
        return { status: 200, json: { errors: [{ message: "Could not resolve to a node with the global id" }] } };
      }
      const field = query.includes("convertPullRequestToDraft")
        ? "convertPullRequestToDraft"
        : "markPullRequestReadyForReview";
      state.draft = field === "convertPullRequestToDraft";
      return { status: 200, json: { data: { [field]: { pullRequest: { isDraft: state.draft } } } } };
    },
  };
}

export const ACTIONS = "/repos/acme/widgets/actions";
export const LOG_HOST = "results-receiver.example";

export type RunState = { id: number; name?: string; status?: string; conclusion?: string | null; attempt?: number };

export function runJson(run: RunState) {
  return {
    id: run.id,
    name: run.name ?? "CI",
    event: "push",
    status: run.status ?? "completed",
    conclusion: run.conclusion === undefined ? "success" : run.conclusion,
    run_attempt: run.attempt ?? 1,
    html_url: `https://github.com/acme/widgets/actions/runs/${run.id}`,
    run_started_at: "2026-10-07T12:00:00Z",
    updated_at: "2026-10-07T12:03:12Z",
  };
}

export type StepState = {
  name: string;
  conclusion?: string | null;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

export type JobState = {
  id: number;
  runId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  steps?: StepState[];
};

export function jobJson(job: JobState) {
  return {
    id: job.id,
    run_id: job.runId ?? 100,
    run_attempt: 1,
    name: job.name ?? "test",
    status: job.status ?? "completed",
    conclusion: job.conclusion === undefined ? "success" : job.conclusion,
    html_url: `https://github.com/acme/widgets/actions/runs/${job.runId ?? 100}/job/${job.id}`,
    created_at: "2026-10-07T12:00:00Z",
    started_at: "2026-10-07T12:00:04Z",
    completed_at: job.status && job.status !== "completed" ? null : "2026-10-07T12:02:54Z",
    runner_name: "GitHub Actions 12",
    labels: ["ubuntu-latest"],
    steps: (job.steps ?? []).map((step, i) => ({
      number: i + 1,
      name: step.name,
      status: step.status ?? "completed",
      conclusion: step.conclusion === undefined ? "success" : step.conclusion,
      started_at: step.started_at === undefined ? "2026-10-07T12:00:04Z" : step.started_at,
      completed_at: step.completed_at === undefined ? "2026-10-07T12:00:05Z" : step.completed_at,
    })),
  };
}

export function runsRoute(runs: RunState[]) {
  return { [`GET ${ACTIONS}/runs`]: { status: 200, json: { total_count: runs.length, workflow_runs: runs.map(runJson) } } };
}

export function jobsRoute(runId: number, jobs: JobState[]) {
  return {
    [`GET ${ACTIONS}/runs/${runId}/jobs`]: {
      status: 200,
      json: { total_count: jobs.length, jobs: jobs.map((job) => jobJson({ runId, ...job })) },
    },
  };
}

export function jobRoute(job: JobState) {
  return { [`GET ${ACTIONS}/jobs/${job.id}`]: { status: 200, json: jobJson(job) } };
}

/** The API's redirect, and the signed URL it points at. */
export function logRoutes(jobId: number, text: string) {
  return {
    [`GET ${ACTIONS}/jobs/${jobId}/logs`]: {
      status: 302,
      headers: { location: `https://${LOG_HOST}/logs/${jobId}?sig=signed` },
    },
    [`GET ${LOG_HOST}/logs/${jobId}`]: { status: 200, text },
  };
}
