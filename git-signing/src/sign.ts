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
  /** Whether this commit would be (or was) rebuilt with this key's signature. */
  rewrite: boolean;
};

export type Status = {
  branch: string | null;
  upstreamRef: string | null;
  head: string;
  key: { fingerprint: string; uids: string[] };
  commits: CommitSummary[];
  blockers: string[];
};

export type SignOutcome = {
  status: Status;
  /** Parents first. */
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

  if (originRefs.length === 0) {
    return { branch, upstreamRef: await repo.upstreamRef(), head, key: { fingerprint: key.fingerprint, uids: key.uids }, commits: [], blockers };
  }

  // One forward pass: candidates come parents first.
  const candidates = await repo.unpublishedCommits();
  const mustRewrite = new Set<string>();
  const commits: CommitSummary[] = [];

  for (const sha of candidates) {
    const commit = parseCommit(await repo.readCommit(sha));
    const alreadySigned = isSigned(commit);
    // A rewritten parent invalidates this commit's signature; otherwise keep it, preserving another signer's.
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

/** Trees are unchanged, so the working tree and index still match the new HEAD. */
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
    const unsignedRewrite = stripSignature(rewriteParents(original, mapping));
    const payload = serializeCommit(unsignedRewrite);
    const signature = await detachSign(run, payload, key, passphrase);
    const newSha = await repo.writeCommit(serializeCommit(attachSignature(unsignedRewrite, signature)));
    mapping.set(summary.sha, newSha);
    rewritten.push({ from: summary.sha, to: newSha });
  }

  const newHead = mapping.get(status.head);
  if (!newHead) {
    // Rewrites propagate to descendants, so HEAD is always rewritten.
    throw new SigningError(
      `internal error: rewrote ${rewritten.length} commit(s) but HEAD ${status.head} was not among them`,
    );
  }

  // A malformed header must fail loudly, not leave commits that only look signed.
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
