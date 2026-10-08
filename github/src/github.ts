// The GitHub REST client.
//
// Everything the agent supplies travels from here as JSON in a request body, with
// one exception: a pull request number is a path segment. The pinned `owner` and
// `repo` are the only other values that reach a URL. `fetch` is injected so the
// path is testable without a token or a network.

import type { Origin } from "./origin.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Fetch = typeof globalThis.fetch;

/**
 * Long enough for any reasonable PR, short enough that nothing enormous is sent.
 * Counted in Unicode code points, as zod 4's `.max()` and JSON Schema's
 * `maxLength` both count them -- so an emoji is one, not two.
 */
export const MAX_TITLE = 256;
export const MAX_BODY = 65536;

/** The most pull requests one lookup by head branch returns, newest first. */
export const MAX_FIND_RESULTS = 10;

/** The most workflow runs reported for one commit, newest first. */
export const MAX_RUNS = 10;

/** GitHub's page size cap; a run with more jobs than this is reported as cut short. */
export const MAX_JOBS = 100;

/** Kept from the end of a job's log, where a failure usually is. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** A log bigger than this is refused rather than read to its end. */
export const MAX_LOG_READ_BYTES = 256 * 1024 * 1024;

const LOG_TIMEOUT_MS = 60_000;

/** GitHub has no SHA-256 repositories, so a commit id is 40 hex digits. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

const USER_AGENT = "swarmforge-tong-github";

export type PullRequest = {
  number: number;
  /** GraphQL's identifier for the same pull request; empty if GitHub omitted it. */
  nodeId: string;
  url: string;
  title: string;
  body: string;
  base: string;
  head: string;
  /** The head branch's commit; empty if GitHub omitted it. */
  headSha: string;
  draft: boolean;
  state: "open" | "closed";
  /** A merged pull request is also `closed`, but almost nothing about it can change. */
  merged: boolean;
};

export type CreatePullRequest = {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
};

/** Actions' `status` until it completes, then its `conclusion`. */
export type Progress = { state: string; completed: boolean };

export type WorkflowRun = Progress & {
  id: number;
  name: string;
  event: string;
  attempt: number;
  url: string;
  startedAt: string | null;
  updatedAt: string | null;
};

