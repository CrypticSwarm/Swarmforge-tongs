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

/** Long enough for any reasonable PR, short enough that nothing enormous is sent. */
export const MAX_TITLE = 256;
export const MAX_BODY = 65536;

export type PullRequest = {
  number: number;
  /** GraphQL's identifier for the same pull request; empty if GitHub omitted it. */
  nodeId: string;
  url: string;
  title: string;
  body: string;
  base: string;
  head: string;
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

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "swarmforge-tong-github",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new GitHubError(`cannot reach ${this.apiBase}: ${(err as Error).message}`, 0);
    }

    const text = await response.text();
    const parsed = text.length > 0 ? safeJson(text) : undefined;

    if (!response.ok) {
      throw new GitHubError(describeFailure(response.status, parsed, this.repoPath, path), response.status);
    }
    return parsed;
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

  /**
   * The one caller-supplied value in this tong that becomes part of a URL rather
   * than part of a request body. Checked here as well as at the MCP surface, so
   * nothing but a positive integer can ever be interpolated into a path.
   */
  private pullPath(number: number): string {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new GitHubError(`'${String(number).slice(0, 40)}' is not a pull request number`, 0);
    }
    return `/repos/${this.repoPath}/pulls/${number}`;
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
    state?: string;
    base?: { ref?: string };
    head?: { ref?: string };
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
    draft: pr.draft === true,
    state: pr.state === "closed" ? "closed" : "open",
    merged: pr.merged === true,
  };
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
      return `GitHub refused the request (403)${detail ? `: ${detail}` : ""}. The token most likely lacks the permission this needs.`;
    case 404:
      // A wrong pull request number is by far the likelier cause once the tong has
      // started, since startup already proved the token can see the repository.
      if (/\/pulls\/\d+$/.test(path)) {
        return (
          `GitHub cannot see that pull request in ${repoPath} (404). Either the number names no pull ` +
          `request, or the token is no longer scoped to this repository.`
        );
      }
      return (
        `GitHub cannot see ${repoPath} (404). Either the repository does not exist, or the token is not ` +
        `scoped to it -- a fine-grained token must list this repository and grant Contents and Pull requests.`
      );
    case 422:
      return `GitHub rejected the request (422)${detail ? `: ${detail}` : ""}.`;
    default:
      return `GitHub returned ${status}${detail ? `: ${detail}` : ""}.`;
  }
}
