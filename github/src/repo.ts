// Every git invocation the tong makes against the mounted workspace.

import { type Run, runOrThrow } from "./exec.js";
import type { Origin } from "./origin.js";

export class RepoError extends Error {}

/**
 * The workspace is the agent's, so its `.git/config` would otherwise be an input
 * to the one git process that holds the token.
 *
 * What contains that is the anvil's mount, not this function: `.git/config` and
 * `.git/hooks` (along with `.git/branches`, `.git/remotes`, and `.git/commondir`)
 * are mounted read-only in the agent's container, so a hostile entry cannot be
 * written in the first place. These overrides are a second layer for the case
 * where that mount is absent or incomplete.
 *
 * Read the list as a second layer rather than as the boundary. It cannot be
 * exhaustive, and one gap is structural: git resolves `http.<url>.*` by longest
 * URL match, so a workspace `http.https://github.com/.proxy` outranks any generic
 * `-c http.proxy=` given here.
 *
 *   safe.directory         git refuses a repository owned by another uid without it
 *   core.hooksPath         a directory with no hooks in it
 *   core.fsmonitor         an arbitrary command git would otherwise run
 *   core.gitProxy          the same, for any URL an `insteadOf` rewrote to git://
 *   credential.helper      empty, so no helper can intercept or persist the token
 *   protocol.ext.allow     `ext::` transports execute their URL
 *   push.recurseSubmodules a submodule push carries GIT_ASKPASS to its own remote
 *   push.followTags        tags are outside what this tong is asked to push
 */
function hardening(workspace: string): string[] {
  return [
    "-c",
    `safe.directory=${workspace}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.gitProxy=",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "push.recurseSubmodules=no",
    "-c",
    "push.followTags=false",
  ];
}

/** git's own rules are stricter; this is the subset that keeps a refspec unambiguous. */
function assertUsableBranch(branch: string): void {
  const bad =
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes(":") ||
    branch.includes("?") ||
    branch.includes("*") ||
    branch.includes("[") ||
    branch.includes("\\") ||
    /[\u0000-\u0020\u007f~^]/.test(branch);
  if (bad) throw new RepoError(`branch name '${branch}' is not one this tong will build a refspec from`);
}

export type PushOutcome = {
  branch: string;
  sha: string;
  alreadyUpToDate: boolean;
  detail: string;
};

export class Repo {
  constructor(
    private readonly run: Run,
    private readonly workspace: string,
    private readonly askpass: string,
  ) {}

  private git(args: readonly string[]): string[] {
    return [...hardening(this.workspace), "-C", this.workspace, ...args];
  }

  /** Built rather than inherited: everything omitted is something a subprocess cannot read. */
  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      ...extra,
    };
  }

  private async capture(args: readonly string[]): Promise<Buffer> {
    return runOrThrow(this.run, "git", this.git(args), { env: this.env() });
  }

  /** For queries whose failure is meaningful rather than exceptional. */
  private async tryCapture(args: readonly string[]): Promise<string | null> {
    const result = await this.run("git", this.git(args), { env: this.env() });
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

  /**
   * Read once at startup and never again. `config --get` rather than
   * `remote get-url`, which resolves workspace-controlled `insteadOf` rewrites.
   */
  async originUrl(): Promise<string | null> {
    return this.tryCapture(["config", "--get", "remote.origin.url"]);
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

  async remoteTrackingSha(branch: string): Promise<string | null> {
    return this.tryCapture(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  }

  /**
   * Push the branch to the pinned repository, then move `refs/remotes/origin/<branch>`
   * to match.
   *
   * That second step is not bookkeeping. The git-signing tong decides what it may
   * rewrite by asking which commits are reachable from no `refs/remotes/origin/*`.
   * Pushing to a URL rather than to the remote `origin` means git does not update
   * the tracking ref itself, and a stale one would let a later `sign_commits`
   * rewrite commits that are now on the server.
   *
   * No force, ever.
   */
  async push(origin: Origin, url: string, token: string): Promise<PushOutcome> {
    const branch = await this.currentBranch();
    if (!branch) {
      throw new RepoError("HEAD is detached; check out a branch before pushing.");
    }
    assertUsableBranch(branch);
    const sha = await this.headSha();

    const result = await this.run(
      "git",
      this.git(["push", "--no-verify", "--porcelain", url, `refs/heads/${branch}:refs/heads/${branch}`]),
      { env: this.env({ GIT_ASKPASS: this.askpass, GITHUB_TONG_TOKEN: token }) },
    );

    const stdout = result.stdout.toString("utf8");
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || stdout.trim();
      throw new RepoError(
        `pushing ${branch} to ${origin.owner}/${origin.repo} failed: ${detail || `git exited ${result.exitCode}`}`,
      );
    }

    const alreadyUpToDate = stdout.includes("[up to date]");
    await this.capture([
      "update-ref",
      "-m",
      "swarmforge github tong: pushed",
      `refs/remotes/origin/${branch}`,
      sha,
    ]);

    return { branch, sha, alreadyUpToDate, detail: stdout.trim() || result.stderr.trim() };
  }
}
