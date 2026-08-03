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

const LF = 0x0a;

/**
 * `cat-file --batch` output: `<oid> <type> <size>\n`, the object's bytes, then a
 * newline, repeated once per requested object.
 *
 * Framed by the declared size rather than by scanning for the next line that looks
 * like a header, so no byte of a commit message can be read as the start of another
 * entry. An `<oid> missing` line has no body and is skipped; the caller fails on any
 * sha it got no object for, which is also what catches output truncated at
 * MAX_OUTPUT_BYTES.
 */
function parseBatch(output: Buffer): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let cursor = 0;
  while (cursor < output.length) {
    const lineEnd = output.indexOf(LF, cursor);
    if (lineEnd === -1) break;
    const [oid, type, size] = output.subarray(cursor, lineEnd).toString("utf8").split(" ");
    const length = Number(size);
    if (type !== "commit" || !Number.isSafeInteger(length) || length < 0) {
      cursor = lineEnd + 1;
      continue;
    }
    const start = lineEnd + 1;
    const end = start + length;
    if (end > output.length) break;
    objects.set(oid, output.subarray(start, end));
    cursor = end + 1;
  }
  return objects;
}

/**
 * Whether a commit object carries a signature header, which is all this tong can
 * honestly answer. It holds no keyring, so it cannot verify one; that is the
 * server's job, and GitHub's branch protection is what decides whether a signature
 * is trusted.
 *
 * `git log --format=%G?` is not an alternative: this image has no gpg, and git
 * reports a signed commit as `N` when it cannot run one -- every signed commit
 * would read as unsigned.
 *
 * Only the header block is scanned. The message below it is the agent's to write,
 * so scanning the whole object would let a commit message beginning `gpgsig `
 * pass the check. Continuation lines start with a space and cannot match either.
 * latin1 decodes byte-for-byte, so an author name that is not valid UTF-8 stays
 * exactly as many bytes as it was.
 */
