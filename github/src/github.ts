// The GitHub REST client.
//
// Everything the agent supplies travels from here as JSON in a request body; the
// only values that reach a URL are the pinned `owner` and `repo`. `fetch` is
// injected so the path is testable without a token or a network.

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
  url: string;
  base: string;
  head: string;
  draft: boolean;
};

export type CreatePullRequest = {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
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
      throw new GitHubError(describeFailure(response.status, parsed, this.repoPath), response.status);
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

  async createPullRequest(input: CreatePullRequest): Promise<PullRequest> {
    const data = (await this.request("POST", `/repos/${this.repoPath}/pulls`, {
      title: input.title,
      body: input.body ?? "",
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    })) as {
      number?: number;
      html_url?: string;
      draft?: boolean;
      base?: { ref?: string };
      head?: { ref?: string };
    };

    if (typeof data?.number !== "number" || !data.html_url) {
      throw new GitHubError("GitHub accepted the pull request but returned no number or URL", 0);
    }

    return {
      number: data.number,
      url: data.html_url,
      base: data.base?.ref ?? input.base,
      head: data.head?.ref ?? input.head,
      draft: data.draft ?? input.draft ?? false,
    };
  }
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
function describeFailure(status: number, parsed: unknown, repoPath: string): string {
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
