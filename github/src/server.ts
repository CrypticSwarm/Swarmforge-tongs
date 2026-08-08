// The MCP surface.
//
// A pull request is text, so unlike the git-signing tong this one cannot take zero
// parameters. What a caller controls is the prose, the base branch, and which pull
// request of the pinned repository it is talking about; the head branch and the
// repository itself stay derived.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_BODY, MAX_TITLE, type GitHub, type PullRequest } from "./github.js";
import type { Origin } from "./origin.js";
import type { PushOutcome, Repo } from "./repo.js";

export type Context = {
  repo: Repo;
  github: GitHub;
  origin: Origin;
  pushUrl: string;
  token: string;
};

const INSTRUCTIONS = `Pushes branches and opens pull requests for the repository checked out in this workspace.

The GitHub token lives only in this tong and is never exposed to the caller. The
repository is fixed at startup from the workspace's own 'origin' remote -- no verb
accepts an owner, a repository, or a URL, and the tong will not act on any other
repository.

push_branch pushes the branch you have checked out. create_pr pushes it and then
opens the pull request, so there is no need to call both. Neither ever force-pushes.

get_pr and update_pr work on an already-open pull request, by number. Read one
before editing it: update_pr replaces the fields you pass outright, so an edit that
means to add to a description has to send the whole new description.`;

// Only when the gate is on: a tong that describes a rule it is not enforcing is
// worse than one that says nothing, because the agent has no way to tell which.
const SIGNED_COMMITS_INSTRUCTIONS = `This tong is configured to require signed commits. A push that would add an
unsigned commit to the repository is refused, and nothing is pushed. Sign the
commits you have not pushed yet -- the git-signing tong's sign_commits verb signs
exactly the set this checks -- and then call again.`;

const SIGNED_COMMITS_SENTENCE =
  "This tong requires signed commits: it refuses the push, and pushes nothing, if any commit the push would " +
  "add carries no signature.";

function describe(base: string, context: Context): string {
  return context.repo.requiresSignedCommits ? `${base} ${SIGNED_COMMITS_SENTENCE}` : base;
}

/** Never reaches git, but rejecting a nonsense ref here beats a 422 from GitHub. */
export const branchName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), "must not contain whitespace or control characters")
  .refine((value) => !value.startsWith("-"), "must not start with '-'");

/**
 * The repository is pinned, so a number is the whole address of a pull request.
 * Bounded to an integer here and again in the client, because unlike every other
 * parameter this one ends up in a URL path.
 */
export const prNumber = z.number().int().positive();

export type CreatePrInput = {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
};

function renderPush(outcome: PushOutcome, origin: Origin): string {
  const target = `${origin.owner}/${origin.repo}`;
  if (outcome.alreadyUpToDate) {
    return `${target} already has ${outcome.branch} at ${outcome.sha.slice(0, 12)}; nothing to push.`;
  }
  return (
    `Pushed ${outcome.branch} to ${target} at ${outcome.sha.slice(0, 12)}.\n` +
    `refs/remotes/origin/${outcome.branch} now points at it, so the git-signing tong will treat these ` +
    `commits as published and leave them alone.`
  );
}

export async function pushBranch(context: Context): Promise<string> {
  const outcome = await context.repo.push(context.origin, context.pushUrl, context.token);
  return renderPush(outcome, context.origin);
}

export async function createPr(context: Context, input: CreatePrInput): Promise<string> {
  const outcome = await context.repo.push(context.origin, context.pushUrl, context.token);
  const base = input.base ?? (await context.github.repository()).defaultBranch;

  if (base === outcome.branch) {
    throw new Error(
      `base and head are both '${base}'. A pull request needs a different base; check out the branch you ` +
        `want to propose, or pass a different 'base'.`,
    );
  }

  const pr = await context.github.createPullRequest({
    title: input.title,
    body: input.body,
    head: outcome.branch,
    base,
    draft: input.draft,
  });

  return [
    `Opened ${pr.draft ? "draft " : ""}pull request #${pr.number}: ${pr.head} -> ${pr.base}`,
    pr.url,
    "",
    renderPush(outcome, context.origin),
  ].join("\n");
}

