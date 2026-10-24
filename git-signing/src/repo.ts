// Writes only objects and refs, never the working tree or index, so a dirty checkout is safe.

import { type Run, runOrThrow } from "./exec.js";

export class RepoError extends Error {}

export type Exists = (path: string) => Promise<boolean>;

/** In-progress operations whose saved state references commits signing would rewrite. */
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

  // The workspace may be owned by another uid, which git otherwise refuses.
  private gitArgv(args: readonly string[]): string[] {
    return ["-c", `safe.directory=${this.workspace}`, "-C", this.workspace, ...args];
  }

  private async capture(args: readonly string[], stdin?: Buffer): Promise<Buffer> {
    return runOrThrow(this.run, "git", this.gitArgv(args), stdin ? { stdin } : undefined);
  }

  private async tryCapture(args: readonly string[]): Promise<string | null> {
    const result = await this.run("git", this.gitArgv(args));
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
      // Relative for a normal checkout, absolute for a linked worktree.
      const absolute = path.startsWith("/") ? path : `${this.workspace}/${path}`;
      if (await this.exists(absolute)) return name;
    }
    return null;
  }

  async originRefs(): Promise<string[]> {
    const out = await this.tryCapture(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
    return out ? out.split("\n") : [];
  }

  /** Display only; not used to pick commits. */
  async upstreamRef(): Promise<string | null> {
    return (
      (await this.tryCapture(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) ??
      (await this.tryCapture(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))
    );
  }

  /** Not on any origin ref; parents first even under clock skew. */
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

  /** git's `%G?` letter; `N` means no signature. */
  async signatureState(sha: string): Promise<string> {
    const out = await this.capture(["log", "--format=%G?", "-1", sha]);
    return out.toString("utf8").trim();
  }

  async setRef(ref: string, sha: string, reason: string): Promise<void> {
    await this.capture(["update-ref", "-m", reason, ref, sha]);
  }

  /** Compare-and-swap: never discards a concurrent commit. */
  async moveRef(ref: string, newSha: string, expectedOldSha: string, reason: string): Promise<void> {
    await this.capture(["update-ref", "-m", reason, ref, newSha, expectedOldSha]);
  }
}
