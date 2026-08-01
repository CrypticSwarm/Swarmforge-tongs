// The MCP surface: two verbs, neither of which takes a parameter.
//
// That is deliberate. A ref, a path, or a key id crossing this boundary would be
// untrusted input reaching git's argv; instead the tong derives all three itself
// from the repository and the key it was given. There is nothing here for a
// caller to inject into.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

const INSTRUCTIONS = `Signs the commits in this workspace that have not been published to origin.

The signing key lives only in this tong; it is never exposed to the caller and no
verb accepts a key, ref, or path. Signing rewrites each affected commit object, so
their SHAs change -- the working tree and index are untouched, and the pre-signing
head is saved to a backup ref.

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

export function buildServer(context: Context): McpServer {
  const server = new McpServer(
    { name: "git-signing", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "signing_status",
    {
      title: "signing_status",
      description:
        "Report which commits in the workspace are not yet on origin, which of them already carry a " +
        "signature, which would be signed, and anything currently blocking signing. Read-only.",
      inputSchema: {},
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
        "Sign every commit reachable from HEAD that is not on any origin ref. Each affected commit is " +
        "re-created with a signature, so its SHA changes; the branch is moved and the previous head is " +
        "saved to a backup ref. The working tree and index are not modified. No-op if everything is " +
        "already signed.",
      inputSchema: {},
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