/** What a caller needs before editing: the current text, verbatim, and where it points. */
function renderPr(pr: PullRequest): string {
  const status = pr.merged ? "merged" : pr.draft ? "draft" : pr.state;
  return [
    `#${pr.number} ${pr.head} -> ${pr.base} (${status})`,
    pr.url,
    "",
    `title: ${pr.title}`,
    "",
    "description:",
    pr.body.length > 0 ? pr.body : "(empty)",
  ].join("\n");
}

export async function getPr(context: Context, input: { number: number }): Promise<string> {
  return renderPr(await context.github.pullRequest(input.number));
}

export type UpdatePrInput = {
  number: number;
  title?: string;
  body?: string;
  base?: string;
  state?: "open" | "closed";
  draft?: boolean;
};

/**
 * What actually moved, rather than what was asked for. GitHub accepts an edit that
 * changes nothing, and reporting that as an edit would leave a caller believing a
 * description it never managed to send is now on the pull request.
 */
function renderUpdate(before: PullRequest, after: PullRequest): string {
  const changed: string[] = [];
  if (after.title !== before.title) changed.push("title");
  if (after.body !== before.body) changed.push("description");
  if (after.base !== before.base) changed.push(`base ${before.base} -> ${after.base}`);
  if (after.state !== before.state) changed.push(after.state === "closed" ? "closed it" : "reopened it");
  if (after.draft !== before.draft) {
    changed.push(after.draft ? "converted it to a draft" : "marked it ready for review");
  }

  if (changed.length === 0) {
    return `Pull request #${after.number} already matched what you asked for; nothing changed.\n${after.url}`;
  }
  return `Updated pull request #${after.number}: ${changed.join(", ")}\n${after.url}`;
}

/**
 * Draft is not part of the PATCH, so an edit that changes it as well as the text is
 * two calls to GitHub and cannot be atomic. They run text-first, and a failure in
 * the second leaves the first applied -- which the error says, because a caller that
 * assumed the whole edit was rolled back would send the text a second time.
 */
