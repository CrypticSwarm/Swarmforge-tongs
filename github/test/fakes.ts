import type { Run, RunResult } from "../src/exec.js";
import { GitHub, type Fetch, type MergeState } from "../src/github.js";
import { remoteUrl, type Origin } from "../src/origin.js";
import { Repo } from "../src/repo.js";
import type { Context } from "../src/server.js";

export const WORKSPACE = "/workspace";
export const ASKPASS = "/app/askpass.sh";
export const ORIGIN: Origin = { owner: "acme", repo: "widgets" };
export const TOKEN = "ghp_thisIsTheSecretTokenValue";

export type GitCall = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: Buffer | undefined;
  verb: string[];
};

/** `--porcelain` puts the per-ref verdict on stdout. */
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
  signed?: string[];
  messages?: Record<string, string>;
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

  /** Real commit-object bytes, not something shaped like the answer the check wants. */
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
  signal: AbortSignal | undefined;
};

export type FakeResponse = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

export class FakeGitHubApi {
  readonly calls: FetchCall[] = [];

  constructor(
    readonly routes: Record<string, FakeResponse | ((call: FetchCall) => FakeResponse | Promise<FakeResponse>)> = {},
  ) {}

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
      signal: init?.signal ?? undefined,
    };
    this.calls.push(call);

    const parsed = new URL(url);
    const key = `${method} ${parsed.host === "api.github.com" ? "" : parsed.host}${parsed.pathname}`;
    const route = this.routes[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `no fake route for ${key}` }), { status: 500 });
    }
    const { status, json, text, headers } = typeof route === "function" ? await route(call) : route;
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
  createdAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
};

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
    created_at: pr.createdAt ?? "2026-09-30T08:00:00Z",
    closed_at: pr.closedAt ?? (pr.state === "closed" || pr.merged ? "2026-10-01T12:00:00Z" : null),
    merged_at: pr.mergedAt ?? (pr.merged ? "2026-10-01T12:00:00Z" : null),
  };
}

/** A pull request as the list endpoint reports it: no `merged` key, only `merged_at`. */
export function listedPrJson(pr: PrState) {
  const { merged, ...rest } = prJson(pr);
  return rest;
}

export function listPrsRoute(prs: PrState[]) {
  return { "GET /repos/acme/widgets/pulls": { status: 200, json: prs.map(listedPrJson) } };
}

export function getPrRoute(pr: PrState) {
  return { [`GET /repos/acme/widgets/pulls/${pr.number}`]: { status: 200, json: prJson(pr) } };
}

