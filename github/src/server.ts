// The MCP surface: two verbs.
//
// A pull request is text, so unlike the git-signing tong this one cannot take zero
// parameters. What a caller controls is the prose and the base branch; the head
// branch and the repository stay derived.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_BODY, MAX_TITLE, type GitHub } from "./github.js";
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
opens the pull request, so there is no need to call both. Neither ever force-pushes.`;

/** Never reaches git, but rejecting a nonsense ref here beats a 422 from GitHub. */
export const branchName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), "must not contain whitespace or control characters")
  .refine((value) => !value.startsWith("-"), "must not start with '-'");

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
  const server = new McpServer({ name: "github", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "push_branch",
    {
      title: "push_branch",
      description:
        "Push the branch currently checked out in the workspace to its origin repository on GitHub, and " +
        "update the local remote-tracking ref to match. Never force-pushes. Fails on a detached HEAD or a " +
        "non-fast-forward. No parameters: the branch and the repository are both derived from the workspace.",
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
      description:
        "Push the branch currently checked out and open a pull request from it. The head branch and the " +
        "repository come from the workspace; only the text and the base branch are yours to choose. Set " +
        "'base' to another branch to stack this pull request on top of it; it defaults to the " +
        "repository's default branch.",
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

  return server;
}
