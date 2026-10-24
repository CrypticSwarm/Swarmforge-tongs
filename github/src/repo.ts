import { type Run, type RunResult, runOrThrow } from "./exec.js";
import type { Origin } from "./origin.js";

export class RepoError extends Error {}

/** Not exhaustive; a workspace `http.<url>.*` outranks any `-c http.*` by longest match. */
function hardening(workspace: string): string[] {
  return [
    "-c",
    `safe.directory=${workspace}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=", // a command git would run
    "-c",
    "core.gitProxy=", // the same, for a URL an `insteadOf` rewrote to git://
    "-c",
    "credential.helper=", // could intercept or persist the token
    "-c",
    "protocol.ext.allow=never", // `ext::` transports execute their URL
    "-c",
    "push.recurseSubmodules=no", // a submodule push carries GIT_ASKPASS to its own remote
    "-c",
    "push.followTags=false",
    "-c",
    "fetch.bundleURI=", // askpass would hand the token to the bundle's host
    "-c",
    "core.alternateRefsCommand=true", // a command fetch runs when objects/info/alternates exists
  ];
}

const LF = 0x0a;

/** Framed by declared size, so no commit-message byte can start an entry. */
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

/** Header presence only: with no keyring, `%G?` reads `N`. The agent-written message is never scanned. */
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

function failureDetail(result: RunResult): string {
  const detail = [result.stdout.toString("utf8").trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return detail || `git exited ${result.exitCode}`;
}

const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

const FETCH_FLAGS = {
  " ": "fast-forward",
  "+": "forced update",
  "*": "new",
  t: "tag update",
  "!": "rejected",
} as const;

export type FetchedRef = {
  ref: string;
  change: (typeof FETCH_FLAGS)[keyof typeof FETCH_FLAGS];
  from: string;
  to: string;
};

function parseFetch(output: Buffer): FetchedRef[] {
  const refs: FetchedRef[] = [];
  for (const line of output.toString("utf8").split("\n")) {
    const match = /^(.) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/.exec(line);
    if (!match || !Object.hasOwn(FETCH_FLAGS, match[1])) continue;
    const [, flag, from, to, ref] = match;
    refs.push({ ref, change: FETCH_FLAGS[flag as keyof typeof FETCH_FLAGS], from, to });
  }
  return refs;
}

/** `failure` is set when git exited non-zero after moving some refs. */
export type FetchOutcome = {
  refs: FetchedRef[];
  failure: string | null;
};

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
    private readonly requireSignedCommits: boolean,
  ) {}

  get requiresSignedCommits(): boolean {
    return this.requireSignedCommits;
  }

  private gitArgv(args: readonly string[]): string[] {
    return [...hardening(this.workspace), "-C", this.workspace, ...args];
  }

  /** Built, not inherited, so no other variable reaches git. */
  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      // A partial clone would otherwise fetch missing objects from its promisor remote.
      GIT_NO_LAZY_FETCH: "1",
      ...extra,
    };
  }

  /** Clears any remote named after `url`, which would redirect the token; needs git 2.46+. */
  private runWithToken(args: readonly string[], url: string, refspec: string, token: string): Promise<RunResult> {
    return this.run(
      "git",
      ["-c", `remote.${url}.url=`, "-c", `remote.${url}.pushurl=`, ...this.gitArgv([...args, url, refspec])],
      { env: this.env({ GIT_ASKPASS: this.askpass, GITHUB_TONG_TOKEN: token }) },
    );
  }

  private async capture(args: readonly string[], stdin?: Buffer): Promise<Buffer> {
    return runOrThrow(this.run, "git", this.gitArgv(args), { env: this.env(), stdin });
  }

  private async tryCapture(args: readonly string[]): Promise<string | null> {
    const result = await this.run("git", this.gitArgv(args), { env: this.env() });
    if (result.exitCode !== 0) return null;
    const text = result.stdout.toString("utf8").trim();
    return text.length > 0 ? text : null;
  }

  async isRepo(): Promise<boolean> {
    return (await this.tryCapture(["rev-parse", "--is-inside-work-tree"])) === "true";
  }

  /** `config --get`, not `remote get-url`, which applies workspace `insteadOf` rewrites. */
  async originUrl(): Promise<string | null> {
    return this.tryCapture(["config", "--get", "remote.origin.url"]);
  }

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

  /** Any origin branch counts as published; must match git-signing's set. */
  private async commitsToPush(sha: string): Promise<string[]> {
    const out = await this.capture(["rev-list", "--topo-order", "--reverse", sha, "--not", "--remotes=origin"]);
    const text = out.toString("utf8").trim();
    return text.length > 0 ? text.split("\n") : [];
  }

  private async unsignedCommits(shas: readonly string[]): Promise<string[]> {
    if (shas.length === 0) return [];

    const out = await this.capture(["cat-file", "--batch"], Buffer.from(`${shas.join("\n")}\n`, "utf8"));
    const objects = parseBatch(out);

    const unsigned: string[] = [];
    for (const sha of shas) {
      const raw = objects.get(sha);
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

  /** Checked locally: a repository without signature protection would accept unsigned history silently. */
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

  async fetch(origin: Origin, url: string, token: string): Promise<FetchOutcome> {
    const result = await this.runWithToken(
      [
        "fetch",
        "--porcelain",
        // A submodule fetch would carry GIT_ASKPASS to its own remote.
        "--no-recurse-submodules",
        // So a deleted branch's commits still count as published.
        "--no-prune",
        // With a URL and refspec, FETCH_HEAD would mark every branch for merge.
        "--no-write-fetch-head",
        "--no-auto-maintenance",
      ],
      url,
      FETCH_REFSPEC,
      token,
    );
    const refs = parseFetch(result.stdout);
    if (result.exitCode === 0) return { refs, failure: null };
    if (refs.length === 0) {
      throw new RepoError(`fetching from ${origin.owner}/${origin.repo} failed: ${failureDetail(result)}`);
    }
    return { refs, failure: result.stderr.trim() || `git exited ${result.exitCode}` };
  }

  /** Pushes HEAD's sha, not the branch name, which the agent can move mid-push. */
  async push(origin: Origin, url: string, token: string): Promise<PushOutcome> {
    const branch = await this.currentBranch();
    if (!branch) {
      throw new RepoError("HEAD is detached; check out a branch before pushing.");
    }
    assertUsableBranch(branch);
    const sha = await this.headSha();

    if (this.requireSignedCommits) await this.assertPushIsSigned(origin, sha);

    const result = await this.runWithToken(
      ["push", "--no-verify", "--porcelain"],
      url,
      `${sha}:refs/heads/${branch}`,
      token,
    );

    const stdout = result.stdout.toString("utf8");
    if (result.exitCode !== 0) {
      throw new RepoError(`pushing ${branch} to ${origin.owner}/${origin.repo} failed: ${failureDetail(result)}`);
    }

    const alreadyUpToDate = stdout.includes("[up to date]");
    // A URL push leaves the tracking ref stale, which would mark the pushed commits unpublished.
    try {
      await this.capture([
        "update-ref",
        "-m",
        "swarmforge github tong: pushed",
        `refs/remotes/origin/${branch}`,
        sha,
      ]);
    } catch (err) {
      throw new RepoError(
        `pushed ${branch} to ${origin.owner}/${origin.repo} at ${sha}, but updating ` +
          `refs/remotes/origin/${branch} failed: ${(err as Error).message}. The commits ARE on the server; ` +
          `do not run sign_commits until that ref points at ${sha}.`,
      );
    }

    return { branch, sha, alreadyUpToDate, detail: stdout.trim() || result.stderr.trim() };
  }
}