function isSigned(raw: Buffer): boolean {
  const headerEnd = raw.indexOf("\n\n");
  const headerBlock = headerEnd === -1 ? raw : raw.subarray(0, headerEnd);
  return /^gpgsig(?:-sha256)? /m.test(headerBlock.toString("latin1"));
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
  /**
   * `requireSignedCommits` is held here rather than passed to `push`, so it applies
   * to every verb that pushes without any of them having to remember it.
   */
  constructor(
    private readonly run: Run,
    private readonly workspace: string,
    private readonly askpass: string,
    private readonly requireSignedCommits: boolean,
  ) {}

  /** For the MCP surface, which tells the agent about the gate before it trips over it. */
  get requiresSignedCommits(): boolean {
    return this.requireSignedCommits;
  }

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

  private async capture(args: readonly string[], stdin?: Buffer): Promise<Buffer> {
    return runOrThrow(this.run, "git", this.git(args), { env: this.env(), stdin });
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
   * The commits pushing `sha` would add to the server: reachable from it, and from
   * no `refs/remotes/origin/*` ref. Oldest first.
   *
   * `--not --remotes=origin` rather than the branch's own upstream, for two reasons
   * that point the same way. It is the more accurate answer to "what would this push
   * add", since a commit already on some other origin branch is one the server has
   * and git will not send. And it is the exact set the git-signing tong signs, so
   * `sign_commits` followed by a push always satisfies the gate below -- a narrower
   * or wider set here would make the two tongs disagree about which commits matter.
   */
  private async commitsToPush(sha: string): Promise<string[]> {
    const out = await this.capture(["rev-list", "--topo-order", "--reverse", sha, "--not", "--remotes=origin"]);
    const text = out.toString("utf8").trim();
    return text.length > 0 ? text.split("\n") : [];
  }

  /** Those of `shas` whose commit object carries no signature header, in the order given. */
  private async unsignedCommits(shas: readonly string[]): Promise<string[]> {
    if (shas.length === 0) return [];

    const out = await this.capture(["cat-file", "--batch"], Buffer.from(`${shas.join("\n")}\n`, "utf8"));
    const objects = parseBatch(out);

    const unsigned: string[] = [];
    for (const sha of shas) {
      const raw = objects.get(sha);
      // Fail closed. Not knowing whether a commit is signed is not the same as it
      // being signed, and this is the branch a truncated batch would arrive on.
      if (!raw) {
        throw new RepoError(
          `git cat-file returned no commit object for ${sha}, so this tong cannot tell whether it is signed. ` +
            `Nothing has been pushed.`,
        );
      }
      if (!isSigned(raw)) unsigned.push(sha);
    }
    return unsigned;
  }

  /**
   * Refuse before the push rather than let the server do it: a repository whose
   * branch protection requires signatures would reject the whole push anyway, and a
   * repository without that protection would silently accept unsigned history.
   */
  private async assertPushIsSigned(origin: Origin, sha: string): Promise<void> {
    const commits = await this.commitsToPush(sha);
    const unsigned = await this.unsignedCommits(commits);
    if (unsigned.length === 0) return;

    const shown = unsigned.slice(0, 5).map((commit) => commit.slice(0, 12));
    const rest = unsigned.length > shown.length ? `, and ${unsigned.length - shown.length} more` : "";
    throw new RepoError(
      `refusing to push: ${unsigned.length} of the ${commits.length} commit${commits.length === 1 ? "" : "s"} ` +
        `this would add to ${origin.owner}/${origin.repo} ` +
        `${unsigned.length === 1 ? "carries" : "carry"} no signature (${shown.join(", ")}${rest}). This tong is ` +
        `configured with GITHUB_TONG_REQUIRE_SIGNED_COMMITS=true. Sign them and push again -- the ` +
        `git-signing tong's sign_commits verb signs exactly this set of commits. Nothing has been pushed.`,
    );
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
   * The refspec source is the sha read here, not the branch name: the agent owns
   * the workspace and can move the branch between that read and the push, and a
   * branch-name refspec would then push commits the tracking-ref update below
   * never records — the stale state described above, on demand.
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

    // Against the sha being pushed, not HEAD: the agent can move the branch, and a
    // gate that inspected a different commit than the refspec names would be one it
    // could push unsigned commits past.
    if (this.requireSignedCommits) await this.assertPushIsSigned(origin, sha);

    const result = await this.run(
      "git",
      this.git(["push", "--no-verify", "--porcelain", url, `${sha}:refs/heads/${branch}`]),
      { env: this.env({ GIT_ASKPASS: this.askpass, GITHUB_TONG_TOKEN: token }) },
    );

    const stdout = result.stdout.toString("utf8");
    if (result.exitCode !== 0) {
      // Both streams, because they carry different halves of the reason: with
      // --porcelain the per-ref verdict ("[remote rejected] ... permission denied")
      // is on stdout, while stderr has only the generic "failed to push some refs".
      const detail = [stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      throw new RepoError(
        `pushing ${branch} to ${origin.owner}/${origin.repo} failed: ${detail || `git exited ${result.exitCode}`}`,
      );
    }

    const alreadyUpToDate = stdout.includes("[up to date]");
    try {
      await this.capture([
        "update-ref",
        "-m",
        "swarmforge github tong: pushed",
        `refs/remotes/origin/${branch}`,
        sha,
      ]);
    } catch (err) {
      // The push itself succeeded; a generic failure here would hide that, and
      // the stale tracking ref is exactly the state that makes signing unsafe.
      throw new RepoError(
        `pushed ${branch} to ${origin.owner}/${origin.repo} at ${sha}, but updating ` +
          `refs/remotes/origin/${branch} failed: ${(err as Error).message}. The commits ARE on the server; ` +
          `do not run sign_commits until that ref points at ${sha}.`,
      );
    }

    return { branch, sha, alreadyUpToDate, detail: stdout.trim() || result.stderr.trim() };
  }
}
