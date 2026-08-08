// In-memory stand-ins for `git` and `fetch`, wired in through the seams in
// src/exec.ts and src/github.ts, so the whole push-and-open-a-PR path is tested
// without git installed, without a token, and without a network.

import type { Run, RunResult } from "../src/exec.js";
import type { Fetch } from "../src/github.js";

export const WORKSPACE = "/workspace";
export const ASKPASS = "/app/askpass.sh";

export type GitCall = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: Buffer | undefined;
  /** argv with the `-c key=value` hardening pairs and `-C <workspace>` removed. */
  verb: string[];
};

export type FakeGitOptions = {
  branch?: string | null;
  head?: string;
  originUrl?: string | null;
  isRepo?: boolean;
  /** Output for the rejection paths. `--porcelain` puts the per-ref verdict on stdout. */
  pushFails?: { stderr: string; stdout?: string };
  pushUpToDate?: boolean;
  updateRefFails?: boolean;
  /** What rev-list reports as reachable from HEAD but from no origin ref, oldest first. */
  unpushed?: string[];
  /** Which of those carry a `gpgsig` header. */
  signed?: string[];
  /** Commit messages, for the shas that need a specific one. Defaults to the sha. */
  messages?: Record<string, string>;
  /** Shas `cat-file --batch` answers `missing` for, as a truncated batch also would. */
  missingObjects?: string[];
};

export class FakeGit {
  readonly calls: GitCall[] = [];
  readonly refs = new Map<string, string>();

  branch: string | null;
  head: string;
  originUrl: string | null;
  isRepo: boolean;
  pushFails: { stderr: string; stdout?: string } | undefined;
  pushUpToDate: boolean;
  updateRefFails: boolean;
  unpushed: string[];
  signed: Set<string>;
  messages: Record<string, string>;
  missingObjects: Set<string>;

  constructor(options: FakeGitOptions = {}) {
    this.branch = options.branch === undefined ? "feature" : options.branch;
    this.head = options.head ?? "1111111111111111111111111111111111111111";
    this.originUrl = options.originUrl === undefined ? "git@github.com:acme/widgets.git" : options.originUrl;
    this.isRepo = options.isRepo ?? true;
    this.pushFails = options.pushFails;
    this.pushUpToDate = options.pushUpToDate ?? false;
    this.updateRefFails = options.updateRefFails ?? false;
    this.unpushed = options.unpushed ?? [];
    this.signed = new Set(options.signed ?? []);
    this.messages = options.messages ?? {};
    this.missingObjects = new Set(options.missingObjects ?? []);
  }

  /** The push call, for asserting on argv and environment. */
  get pushCall(): GitCall | undefined {
    return this.calls.find((call) => call.verb[0] === "push");
  }

  callsTo(verb: string): GitCall[] {
    return this.calls.filter((call) => call.verb[0] === verb);
  }

  private ok(stdout = ""): RunResult {
    return { exitCode: 0, stdout: Buffer.from(stdout, "utf8"), stderr: "" };
  }

  private fail(message: string): RunResult {
    return { exitCode: 1, stdout: Buffer.alloc(0), stderr: message };
  }

  readonly run: Run = async (command, args, options) => {
    if (command !== "git") return this.fail(`unexpected command ${command}`);

    const argv = [...args];
    const verb = [...argv];
    while (verb[0] === "-c" || verb[0] === "-C") verb.splice(0, 2);
    this.calls.push({ args: argv, env: options?.env ?? {}, stdin: options?.stdin, verb });

    return this.runGit(verb, options?.stdin);
  };

  /**
   * The bytes git stores, so the signature check runs against a real commit object
   * rather than against something shaped like the answer it is looking for.
   */
  private commitObject(sha: string): Buffer {
    const headers = [
      `tree ${"0".repeat(40)}`,
      "author A U Thor <a@example.com> 1700000000 +0000",
      "committer A U Thor <a@example.com> 1700000000 +0000",
      ...(this.signed.has(sha)
        ? ["gpgsig -----BEGIN PGP SIGNATURE-----", " ", " iQIzBAABCgAdFiEE", " -----END PGP SIGNATURE-----"]
        : []),
    ];
    return Buffer.from(`${headers.join("\n")}\n\n${this.messages[sha] ?? `commit ${sha}\n`}`, "utf8");
  }