export type JobStep = Progress & {
  number: number;
  name: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type Job = Progress & {
  id: number;
  runId: number;
  attempt: number;
  name: string;
  url: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runner: string;
  labels: string[];
  steps: JobStep[];
};

/** Every field omitted here is one GitHub leaves as it is. `head` is not editable. */
export type UpdatePullRequest = {
  title?: string;
  body?: string;
  base?: string;
  state?: "open" | "closed";
};

export class GitHub {
  constructor(
    private readonly fetchImpl: Fetch,
    private readonly origin: Origin,
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
  ) {}

  private get repoPath(): string {
    return `${this.origin.owner}/${this.origin.repo}`;
  }

  private async send(method: string, path: string, body?: unknown, redirect?: RequestRedirect): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        redirect,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new GitHubError(`cannot reach ${this.apiBase}: ${(err as Error).message}`, 0);
    }
  }

  private async fail(response: Response, path: string): Promise<never> {
    const text = await response.text();
    const parsed = text.length > 0 ? safeJson(text) : undefined;
    throw new GitHubError(describeFailure(response.status, parsed, this.repoPath, path), response.status);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.send(method, path, body);
    if (!response.ok) return this.fail(response, path);
    const text = await response.text();
    return text.length > 0 ? safeJson(text) : undefined;
  }

  /** Also the startup reachability check: it fails loudly on a token that cannot see the repo. */
  async repository(): Promise<{ defaultBranch: string; permissions?: Record<string, boolean> }> {
    const data = (await this.request("GET", `/repos/${this.repoPath}`)) as {
      default_branch?: string;
      permissions?: Record<string, boolean>;
    };
    if (!data?.default_branch) {
      throw new GitHubError(`GitHub did not report a default branch for ${this.repoPath}`, 0);
    }
    return { defaultBranch: data.default_branch, permissions: data.permissions };
  }

  private pullPath(number: number): string {
    return `/repos/${this.repoPath}/pulls/${assertId(number, "pull request number")}`;
  }

  private jobPath(id: number): string {
    return `/repos/${this.repoPath}/actions/jobs/${assertId(id, "job id")}`;
  }

  async createPullRequest(input: CreatePullRequest): Promise<PullRequest> {
    const pr = parsePullRequest(
      await this.request("POST", `/repos/${this.repoPath}/pulls`, {
        title: input.title,
        body: input.body ?? "",
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
      }),
      "accepted the pull request",
    );
    // Only for the fields the caller already knows: GitHub has always reported them,
    // and a create that answered without them is still a pull request that exists.
    return { ...pr, base: pr.base || input.base, head: pr.head || input.head };
  }

  async pullRequest(number: number): Promise<PullRequest> {
    return parsePullRequest(await this.request("GET", this.pullPath(number)), `returned pull request ${number}`);
  }

  /**
   * The pull requests of the pinned repository whose head is `branch`, open or not,
   * newest first.
   *
   * The branch name is the second caller-supplied value that reaches a URL, here as
   * a query value, so it goes through URLSearchParams rather than into a template:
   * a name containing `&`, `#`, or `=` stays one value and cannot add a parameter or
   * cut the URL short. The owner half of `head` is the pinned owner, never the
   * caller's, so this only ever matches branches of the repository itself.
   */
  async findPullRequests(branch: string): Promise<{ pullRequests: PullRequest[]; more: boolean }> {
    if (typeof branch !== "string" || branch.length === 0 || branch.length > 255) {
      throw new GitHubError(`'${String(branch).slice(0, 40)}' is not a branch name`, 0);
    }
    const query = new URLSearchParams({
      head: `${this.origin.owner}:${branch}`,
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: String(MAX_FIND_RESULTS + 1), // one extra, so `more` is exact
    });
    const data = await this.request("GET", `/repos/${this.repoPath}/pulls?${query}`);
    if (!Array.isArray(data)) {
      throw new GitHubError("GitHub answered the pull request lookup with something other than a list", 0);
    }
    return {
      pullRequests: data.slice(0, MAX_FIND_RESULTS).map((item) => parsePullRequest(item, "listed a pull request")),
      more: data.length > MAX_FIND_RESULTS,
    };
  }

  /**
   * The body is built key by key rather than passed through, so a field the caller
   * did not ask to change cannot appear in the request at all.
   */
  async updatePullRequest(number: number, changes: UpdatePullRequest): Promise<PullRequest> {
    const body: Record<string, unknown> = {};
    if (changes.title !== undefined) body.title = changes.title;
    if (changes.body !== undefined) body.body = changes.body;
    if (changes.base !== undefined) body.base = changes.base;
    if (changes.state !== undefined) body.state = changes.state;

    return parsePullRequest(
      await this.request("PATCH", this.pullPath(number), body),
      `accepted the edit to pull request ${number}`,
    );
  }

  /** The Actions runs for `sha`, newest first, each at its latest attempt. */
  async workflowRuns(sha: string): Promise<{ runs: WorkflowRun[]; more: boolean }> {
    if (!COMMIT_SHA.test(sha)) throw new GitHubError(`'${sha.slice(0, 40)}' is not a commit sha`, 0);
    const query = new URLSearchParams({ head_sha: sha, per_page: String(MAX_RUNS) });
    const data = (await this.request("GET", `/repos/${this.repoPath}/actions/runs?${query}`)) as {
      workflow_runs?: unknown;
      total_count?: number;
    };
    if (!Array.isArray(data?.workflow_runs)) {
      throw new GitHubError("GitHub answered the workflow run lookup without a list of runs", 0);
    }
    return { runs: data.workflow_runs.map(parseRun), more: (data.total_count ?? 0) > data.workflow_runs.length };
  }

  /** The jobs of a run's latest attempt. */
  async runJobs(runId: number): Promise<{ jobs: Job[]; more: boolean }> {
    const path = `/repos/${this.repoPath}/actions/runs/${assertId(runId, "run id")}/jobs`;
    const data = (await this.request("GET", `${path}?per_page=${MAX_JOBS}`)) as {
      jobs?: unknown;
      total_count?: number;
    };
    if (!Array.isArray(data?.jobs)) {
      throw new GitHubError(`GitHub answered the job lookup for run ${runId} without a list of jobs`, 0);
    }
    return { jobs: data.jobs.map(parseJob), more: (data.total_count ?? 0) > data.jobs.length };
  }

  async job(id: number): Promise<Job> {
    return parseJob(await this.request("GET", this.jobPath(id)));
  }

  /** Follows the redirect to a signed URL by hand, without the token, and never reports the URL. */
  async jobLog(id: number): Promise<{ text: string; truncated: boolean }> {
    const path = `${this.jobPath(id)}/logs`;
    const response = await this.send("GET", path, undefined, "manual");
    if (response.ok) return readTail(id, response);
    if (response.status < 300 || response.status >= 400) return this.fail(response, path);
    await response.body?.cancel();

    const target = URL.parse(response.headers.get("location") ?? "");
    if (target?.protocol !== "https:") {
      throw new GitHubError(`GitHub redirected the log of job ${id} somewhere other than an https URL`, 0);
    }
    let download: Response;
    try {
      download = await this.fetchImpl(target, {
        headers: { "user-agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
      });
    } catch (err) {
      throw downloadError(id, err);
    }
    if (!download.ok) {
      throw new GitHubError(`downloading the log of job ${id} failed (${download.status})`, download.status);
    }
    return readTail(id, download);
  }

  /**
   * Draft is the one pull request field REST will not edit -- there is no `draft`
   * key on the PATCH endpoint, only a pair of GraphQL mutations, which address the
   * pull request by node id rather than by number.
   *
   * Returns the status GitHub reports afterwards rather than the one that was asked
   * for, so a mutation that quietly did nothing cannot be reported as a change.
   */
  async setDraft(nodeId: string, draft: boolean): Promise<boolean> {
    if (!nodeId) {
      throw new GitHubError(
        "GitHub returned no node id for that pull request, so its draft status cannot be changed",
        0,
      );
    }

    const field = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const data = (await this.graphql(
      `mutation($id: ID!) { ${field}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: nodeId },
    )) as Record<string, { pullRequest?: { isDraft?: boolean } } | undefined>;

    const isDraft = data[field]?.pullRequest?.isDraft;
    if (typeof isDraft !== "boolean") {
      throw new GitHubError("GitHub did not report the pull request's draft status after changing it", 0);
    }
    return isDraft;
  }

  /**
   * A failed GraphQL request is a 200 carrying an `errors` array, so unlike REST it
   * has to be inspected rather than trusted: `request` sees only a successful call.
   */
  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const data = (await this.request("POST", "/graphql", { query, variables })) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string }>;
    };

    if (data?.errors?.length) {
      const detail = data.errors.map((error) => error.message ?? "unspecified error").join("; ");
      throw new GitHubError(`GitHub refused the request: ${detail}`, 0);
    }
    if (!data?.data) throw new GitHubError("GitHub answered the request with neither data nor an error", 0);
    return data.data;
  }
}

function parsePullRequest(data: unknown, context: string): PullRequest {
  const pr = data as {
    number?: number;
    node_id?: string;
    html_url?: string;
    title?: string;
    body?: string | null;
    draft?: boolean;
    merged?: boolean;
    merged_at?: string | null;
    state?: string;
    base?: { ref?: string };
    head?: { ref?: string; sha?: string };
  };

  if (typeof pr?.number !== "number" || !pr.html_url) {
    throw new GitHubError(`GitHub ${context} but returned no number or URL`, 0);
  }

  return {
    number: pr.number,
    nodeId: typeof pr.node_id === "string" ? pr.node_id : "",
    url: pr.html_url,
    title: pr.title ?? "",
    // An empty description comes back as null, not as "".
    body: pr.body ?? "",
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    draft: pr.draft === true,
    state: pr.state === "closed" ? "closed" : "open",
    // The list endpoint omits `merged` and reports `merged_at` instead; the single
    // pull request endpoint sends both. Reading either keeps a merged pull request
    // from showing up as merely closed in a lookup by branch.
    merged: pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at.length > 0),
  };
}

function progress(item: { status?: string; conclusion?: string | null }): Progress {
  const completed = item.status === "completed";
  return { state: (completed ? item.conclusion : item.status) ?? item.status ?? "unknown", completed };
}

function parseRun(data: unknown): WorkflowRun {
  const run = data as {
    id?: number;
    name?: string | null;
    event?: string;
    status?: string;
    conclusion?: string | null;
    run_attempt?: number;
    html_url?: string;
    run_started_at?: string;
    updated_at?: string;
  };
  if (typeof run?.id !== "number") throw new GitHubError("GitHub listed a workflow run with no id", 0);
  return {
    ...progress(run),
    id: run.id,
    name: run.name ?? "",
    event: run.event ?? "",
    attempt: run.run_attempt ?? 1,
    url: run.html_url ?? "",
    startedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at ?? null,
  };
}

function parseJob(data: unknown): Job {
  const job = data as {
    id?: number;
    run_id?: number;
    run_attempt?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string | null;
    created_at?: string;
    started_at?: string | null;
    completed_at?: string | null;
    runner_name?: string | null;
    labels?: string[];
    steps?: Array<{
      number?: number;
      name?: string;
      status?: string;
      conclusion?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
    }>;
  };
  if (typeof job?.id !== "number") throw new GitHubError("GitHub returned a job with no id", 0);
  return {
    ...progress(job),
    id: job.id,
    runId: job.run_id ?? 0,
    attempt: job.run_attempt ?? 1,
    name: job.name ?? "",
    url: job.html_url ?? "",
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    runner: job.runner_name ?? "",
    labels: Array.isArray(job.labels) ? job.labels : [],
    steps: (job.steps ?? []).map((step, index) => ({
      ...progress(step),
      number: step.number ?? index + 1,
      name: step.name ?? "",
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
    })),
  };
}

/** Caller-supplied, and the only kind of caller value that reaches a URL path. */
function assertId(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubError(`'${String(value).slice(0, 40)}' is not a ${what}`, 0);
  }
  return value;
}

/** A fetch error's message may carry the signed URL, so only its kind is kept. */
function downloadError(id: number, err: unknown): GitHubError {
  if (err instanceof GitHubError) return err;
  const { name, cause } = (err ?? {}) as { name?: string; cause?: { code?: unknown } };
  const kind = name === "TimeoutError" ? "timed out" : typeof cause?.code === "string" ? cause.code : "network error";
  return new GitHubError(`cannot download the log of job ${id}: ${kind}`, 0);
}

/** The last MAX_LOG_BYTES of the body, reading at most MAX_LOG_READ_BYTES; a partial first line is dropped. */
async function readTail(id: number, response: Response): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let read = 0;
  let lastDropped: number | undefined;
  const reader = response.body?.getReader();
  try {
    for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
      read += next.value.length;
      if (read > MAX_LOG_READ_BYTES) {
        await reader?.cancel();
        const mib = MAX_LOG_READ_BYTES / 1024 / 1024;
        throw new GitHubError(`the log is over ${mib} MiB, more than this tong will read`, 0);
      }
      chunks.push(next.value);
      kept += next.value.length;
      while (kept - chunks[0].length >= MAX_LOG_BYTES) {
        const dropped = chunks.shift()!;
        kept -= dropped.length;
        lastDropped = dropped[dropped.length - 1];
      }
    }
  } catch (err) {
    throw downloadError(id, err);
  }
  let bytes = Buffer.concat(chunks);
  if (bytes.length > MAX_LOG_BYTES) {
    lastDropped = bytes[bytes.length - MAX_LOG_BYTES - 1];
    bytes = bytes.subarray(bytes.length - MAX_LOG_BYTES);
  }
  const text = bytes.toString("utf8");
  const midLine = lastDropped !== undefined && lastDropped !== 0x0a;
  return { text: midLine ? text.slice(text.indexOf("\n") + 1) : text, truncated: lastDropped !== undefined };
}

/**
 * Reachability says nothing about write access: a public repository answers
 * `repository()` for any valid token, including one that has never been granted
 * anything on it. Returns null when the token can push, else why not.
 */
export function pushBlocker(origin: Origin, permissions?: Record<string, boolean>): string | null {
  if (permissions?.push === true) return null;
  return (
    `the token cannot push to ${origin.owner}/${origin.repo}. GitHub reports ` +
    `${permissions ? `push access ${permissions.push}` : "no permissions for it at all"}. A classic token ` +
    `needs the 'repo' scope (or 'public_repo'); a fine-grained token needs this repository selected, with ` +
    `Contents: read and write.`
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

/** What a 404 on each numbered path most likely means. */
const ADDRESSED: ReadonlyArray<[RegExp, string, string]> = [
  [/\/pulls\/\d+$/, "pull request", "the number names no pull request"],
  [/\/actions\/runs\/\d+\/jobs$/, "workflow run", "the id names no run"],
  [/\/actions\/jobs\/\d+$/, "job", "the id names no job"],
  [/\/actions\/jobs\/\d+\/logs$/, "job log", "the job has no log yet, as while it is running"],
];

/**
 * A token not scoped to this repository and a repository that does not exist both
 * come back 404, so say what the operator most likely needs to change.
 */
function describeFailure(status: number, parsed: unknown, repoPath: string, path: string): string {
  const payload = parsed as { message?: string; errors?: Array<{ message?: string; field?: string }> } | undefined;
  const detail = [payload?.message, ...(payload?.errors ?? []).map((e) => e.message ?? e.field)]
    .filter((part): part is string => Boolean(part))
    .join("; ");

  switch (status) {
    case 401:
      return `GitHub rejected the token (401). It is invalid, revoked, or expired.`;
    case 403:
      return (
        `GitHub refused the request (403)${detail ? `: ${detail}` : ""}. The token most likely lacks the ` +
        `permission this needs${path.includes("/actions/") ? ": Actions: read, on a fine-grained token" : ""}.`
      );
    case 404: {
      // Startup proved the repository is visible, so blame the number.
      const addressed = ADDRESSED.find(([pattern]) => pattern.test(path.split("?")[0]));
      if (addressed) {
        const [, noun, cause] = addressed;
        return (
          `GitHub cannot see that ${noun} in ${repoPath} (404). Either ${cause}, or the token is no longer ` +
          `scoped to this repository.`
        );
      }
      return (
        `GitHub cannot see ${repoPath} (404). Either the repository does not exist, or the token is not ` +
        `scoped to it -- a fine-grained token must list this repository and grant Contents and Pull requests.`
      );
    }
    case 410:
      return `GitHub says that is gone (410). Actions logs expire, by default after 90 days.`;
    case 422:
      return `GitHub rejected the request (422)${detail ? `: ${detail}` : ""}.`;
    default:
      return `GitHub returned ${status}${detail ? `: ${detail}` : ""}.`;
  }
}
