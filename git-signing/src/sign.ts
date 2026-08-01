// The signing pass: decide what may be rewritten, then rewrite it.
//
// Split into `inspect` (read-only, everything `signing_status` reports) and
// `signCommits` (the same inspection followed by the writes), so the dry run and
// the real run can never disagree about what is eligible.

import { attachSignature, isSigned, parentShas, parseCommit, rewriteParents, serializeCommit, stripSignature, identity } from "./commit.js";
import { detachSign, type SigningKey } from "./gpg.js";
import type { Run } from "./exec.js";
import type { Repo } from "./repo.js";

export class SigningError extends Error {}

export type CommitSummary = {
  sha: string;
  subject: string;
  committerEmail: string | null;
  signed: boolean;
  /** Whether this commit would be (or was) rebuilt with our signature. */
  rewrite: boolean;
};

export type Status = {
  branch: string | null;
  upstreamRef: string | null;
  head: string;
  key: { fingerprint: string; uids: string[] };
  commits: CommitSummary[];
  /** Empty means `sign_commits` will proceed. */
  blockers: string[];
};

export type SignOutcome = {
  status: Status;
  /** Oldest first. Empty when there was nothing to do. */
  rewritten: Array<{ from: string; to: string }>;
  newHead: string;
  backupRef: string | null;
};

const BACKUP_NAMESPACE = "refs/swarmforge/git-signing/pre-sign";

function subjectOf(message: Buffer): string {
  const text = message.toString("utf8");
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

/**
 * Collects *every* blocker rather than throwing at the first, so `signing_status`
 * can report everything that needs fixing in one round trip.
 */
export async function inspect(repo: Repo, key: SigningKey): Promise<Status> {
  await repo.assertIsRepo();

  const blockers: string[] = [];
  const branch = await repo.currentBranch();
  if (!branch) {
    blockers.push("HEAD is detached; check out a branch, since signing moves the branch ref");
  }

  const inProgress = await repo.inProgressOperation();
  if (inProgress) {
    blockers.push(
      `a ${inProgress} operation is in progress; its saved state references commits signing would rewrite -- finish or abort it first`,
    );
  }

  const originRefs = await repo.originRefs();
  if (originRefs.length === 0) {
    blockers.push(
      "no refs/remotes/origin/* refs exist, so nothing is known to be published and every commit in the " +
        "repository would count as unsigned work; run `git fetch origin` first",
    );
  }

  const head = await repo.headSha();

  // Without a published baseline the candidate set is meaningless, so stop here
  // rather than listing the entire history as pending signature.
  if (originRefs.length === 0) {
    return { branch, upstreamRef: await repo.upstreamRef(), head, key: { fingerprint: key.fingerprint, uids: key.uids }, commits: [], blockers };
  }

  // The single forward pass below is only correct because unpublishedCommits
  // returns parents before children (see its `--topo-order` note).
  const candidates = await repo.unpublishedCommits();
  const mustRewrite = new Set<string>();
  const commits: CommitSummary[] = [];

  for (const sha of candidates) {
    const commit = parseCommit(await repo.readCommit(sha));
    const alreadySigned = isSigned(commit);
    // A rewritten parent changes this commit's own bytes, so its existing
    // signature could not survive anyway. With untouched parents a signed commit
    // is left exactly as it is, which keeps somebody else's signature intact.
    const parentRewritten = parentShas(commit).some((parent) => mustRewrite.has(parent));
    const rewrite = !alreadySigned || parentRewritten;
    if (rewrite) mustRewrite.add(sha);

    commits.push({
      sha,
      subject: subjectOf(commit.message),
      committerEmail: identity(commit, "committer")?.email ?? null,
      signed: alreadySigned,
      rewrite,
    });
  }

  // A signature is a claim about who made the commit, so refuse to make that
  // claim on behalf of an email the key does not carry.
  const keyEmails = new Set(key.emails);
  const mismatched = commits.filter(
    (c) => c.rewrite && (c.committerEmail === null || !keyEmails.has(c.committerEmail.toLowerCase())),
  );
  if (mismatched.length > 0) {
    const offenders = [...new Set(mismatched.map((c) => c.committerEmail ?? "<unparseable committer>"))];
    blockers.push(
      `committer ${offenders.join(", ")} is not a user ID on signing key ${key.fingerprint} ` +
        `(key UIDs: ${key.uids.join(", ") || "none"}); signing would attest to the wrong identity. ` +
        "Fix the repository's user.email, or use a key whose UID matches.",
    );
  }

  return {
    branch,
    upstreamRef: await repo.upstreamRef(),
    head,
    key: { fingerprint: key.fingerprint, uids: key.uids },
    commits,
    blockers,
  };
}

/**
 * The working tree and index are never touched: each rewritten commit keeps its
 * original tree, so the branch move is a pure ref update and a dirty checkout is
 * unaffected. The pre-signing head is saved under `refs/swarmforge/git-signing/`
 * (on top of the reflog entry git writes anyway) so the rewrite is reversible.
 */
export async function signCommits(
  repo: Repo,
  run: Run,
  key: SigningKey,
  passphrase: string | undefined,
): Promise<SignOutcome> {
  const status = await inspect(repo, key);
  if (status.blockers.length > 0) {
    throw new SigningError(`cannot sign:\n- ${status.blockers.join("\n- ")}`);
  }

  const toRewrite = status.commits.filter((c) => c.rewrite);
  if (toRewrite.length === 0) {
    return { status, rewritten: [], newHead: status.head, backupRef: null };
  }

  const mapping = new Map<string, string>();
  const rewritten: Array<{ from: string; to: string }> = [];

  for (const summary of toRewrite) {
    const original = parseCommit(await repo.readCommit(summary.sha));
    // Strip before signing: the payload gpg signs, and that git later reconstructs
    // to verify, is the commit without its signature header.
    const rebased = stripSignature(rewriteParents(original, mapping));
    const payload = serializeCommit(rebased);
    const signature = await detachSign(run, payload, key, passphrase);
    const newSha = await repo.writeCommit(serializeCommit(attachSignature(rebased, signature)));
    mapping.set(summary.sha, newSha);
    rewritten.push({ from: summary.sha, to: newSha });
  }

  const newHead = mapping.get(status.head);
  if (!newHead) {
    // HEAD is unpublished and every rewritten commit is an ancestor of it, so a
    // rewrite that did not reach HEAD means the walk missed a commit.
    throw new SigningError(
      `internal error: rewrote ${rewritten.length} commit(s) but HEAD ${status.head} was not among them`,
    );
  }

  // Nothing has been signed if git cannot see a signature on what we just wrote --
  // a malformed header must fail loudly rather than leave commits that only look signed.
  const state = await repo.signatureState(newHead);
  if (state === "N") {
    throw new SigningError(
      `git does not recognize a signature on the rewritten commit ${newHead}; refusing to move the branch`,
    );
  }

  const backupRef = `${BACKUP_NAMESPACE}/${status.branch}`;
  await repo.setRef(backupRef, status.head, "git-signing: pre-signing head");
  await repo.moveRef(`refs/heads/${status.branch}`, newHead, status.head, "git-signing: sign unpublished commits");

  return { status, rewritten, newHead, backupRef };
}