export function editablePrRoutes(initial: PrState) {
  const state: PrState = { ...initial };
  const path = `/repos/acme/widgets/pulls/${initial.number}`;
  return {
    [`GET ${path}`]: () => ({ status: 200, json: prJson(state) }),
    [`PATCH ${path}`]: (call: FetchCall) => {
      Object.assign(state, call.body as Partial<PrState>);
      return { status: 200, json: prJson(state) };
    },
    // Draft is GraphQL-only: addressed by node id, failing with `errors` inside a 200.
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

export type RunState = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  attempt?: number;
  headBranch?: string | null;
  headSha?: string;
};

export const RUN_SHA = "1111111111111111111111111111111111111111";

export function runJson(run: RunState) {
  return {
    id: run.id,
    name: run.name ?? "CI",
    event: "push",
    status: run.status ?? "completed",
    conclusion: run.conclusion === undefined ? "success" : run.conclusion,
    run_attempt: run.attempt ?? 1,
    html_url: `https://github.com/acme/widgets/actions/runs/${run.id}`,
    head_sha: run.headSha ?? RUN_SHA,
    head_branch: run.headBranch === undefined ? "feature" : run.headBranch,
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

export function runsRoute(runs: RunState[], total = runs.length) {
  return { [`GET ${ACTIONS}/runs`]: { status: 200, json: { total_count: total, workflow_runs: runs.map(runJson) } } };
}

export function runRoute(run: RunState) {
  return { [`GET ${ACTIONS}/runs/${run.id}`]: { status: 200, json: runJson(run) } };
}

export function jobsRoute(runId: number, jobs: JobState[], total = jobs.length) {
  return {
    [`GET ${ACTIONS}/runs/${runId}/jobs`]: {
      status: 200,
      json: { total_count: total, jobs: jobs.map((job) => jobJson({ runId, ...job })) },
    },
  };
}

export function jobRoute(job: JobState) {
  return { [`GET ${ACTIONS}/jobs/${job.id}`]: { status: 200, json: jobJson(job) } };
}

export function logRoutes(jobId: number, text: string) {
  return {
    [`GET ${ACTIONS}/jobs/${jobId}/logs`]: {
      status: 302,
      headers: { location: `https://${LOG_HOST}/logs/${jobId}?sig=signed` },
    },
    [`GET ${LOG_HOST}/logs/${jobId}`]: { status: 200, text },
  };
}

export type MergeableState = { number: number; base?: string } & Partial<
  Pick<MergeState, "state" | "draft" | "status" | "mergeQueue" | "headSha">
>;

/** Answers only the fields the query names, so a field dropped from the query reads as missing. */
export function mergeRoutes(pr: MergeableState, merge: FakeResponse = { status: 200, json: { sha: "3".repeat(40) } }) {
  const fields: Record<string, unknown> = {
    url: `https://github.com/acme/widgets/pull/${pr.number}`,
    baseRefName: pr.base ?? "main",
    state: pr.state ?? "OPEN",
    isDraft: pr.draft ?? false,
    headRefOid: pr.headSha ?? "2".repeat(40),
    mergeStateStatus: pr.status ?? "CLEAN",
    isMergeQueueEnabled: pr.mergeQueue ?? false,
  };
  return {
    "POST /graphql": (call: FetchCall) => {
      const { query } = call.body as { query: string };
      const asked = Object.entries(fields).filter(([name]) => new RegExp(`\\b${name}\\b`).test(query));
      return { status: 200, json: { data: { repository: { pullRequest: Object.fromEntries(asked) } } } };
    },
    [`PUT /repos/acme/widgets/pulls/${pr.number}/merge`]: merge,
  };
}

export function contextFor(api = new FakeGitHubApi(), git = new FakeGit(), dispatch?: Context["dispatch"]): Context {
  return {
    repo: new Repo(git.run, WORKSPACE, ASKPASS, false),
    github: new GitHub(api.fetch, ORIGIN, TOKEN),
    origin: ORIGIN,
    remoteUrl: remoteUrl(ORIGIN),
    token: TOKEN,
    dispatch,
  };
}

/** A file as the Contents API sends it, at any ref. */
function contentsRoute(path: string, text: string) {
  const content = Buffer.from(text, "utf8").toString("base64");
  return {
    [`GET /repos/acme/widgets/contents/${path}`]: {
      status: 200,
      json: { type: "file", encoding: "base64", size: text.length, content },
    },
  };
}

export const workflowFileRoute = (file: string, yaml: string) => contentsRoute(`.github/workflows/${file}`, yaml);

export const allowlistRoute = (yaml: string) => contentsRoute(".github/swarmforge-dispatch.yml", yaml);

export function dispatchRoute(file: string, runId = 555) {
  return {
    [`POST ${ACTIONS}/workflows/${file}/dispatches`]: {
      status: 200,
      json: {
        workflow_run_id: runId,
        run_url: `https://api.github.com${ACTIONS}/runs/${runId}`,
        html_url: `https://github.com/acme/widgets/actions/runs/${runId}`,
      },
    },
  };
}

/** `tips` is keyed by full ref (`refs/heads/<branch>`); any other ref is absent. */
export function branchTipRoute(tips: Record<string, string>) {
  return {
    "POST /graphql": (call: FetchCall) => {
      const oid = tips[(call.body as { variables: { ref: string } }).variables.ref];
      return { status: 200, json: { data: { repository: { ref: oid ? { target: { oid } } : null } } } };
    },
  };
}
