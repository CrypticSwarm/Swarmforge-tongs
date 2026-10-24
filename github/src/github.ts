// Caller values reach a URL only as an `assertId` path segment or a URLSearchParams value; the rest go in JSON bodies.

import { ALLOWLIST, WORKFLOW_FILE } from "./allowlist.js";
import type { Origin } from "./origin.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** GitHub sent no complete answer, so a write may or may not have happened. */
export class NoAnswer extends GitHubError {
  constructor(message: string) {
    super(message, 0);
  }
}

export type Fetch = typeof globalThis.fetch;

/** In Unicode code points, as zod 4's `.max()` and JSON Schema's `maxLength` count them. */
export const MAX_TITLE = 256;
export const MAX_BODY = 65536;

export const MAX_FIND_RESULTS = 10;

export const MAX_RUNS = 10;

/** GitHub's per_page maximum. */
export const MAX_JOBS = 100;

/** Kept from the end of a job's log, where a failure usually is. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

export const MAX_LOG_READ_BYTES = 256 * 1024 * 1024;

const TIMEOUT_MS = 60_000;

/** The Contents API inlines a file only up to 1 MB. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** GitHub has no SHA-256 repositories, so a commit id is 40 hex digits. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

const USER_AGENT = "swarmforge-tong-github";

export type PullRequest = {
  number: number;
  nodeId: string;
  url: string;
  title: string;
  body: string;
  base: string;
  head: string;
  headSha: string;
  draft: boolean;
  state: "open" | "closed";
  /** A merged pull request also has state `closed`. */
  merged: boolean;
  createdAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
};

export type CreatePullRequest = {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
};

export type Progress = { state: string; completed: boolean };