export async function updatePr(context: Context, input: UpdatePrInput): Promise<string> {
  const { number, draft, ...changes } = input;
  const editsText = Object.values(changes).some((value) => value !== undefined);
  if (!editsText && draft === undefined) {
    throw new Error("nothing to change: pass at least one of 'title', 'body', 'base', 'state', or 'draft'.");
  }

  // Read first, for three things: the base==head guard create_pr already has, the
  // node id the draft mutation needs, and a summary of what actually moved.
  const before = await context.github.pullRequest(number);
  if (changes.base !== undefined && changes.base === before.head) {
    throw new Error(
      `base and head would both be '${changes.base}'. A pull request needs a different base, and #${number} ` +
        `already proposes that branch.`,
    );
  }
  // Only when it would actually change something: passing the draft status a merged
  // pull request already has should not cost it an edit to its description.
  const changesDraft = draft !== undefined && draft !== before.draft;
  if (changesDraft && before.merged) {
    throw new Error(`#${number} is merged, and a merged pull request cannot become a draft or leave draft.`);
  }

  // `after.draft` rather than `changesDraft` only so the compiler can see that a
  // draft is being asked for here; a PATCH cannot have changed it in between.
  let after = editsText ? await context.github.updatePullRequest(number, changes) : before;

  if (draft !== undefined && draft !== after.draft) {
    try {
      after = { ...after, draft: await context.github.setDraft(after.nodeId, draft) };
    } catch (err) {
      if (!editsText) throw err;
      throw new Error(
        `${(err as Error).message}\n\nThe rest of the edit went through and does not need sending again:\n` +
          renderUpdate(before, after),
      );
    }
  }

  return renderUpdate(before, after);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(verb: string, err: unknown) {
  // Also to the container log: an MCP client may truncate or reformat this, and
  // the log is the only copy an operator can read after the fact.
  console.error(`${verb} failed:`, err);
  return {
    content: [{ type: "text" as const, text: `${verb}: error: ${(err as Error).message}` }],
    isError: true,
  };
}

export function buildServer(context: Context): McpServer {
  const instructions = context.repo.requiresSignedCommits
    ? `${INSTRUCTIONS}\n\n${SIGNED_COMMITS_INSTRUCTIONS}`
    : INSTRUCTIONS;
  const server = new McpServer({ name: "github", version: "0.1.0" }, { instructions });

  server.registerTool(
    "push_branch",
    {
      title: "push_branch",
      description: describe(
        "Push the branch currently checked out in the workspace to its origin repository on GitHub, and " +
          "update the local remote-tracking ref to match. Never force-pushes. Fails on a detached HEAD or a " +
          "non-fast-forward. No parameters: the branch and the repository are both derived from the workspace.",
        context,
      ),
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await pushBranch(context));
      } catch (err) {
        return errorResult("push_branch", err);
      }
    },
  );

  server.registerTool(
    "create_pr",
    {
      title: "create_pr",
      description: describe(
        "Push the branch currently checked out and open a pull request from it. The head branch and the " +
          "repository come from the workspace; only the text and the base branch are yours to choose. Set " +
          "'base' to another branch to stack this pull request on top of it; it defaults to the " +
          "repository's default branch.",
        context,
      ),
      inputSchema: {
        title: z.string().min(1).max(MAX_TITLE).describe("Pull request title."),
        body: z.string().max(MAX_BODY).optional().describe("Pull request description, in Markdown."),
        base: branchName.optional().describe("Branch to merge into. Defaults to the repository's default branch."),
        draft: z.boolean().optional().describe("Open the pull request as a draft."),
      },
    },
    async (input) => {
      try {
        return textResult(await createPr(context, input));
      } catch (err) {
        return errorResult("create_pr", err);
      }
    },
  );

  server.registerTool(
    "get_pr",
    {
      title: "get_pr",
      description:
        "Read one pull request of this workspace's repository: its title, its description, the branches it " +
        "goes between, and whether it is open, draft, closed, or merged. The repository is not a parameter " +
        "-- only pull requests of the pinned one are readable.",
      inputSchema: {
        number: prNumber.describe("Pull request number, as it appears in the repository."),
      },
    },
    async (input) => {
      try {
        return textResult(await getPr(context, input));
      } catch (err) {
        return errorResult("get_pr", err);
      }
    },
  );

  server.registerTool(
    "update_pr",
    {
      title: "update_pr",
      description:
        "Edit an open pull request of this workspace's repository. Every field is optional and only the ones " +
        "you pass change; each one you do pass replaces its current value outright, so call get_pr first and " +
        "send the whole new text rather than the part you are adding. The head branch cannot be changed -- " +
        "push to it instead.",
      inputSchema: {
        number: prNumber.describe("Pull request number, as it appears in the repository."),
        title: z.string().min(1).max(MAX_TITLE).optional().describe("Replacement title."),
        body: z.string().max(MAX_BODY).optional().describe("Replacement description, in Markdown."),
        base: branchName.optional().describe("Branch to merge into, to move this pull request onto another base."),
        state: z.enum(["open", "closed"]).optional().describe("Close the pull request, or reopen a closed one."),
        draft: z
          .boolean()
          .optional()
          .describe("true converts the pull request to a draft; false marks it ready for review."),
      },
    },
    async (input) => {
      try {
        return textResult(await updatePr(context, input));
      } catch (err) {
        return errorResult("update_pr", err);
      }
    },
  );

  return server;
}
