// An in-memory stand-in for the `git` and `gpg` binaries, wired in through the
// `Run` seam from src/exec.ts.
//
// It exists so the signing orchestration -- candidate selection, the rewrite walk,
// parent remapping, the ref moves -- is tested without docker, without gpg, and
// without a real key, as AGENTS.md requires of `make test`. Object IDs are computed
// the way git computes them, so the SHAs these tests assert on are real ones.

import { createHash } from "node:crypto";
import type { Run, RunResult } from "../src/exec.js";

export function hashCommit(raw: Buffer): string {
  const header = Buffer.from(`commit ${raw.length}\0`, "utf8");
  return createHash("sha1").update(Buffer.concat([header, raw])).digest("hex");
}

export type FakeGitOptions = {
  /** Null for a detached HEAD. */
  branch?: string | null;
  originRefs?: string[];
  /** In-progress sequencer state, e.g. "rebase-merge". */
  inProgress?: string | null;
  upstream?: string | null;
  /** Excluded from `rev-list --not --remotes=origin`. */
  published?: Set<string>;
};

export class FakeGit {
  readonly objects = new Map<string, Buffer>();
  readonly refs = new Map<string, string>();
  /** In order, so tests can assert the write *sequence*, not just the result. */
  readonly refUpdates: Array<{ ref: string; sha: string; expected?: string }> = [];
  readonly signedPayloads: Buffer[] = [];

  head = "";
  branch: string | null;
  originRefs: string[];
  inProgress: string | null;
  upstream: string | null;
  published: Set<string>;
  /** Set to make the fake gpg fail, exercising the mid-walk error path. */
  gpgFails = false;

  constructor(options: FakeGitOptions = {}) {
    this.branch = options.branch === undefined ? "feature" : options.branch;
    this.originRefs = options.originRefs ?? ["refs/remotes/origin/main"];
    this.inProgress = options.inProgress ?? null;
    this.upstream = options.upstream === undefined ? "origin/feature" : options.upstream;
    this.published = options.published ?? new Set();
  }

  addCommit(raw: Buffer): string {
    const sha = hashCommit(raw);
    this.objects.set(sha, raw);
    return sha;
  }

  /** The branch ref must exist for real: moveRef compare-and-swaps against it. */
  setHead(sha: string): void {
    this.head = sha;
    if (this.branch) this.refs.set(`refs/heads/${this.branch}`, sha);
  }