export type WorkflowRun = Progress & {
  id: number;
  name: string;
  event: string;
  attempt: number;
  url: string;
  headSha: string;
  headBranch: string;
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

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

const PR_STATES = ["OPEN", "CLOSED", "MERGED"] as const;

export type MergeState = Pick<PullRequest, "url" | "base" | "headSha" | "draft"> & {
  state: (typeof PR_STATES)[number];
  /** GraphQL's MergeStateStatus. */
  status: string;
  mergeQueue: boolean;
};

/** Omitted fields stay unchanged. `head` is not editable. */
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
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  private get repoPath(): string {
    return `${this.origin.owner}/${this.origin.repo}`;
  }

  private async send(method: string, path: string, body?: unknown, redirect?: RequestRedirect): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        redirect,
        signal: AbortSignal.timeout(this.timeoutMs),
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
      throw new NoAnswer(`cannot reach ${this.apiBase}: ${(err as Error).message}`);
    }
  }

  private async fail(response: Response, path: string): Promise<never> {
    // The status is the answer; a body cut off partway only loses GitHub's detail.
    const text = await response.text().catch(() => "");
    const parsed = text.length > 0 ? safeJson(text) : undefined;
    throw new GitHubError(describeFailure(response.status, parsed, this.repoPath, path), response.status);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.send(method, path, body);
    if (!response.ok) return this.fail(response, path);
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new NoAnswer(`GitHub's answer was cut off: ${(err as Error).message}`);
    }
    return text.length > 0 ? safeJson(text) : undefined;
  }

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
    // GitHub may omit these; the pull request exists either way.
    return { ...pr, base: pr.base || input.base, head: pr.head || input.head };
  }

  async pullRequest(number: number): Promise<PullRequest> {
    return parsePullRequest(await this.request("GET", this.pullPath(number)), `returned pull request ${number}`);
  }

  /** `head` carries the pinned owner, so fork branches never match. */
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

  /** Built key by key, so only these four fields can reach GitHub. */
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

  async mergeState(number: number): Promise<MergeState> {
    const data = (await this.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            url baseRefName state isDraft headRefOid mergeStateStatus isMergeQueueEnabled
          }
        }
      }`,
      { owner: this.origin.owner, name: this.origin.repo, number: assertId(number, "pull request number") },
    )) as { repository?: { pullRequest?: Record<string, unknown> | null } };
    const pr = data.repository?.pullRequest;
    const state = pr?.state as MergeState["state"];
    // All required, so a missing one is a refusal rather than a default that might permit the merge.
    if (
      typeof pr?.url !== "string" ||
      typeof pr.baseRefName !== "string" ||
      !PR_STATES.includes(state) ||
      typeof pr.isDraft !== "boolean" ||
      typeof pr.headRefOid !== "string" ||
      !COMMIT_SHA.test(pr.headRefOid) ||
      typeof pr.mergeStateStatus !== "string" ||
      typeof pr.isMergeQueueEnabled !== "boolean"
    ) {
      throw new GitHubError(`GitHub did not report the merge state of pull request ${number}`, 0);
    }
    return {
      url: pr.url,
      base: pr.baseRefName,
      state,
      draft: pr.isDraft,
      headSha: pr.headRefOid,
      status: pr.mergeStateStatus,
      mergeQueue: pr.isMergeQueueEnabled,
    };
  }

  /** GitHub refuses with a 409 if the head has moved off `sha`. */
  async merge(number: number, method: MergeMethod, sha: string): Promise<string> {
    const data = (await this.request("PUT", `${this.pullPath(number)}/merge`, {
      merge_method: method,
      sha: assertSha(sha),
    })) as { sha?: string };
    return data?.sha ?? "";
  }

  /** Newest first, each at its latest attempt. */
  async workflowRuns(sha: string): Promise<{ runs: WorkflowRun[]; more: boolean }> {
    const query = new URLSearchParams({ head_sha: assertSha(sha), per_page: String(MAX_RUNS) });
    const data = (await this.request("GET", `/repos/${this.repoPath}/actions/runs?${query}`)) as {
      workflow_runs?: unknown;
      total_count?: number;
    };
    if (!Array.isArray(data?.workflow_runs)) {
      throw new GitHubError("GitHub answered the workflow run lookup without a list of runs", 0);
    }
    return { runs: data.workflow_runs.map(parseRun), more: (data.total_count ?? 0) > data.workflow_runs.length };
  }

  async workflowRun(id: number): Promise<WorkflowRun> {
    return parseRun(await this.request("GET", `/repos/${this.repoPath}/actions/runs/${assertId(id, "run id")}`));
  }

  async branchTip(branch: string): Promise<string | null> {
    const data = (await this.graphql(
      `query($owner: String!, $name: String!, $ref: String!) {
        repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } }
      }`,
      { owner: this.origin.owner, name: this.origin.repo, ref: `refs/heads/${branch}` },
    )) as { repository?: { ref?: { target?: { oid?: unknown } } | null } };
    const ref = data.repository?.ref;
    if (ref === null) return null;
    const oid = ref?.target?.oid;
    if (typeof oid !== "string" || !COMMIT_SHA.test(oid)) {
      throw new GitHubError(`GitHub did not report the commit ${branch} points at`, 0);
    }
    return oid;
  }

  async workflowFile(file: string, ref: string): Promise<string> {
    return this.fileAt(`.github/workflows/${file}`, this.workflowPath(file, "contents"), ref);
  }

  async allowlistFile(ref: string): Promise<string | null> {
    try {
      return await this.fileAt(ALLOWLIST, `/repos/${this.repoPath}/contents/${ALLOWLIST}`, ref);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  private async fileAt(name: string, path: string, ref: string): Promise<string> {
    const query = new URLSearchParams({ ref });
    const data = (await this.request("GET", `${path}?${query}`)) as {
      type?: string;
      encoding?: string;
      content?: string;
      size?: number;
    };
    if (data?.type !== "file") throw new GitHubError(`${name} is not a file on ${ref}`, 0);
    if ((data.size ?? 0) > MAX_FILE_BYTES || data.encoding !== "base64" || typeof data.content !== "string") {
      throw new GitHubError(`GitHub did not send ${name} inline; it may be over 1 MB.`, 0);
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async dispatchWorkflow(
    file: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<{ runId: number | null; url: string }> {
    const data = (await this.request("POST", `${this.workflowPath(file, "actions")}/dispatches`, {
      ref,
      inputs,
      return_run_details: true,
    })) as { workflow_run_id?: unknown; html_url?: unknown } | undefined;
    const id = data?.workflow_run_id;
    return {
      runId: typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null,
      url: typeof data?.html_url === "string" ? data.html_url : "",
    };
  }

  private workflowPath(file: string, api: "contents" | "actions"): string {
    if (!WORKFLOW_FILE.test(file)) throw new GitHubError(`'${file.slice(0, 80)}' is not a workflow file name`, 0);
    const name = encodeURIComponent(file);
    return api === "contents"
      ? `/repos/${this.repoPath}/contents/.github/workflows/${name}`
      : `/repos/${this.repoPath}/actions/workflows/${name}`;
  }

  /** Latest attempt only. */
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw downloadError(id, err);
    }
    if (!download.ok) {
      throw new GitHubError(`downloading the log of job ${id} failed (${download.status})`, download.status);
    }
    return readTail(id, download);
  }

  /** GraphQL, since REST's PATCH has no `draft` key. Returns the draft state GitHub reports afterwards. */
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

  /** A failed GraphQL request is a 200 carrying `errors`, so it is inspected here. */
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
    created_at?: string;
    closed_at?: string | null;
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
    body: pr.body ?? "",
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    draft: pr.draft === true,
    state: pr.state === "closed" ? "closed" : "open",
    // The list endpoint sends only `merged_at`, not `merged`.
    merged: pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at.length > 0),
    createdAt: timestamp(pr.created_at),
    closedAt: timestamp(pr.closed_at),
    mergedAt: timestamp(pr.merged_at),
  };
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
    head_sha?: string;
    head_branch?: string | null;
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
    headSha: run.head_sha ?? "",
    headBranch: run.head_branch ?? "",
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

function assertId(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubError(`'${String(value).slice(0, 40)}' is not a ${what}`, 0);
  }
  return value;
}

function assertSha(value: string): string {
  if (!COMMIT_SHA.test(value)) throw new GitHubError(`'${value.slice(0, 40)}' is not a commit sha`, 0);
  return value;
}

/** A fetch error's message may carry the signed URL, so only its kind is kept. */
function downloadError(id: number, err: unknown): GitHubError {
  if (err instanceof GitHubError) return err;
  const { name, cause } = (err ?? {}) as { name?: string; cause?: { code?: unknown } };
  const kind = name === "TimeoutError" ? "timed out" : typeof cause?.code === "string" ? cause.code : "network error";
  return new GitHubError(`cannot download the log of job ${id}: ${kind}`, 0);
}

/** The last MAX_LOG_BYTES, minus a partial first line. */
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

/** Null when the token can push, else why not; a public repository answers `repository()` for any token. */
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

function permissionFor(path: string): string | undefined {
  if (path.endsWith("/dispatches")) return "Actions: read and write";
  if (path.includes("/actions/")) return "Actions: read";
  if (path.includes("/contents/")) return "Contents: read";
  if (path.endsWith("/merge")) return "Contents: read and write";
}

const NOT_FOUND_CAUSES: ReadonlyArray<[RegExp, string, string]> = [
  [/\/pulls\/\d+(\/merge)?$/, "pull request", "the number names no pull request"],
  [/\/actions\/runs\/\d+(\/jobs)?$/, "workflow run", "the id names no run"],
  [/\/actions\/jobs\/\d+$/, "job", "the id names no job"],
  [/\/actions\/jobs\/\d+\/logs$/, "job log", "the job has no log yet, as while it is running"],
  [/\/contents\/\.github\/workflows\/[^/]+$/, "workflow file", "it is not on that ref"],
  [/\/actions\/workflows\/[^/]+\/dispatches$/, "workflow", "no workflow on the default branch has that file name"],
];

/** An unscoped token and a missing repository both 404, so say what the operator most likely needs to change. */
function describeFailure(status: number, parsed: unknown, repoPath: string, path: string): string {
  const payload = parsed as { message?: string; errors?: Array<{ message?: string; field?: string }> } | undefined;
  const detail = [payload?.message, ...(payload?.errors ?? []).map((e) => e.message ?? e.field)]
    .filter((part): part is string => Boolean(part))
    .join("; ");

  switch (status) {
    case 401:
      return `GitHub rejected the token (401). It is invalid, revoked, or expired.`;
    case 403: {
      const permission = permissionFor(path);
      return (
        `GitHub refused the request (403)${detail ? `: ${detail}` : ""}. The token most likely lacks the ` +
        `permission this needs${permission ? `: ${permission}, on a fine-grained token` : ""}.`
      );
    }
    case 404: {
      // Startup proved the repository is visible, so blame what the path names.
      const addressed = NOT_FOUND_CAUSES.find(([pattern]) => pattern.test(path.split("?")[0]));
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
