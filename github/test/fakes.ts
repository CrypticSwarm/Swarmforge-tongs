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
  /** argv with the `-c key=value` hardening pairs and `-C <workspace>` removed. */
  verb: string[];
};

export type FakeGitOptions = {
  branch?: string | null;
  head?: string;
  originUrl?: string | null;
  isRepo?: boolean;
  /** Exit code and stderr for the push, for the rejection paths. */
  pushFails?: { stderr: string };
  pushUpToDate?: boolean;
};

export class FakeGit {
  readonly calls: GitCall[] = [];
  readonly refs = new Map<string, string>();

  branch: string | null;
  head: string;
  originUrl: string | null;
  isRepo: boolean;
  pushFails: { stderr: string } | undefined;
  pushUpToDate: boolean;

  constructor(options: FakeGitOptions = {}) {
    this.branch = options.branch === undefined ? "feature" : options.branch;
    this.head = options.head ?? "1111111111111111111111111111111111111111";
    this.originUrl = options.originUrl === undefined ? "git@github.com:acme/widgets.git" : options.originUrl;
    this.isRepo = options.isRepo ?? true;
    this.pushFails = options.pushFails;
    this.pushUpToDate = options.pushUpToDate ?? false;
  }

  /** The push call, for asserting on argv and environment. */
  get pushCall(): GitCall | undefined {
    return this.calls.find((call) => call.verb[0] === "push");
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
    this.calls.push({ args: argv, env: options?.env ?? {}, verb });

    return this.runGit(verb);
  };

  private runGit(verb: string[]): RunResult {
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

      case "config":
        return this.originUrl ? this.ok(`${this.originUrl}\n`) : this.fail("no such key");

      case "symbolic-ref":
        return this.branch ? this.ok(`${this.branch}\n`) : this.fail("HEAD is detached");

      case "push":
        if (this.pushFails) return this.fail(this.pushFails.stderr);
        return this.ok(
          this.pushUpToDate
            ? `To github.com\n=\trefs/heads/x:refs/heads/x\t[up to date]\nDone\n`
            : `To github.com\n\trefs/heads/x:refs/heads/x\t0000000..${this.head.slice(0, 7)}\nDone\n`,
        );

      case "update-ref": {
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