  /** `<oid> <type> <size>\n<contents>\n` per requested object, as git writes it. */
  private catFileBatch(stdin: Buffer | undefined): RunResult {
    const requested = (stdin?.toString("utf8") ?? "")
      .split("\n")
      .filter((line) => line.length > 0);

    const parts: Buffer[] = [];
    for (const sha of requested) {
      if (this.missingObjects.has(sha)) {
        parts.push(Buffer.from(`${sha} missing\n`, "utf8"));
        continue;
      }
      const raw = this.commitObject(sha);
      parts.push(Buffer.from(`${sha} commit ${raw.length}\n`, "utf8"), raw, Buffer.from("\n", "utf8"));
    }
    return { exitCode: 0, stdout: Buffer.concat(parts), stderr: "" };
  }

  private runGit(verb: string[], stdin?: Buffer): RunResult {
    const [name, ...rest] = verb;

    switch (name) {
      case "rev-parse":
        if (rest[0] === "--is-inside-work-tree") return this.isRepo ? this.ok("true\n") : this.fail("not a work tree");
        if (rest[0] === "HEAD") return this.ok(`${this.head}\n`);
        if (rest[0] === "--verify") {
          const sha = this.refs.get(rest[rest.length - 1]);
          return sha ? this.ok(`${sha}\n`) : this.fail("no such ref");
        }
        return this.fail(`unexpected rev-parse: ${rest.join(" ")}`);

      case "rev-list":
        return this.ok(this.unpushed.map((sha) => `${sha}\n`).join(""));

      case "cat-file":
        return this.catFileBatch(stdin);

      case "config":
        return this.originUrl ? this.ok(`${this.originUrl}\n`) : this.fail("no such key");

      case "symbolic-ref":
        return this.branch ? this.ok(`${this.branch}\n`) : this.fail("HEAD is detached");

      case "push":
        if (this.pushFails) {
          return {
            exitCode: 1,
            stdout: Buffer.from(this.pushFails.stdout ?? "", "utf8"),
            stderr: this.pushFails.stderr,
          };
        }
        return this.ok(
          this.pushUpToDate
            ? `To github.com\n=\trefs/heads/x:refs/heads/x\t[up to date]\nDone\n`
            : `To github.com\n\trefs/heads/x:refs/heads/x\t0000000..${this.head.slice(0, 7)}\nDone\n`,
        );

      case "update-ref": {
        if (this.updateRefFails) return this.fail("cannot lock ref");
        const [ref, sha] = rest.slice(2);
        this.refs.set(ref, sha);
        return this.ok();
      }

      default:
        return this.fail(`unexpected git verb: ${name}`);
    }
  }
}

export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeResponse = { status: number; json: unknown };

export class FakeGitHubApi {
  readonly calls: FetchCall[] = [];

  constructor(private readonly routes: Record<string, FakeResponse | (() => FakeResponse)> = {}) {}

  get lastBody(): unknown {
    return this.calls[this.calls.length - 1]?.body;
  }

  readonly fetch: Fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    this.calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const key = `${method} ${new URL(url).pathname}`;
    const route = this.routes[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `no fake route for ${key}` }), { status: 500 });
    }
    const { status, json } = typeof route === "function" ? route() : route;
    return new Response(JSON.stringify(json), { status });
  };
}

export const REPO_ROUTE = {
  "GET /repos/acme/widgets": { status: 200, json: { default_branch: "main" } },
};

export function prRoute(number: number, base: string, head: string, draft = false) {
  return {
    "POST /repos/acme/widgets/pulls": {
      status: 201,
      json: {
        number,
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        draft,
        base: { ref: base },
        head: { ref: head },
      },
    },
  };
}

export type PrState = {
  number: number;
  title: string;
  body: string | null;
  base: string;
  head: string;
  draft?: boolean;
  state?: "open" | "closed";
  merged?: boolean;
};

/** A pull request as GitHub reports it, for the read and edit paths. */
export function prJson(pr: PrState) {
  return {
    number: pr.number,
    node_id: `PR_node_${pr.number}`,
    html_url: `https://github.com/acme/widgets/pull/${pr.number}`,
    title: pr.title,
    body: pr.body,
    draft: pr.draft ?? false,
    state: pr.state ?? "open",
    merged: pr.merged ?? false,
    base: { ref: pr.base },
    head: { ref: pr.head },
  };
}

export function getPrRoute(pr: PrState) {
  return { [`GET /repos/acme/widgets/pulls/${pr.number}`]: { status: 200, json: prJson(pr) } };
}
