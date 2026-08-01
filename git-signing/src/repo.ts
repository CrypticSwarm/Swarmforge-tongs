// Every git invocation the tong makes against the mounted workspace.
//
// All of them go through `git -c safe.directory=<workspace> -C <workspace>`: the
// workspace is owned by the anvil's uid on the host, and git refuses to operate on
// a repository owned by another user unless told the path is trusted.
//
// Nothing here writes to the working tree or the index. The only mutations are
// new objects (`hash-object -w`) and ref updates, which is what makes signing safe
// to run against a dirty checkout.

import { type Run, runOrThrow } from "./exec.js";

export class RepoError extends Error {}

/** Injected so sequencer-state checks are testable without a repo on disk. */
export type Exists = (path: string) => Promise<boolean>;

/** In-progress operations whose saved state references commits we are about to rewrite. */
const SEQUENCER_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
] as const;

export class Repo {
  constructor(
    private readonly run: Run,
    private readonly workspace: string,
    private readonly exists: Exists,
  ) {}

  private git(args: readonly string[]): string[] {
    return ["-c", `safe.directory=${this.workspace}`, "-C", this.workspace, ...args];
  }

  private async capture(args: readonly string[], stdin?: Buffer): Promise<Buffer> {
    return runOrThrow(this.run, "git", this.git(args), stdin ? { stdin } : undefined);
  }

  /** For queries whose failure is meaningful rather than exceptional. */
  private async tryCapture(args: readonly string[]): Promise<string | null> {
    const result = await this.run("git", this.git(args));
    if (result.exitCode !== 0) return null;
    const text = result.stdout.toString("utf8").trim();
    return text.length > 0 ? text : null;
  }

  async assertIsRepo(): Promise<void> {
    const inside = await this.tryCapture(["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      throw new RepoError(`${this.workspace} is not a git work tree`);
    }
  }

  /** Null when HEAD is detached. */
  async currentBranch(): Promise<string | null> {
    return this.tryCapture(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }

  async headSha(): Promise<string> {
    const sha = await this.tryCapture(["rev-parse", "HEAD"]);
    if (!sha) throw new RepoError("HEAD does not resolve to a commit; the repository has no commits yet");
    return sha;
  }

  async inProgressOperation(): Promise<string | null> {
    for (const name of SEQUENCER_PATHS) {
      const path = await this.tryCapture(["rev-parse", "--git-path", name]);
      if (!path) continue;
      // `--git-path` is relative to the repository root for a normal checkout,
      // but absolute for a linked worktree.
      const absolute = path.startsWith("/") ? path : `${this.workspace}/${path}`;
      if (await this.exists(absolute)) return name;
    }
    return null;
  }

  /** Empty means nothing is known to be published. */
  async originRefs(): Promise<string[]> {
    const out = await this.tryCapture(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
    return out ? out.split("\n") : [];
  }

  /**
   * The upstream this branch tracks, else origin's default branch. Reported for
   * context only -- what actually gets signed is decided by `unpublishedCommits`,
   * which is strictly safer than either.
   */
  async upstreamRef(): Promise<string | null> {
    return (
      (await this.tryCapture(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) ??
      (await this.tryCapture(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))
    );
  }

  /**
   * Commits reachable from HEAD but from no origin ref, oldest first -- that is,
   * "not in the upstream repo". Broader than `<upstream>..HEAD`, and safer: a
   * commit already published on some *other* origin branch is excluded, so signing
   * can never rewrite history somebody else already has.
   *
   * `--topo-order` matters: rev-list's default is commit-date order, which a
   * skewed clock can leave a parent trailing its own child in. Reversed topo order
   * guarantees every parent is visited before its children, which the single
   * forward pass in sign.ts depends on.
   */
  async unpublishedCommits(): Promise<string[]> {
    const out = await this.capture(["rev-list", "--topo-order", "--reverse", "HEAD", "--not", "--remotes=origin"]);
    const text = out.toString("utf8").trim();
    return text.length > 0 ? text.split("\n") : [];
  }

  async readCommit(sha: string): Promise<Buffer> {
    return this.capture(["cat-file", "commit", sha]);
  }

  async writeCommit(raw: Buffer): Promise<string> {
    const out = await this.capture(["hash-object", "-t", "commit", "-w", "--stdin"], raw);
    return out.toString("utf8").trim();
  }

  /**
   * git's own verdict on a commit's signature: `N` for none, `G` good, `U` good
   * but untrusted, `E`/`B`/`X`/`Y`/`R` for various failures. Used as a
   * post-condition -- if git says `N` on something we just signed, the header we
   * wrote is malformed, and that must surface as an error rather than as commits
   * that only look signed.
   */
  async signatureState(sha: string): Promise<string> {
    const out = await this.capture(["log", "--format=%G?", "-1", sha]);
    return out.toString("utf8").trim();
  }

  async setRef(ref: string, sha: string, reason: string): Promise<void> {
    await this.capture(["update-ref", "-m", reason, ref, sha]);
  }

  /**
   * Move a ref, but only if it still points where we last saw it. The compare-and-swap
   * is what keeps a concurrent commit in the anvil from being silently discarded.
   */
  async moveRef(ref: string, newSha: string, expectedOldSha: string, reason: string): Promise<void> {
    await this.capture(["update-ref", "-m", reason, ref, newSha, expectedOldSha]);
  }
}