  /** Parents before children, like the real `rev-list --topo-order --reverse`. */
  private walk(): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (sha: string): void => {
      if (seen.has(sha) || this.published.has(sha)) return;
      seen.add(sha);
      for (const parent of this.parentsOf(sha)) visit(parent);
      order.push(sha);
    };
    visit(this.head);
    return order;
  }

  private parentsOf(sha: string): string[] {
    const raw = this.objects.get(sha);
    if (!raw) return [];
    const headerEnd = raw.indexOf("\n\n");
    const headers = raw.subarray(0, headerEnd === -1 ? raw.length : headerEnd).toString("utf8");
    return headers
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
  }

  private ok(stdout = ""): RunResult {
    return { exitCode: 0, stdout: Buffer.from(stdout, "utf8"), stderr: "" };
  }

  private fail(message: string): RunResult {
    return { exitCode: 1, stdout: Buffer.alloc(0), stderr: message };
  }

  readonly run: Run = async (command, args, options) => {
    if (command === "gpg") return this.runGpg(args, options?.stdin);
    if (command !== "git") return this.fail(`unexpected command ${command}`);

    // Strip the `-c safe.directory=... -C <workspace>` prefix Repo always adds.
    const argv = [...args];
    while (argv[0] === "-c" || argv[0] === "-C") argv.splice(0, 2);
    return this.runGit(argv, options?.stdin);
  };

  private runGpg(args: readonly string[], stdin?: Buffer): RunResult {
    if (!args.includes("--detach-sign")) return this.fail(`unexpected gpg call: ${args.join(" ")}`);
    if (this.gpgFails) return this.fail("simulated gpg failure");
    this.signedPayloads.push(stdin ?? Buffer.alloc(0));
    return this.ok(
      ["-----BEGIN PGP SIGNATURE-----", "", "ZmFrZXNpZ25hdHVyZQ==", "=xxxx", "-----END PGP SIGNATURE-----", ""].join("\n"),
    );
  }

  private runGit(argv: string[], stdin?: Buffer): RunResult {
    const [verb, ...rest] = argv;

    switch (verb) {
      case "rev-parse":
        if (rest[0] === "--is-inside-work-tree") return this.ok("true\n");
        if (rest[0] === "HEAD") return this.ok(`${this.head}\n`);
        if (rest[0] === "--git-path") return this.ok(`.git/${rest[1]}\n`);
        if (rest.includes("@{upstream}")) {
          return this.upstream ? this.ok(`${this.upstream}\n`) : this.fail("no upstream configured");
        }
        return this.fail(`unexpected rev-parse: ${rest.join(" ")}`);

      case "symbolic-ref": {
        const target = rest[rest.length - 1];
        if (target === "HEAD") {
          return this.branch ? this.ok(`${this.branch}\n`) : this.fail("HEAD is detached");
        }
        if (target === "refs/remotes/origin/HEAD") {
          return this.upstream ? this.ok(`${this.upstream}\n`) : this.fail("no origin/HEAD");
        }
        return this.fail(`unexpected symbolic-ref: ${target}`);
      }

      case "for-each-ref":
        return this.ok(this.originRefs.map((ref) => `${ref}\n`).join(""));

      case "rev-list":
        return this.ok(this.walk().map((sha) => `${sha}\n`).join(""));

      case "cat-file": {
        const raw = this.objects.get(rest[1]);
        return raw ? { exitCode: 0, stdout: raw, stderr: "" } : this.fail(`no such object ${rest[1]}`);
      }

      case "hash-object": {
        if (!stdin) return this.fail("hash-object called with no stdin");
        return this.ok(`${this.addCommit(stdin)}\n`);
      }

      case "log": {
        const raw = this.objects.get(rest[rest.length - 1]);
        if (!raw) return this.fail("no such commit");
        return this.ok(raw.includes("\ngpgsig ") || raw.subarray(0, 7).equals(Buffer.from("gpgsig ")) ? "U\n" : "N\n");
      }

      case "update-ref": {
        // `update-ref -m <reason> <ref> <new> [<expected-old>]`
        const positional = rest.slice(2);
        const [ref, sha, expected] = positional;
        if (expected !== undefined && this.refs.get(ref) !== expected) {
          return this.fail(`ref ${ref} is not at ${expected}`);
        }
        this.refs.set(ref, sha);
        this.refUpdates.push({ ref, sha, expected });
        if (this.branch && ref === `refs/heads/${this.branch}`) this.head = sha;
        return this.ok();
      }

      default:
        return this.fail(`unexpected git verb: ${verb}`);
    }
  }
}

export function commit(
  git: FakeGit,
  options: {
    parents?: string[];
    message?: string;
    committerEmail?: string;
    tree?: string;
    signature?: string;
  } = {},
): string {
  const tree = options.tree ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const email = options.committerEmail ?? "ada@example.com";
  const lines = [`tree ${tree}`];
  for (const parent of options.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author Ada <${email}> 1700000000 +0000`);
  lines.push(`committer Ada <${email}> 1700000000 +0000`);
  if (options.signature) {
    lines.push(`gpgsig -----BEGIN PGP SIGNATURE-----`, ` ${options.signature}`, ` -----END PGP SIGNATURE-----`);
  }
  lines.push("", options.message ?? "a commit", "");
  return git.addCommit(Buffer.from(lines.join("\n"), "utf8"));
}
