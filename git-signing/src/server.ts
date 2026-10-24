// No verb takes a parameter, so no caller value can reach git's argv.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Run } from "./exec.js";
import type { SigningKey } from "./gpg.js";
import type { Repo } from "./repo.js";
import { inspect, signCommits, type SignOutcome, type Status } from "./sign.js";

export type Context = {
  repo: Repo;
  run: Run;
  key: SigningKey;
  passphrase: string | undefined;
};

const INSTRUCTIONS = `Signs this workspace's commits that are not yet on origin.

The signing key stays in this tong; no verb takes a key, ref, or path. Signing
changes the rewritten commits' SHAs, leaves the working tree and index alone, and
saves the old head to a backup ref.

Call signing_status first to see what would change.`;

function renderStatus(status: Status): string {
  const lines: string[] = [];
  lines.push(`branch:   ${status.branch ?? "(detached HEAD)"}`);
  lines.push(`upstream: ${status.upstreamRef ?? "(none tracked)"}`);
  lines.push(`head:     ${status.head}`);
  lines.push(`key:      ${status.key.fingerprint}`);
  for (const uid of status.key.uids) lines.push(`          uid ${uid}`);

  lines.push("");
  if (status.commits.length === 0) {
    lines.push("No unpublished commits: everything reachable from HEAD is already on origin.");
  } else {
    lines.push(`Unpublished commits (${status.commits.length}), oldest first:`);
    for (const commit of status.commits) {
      const mark = commit.rewrite ? "sign " : commit.signed ? "ok   " : "     ";
      lines.push(`  ${mark} ${commit.sha.slice(0, 12)}  ${commit.subject}`);
    }
    const pending = status.commits.filter((c) => c.rewrite).length;
    lines.push("");
    lines.push(
      pending === 0
        ? "Nothing to do: every unpublished commit is already signed."
        : `${pending} commit(s) would be re-created with a signature; their SHAs will change.`,
    );
  }

  if (status.blockers.length > 0) {
    lines.push("");
    lines.push("Blocked:");
    for (const blocker of status.blockers) lines.push(`  - ${blocker}`);
  }
  return lines.join("\n");
}

function renderOutcome(outcome: SignOutcome): string {
  if (outcome.rewritten.length === 0) {
    return `Nothing to sign; ${outcome.newHead.slice(0, 12)} is unchanged.\n\n${renderStatus(outcome.status)}`;
  }
  const lines = [`Signed ${outcome.rewritten.length} commit(s) on ${outcome.status.branch}.`, ""];
  for (const { from, to } of outcome.rewritten) {
    lines.push(`  ${from.slice(0, 12)} -> ${to.slice(0, 12)}`);
  }
  lines.push("");
  lines.push(`New head:   ${outcome.newHead}`);
  lines.push(`Backup ref: ${outcome.backupRef} (was ${outcome.status.head})`);
  lines.push("");
  lines.push(
    "The working tree and index were not touched. To undo: " +
      `git reset --soft ${outcome.status.head}`,
  );
  return lines.join("\n");
}

/** Strict, so an invented argument is refused rather than dropped. */
const NO_ARGUMENTS = z.strictObject({});

/** Bounds the pre-validation walk of `arguments`; 1 is the SDK's minimum. Raise it for a verb with parameters. */
export const MAX_TOOL_INPUT_ELEMENTS = 1;

export function buildServer(context: Context): McpServer {
  const server = new McpServer(
    { name: "git-signing", version: "0.1.0" },
    {
      instructions: INSTRUCTIONS,
      // The tool set is fixed; registerTool would otherwise advertise `listChanged: true`.
      capabilities: { tools: { listChanged: false } },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  );

  server.registerTool(
    "signing_status",
    {
      title: "signing_status",
      description:
        "List commits not yet on origin: which are signed, which would be signed, and any blockers. Read-only.",
      inputSchema: NO_ARGUMENTS,
    },
    async () => {
      try {
        return { content: [{ type: "text" as const, text: renderStatus(await inspect(context.repo, context.key)) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `signing_status: error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "sign_commits",
    {
      title: "sign_commits",
      description:
        "Sign every commit reachable from HEAD that is on no origin ref, then move the branch. Rewritten commits get " +
        "new SHAs and the old head is saved to a backup ref. Working tree and index untouched. No-op if " +
        "all are already signed.",
      inputSchema: NO_ARGUMENTS,
    },
    async () => {
      try {
        const outcome = await signCommits(context.repo, context.run, context.key, context.passphrase);
        return { content: [{ type: "text" as const, text: renderOutcome(outcome) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `sign_commits: error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
