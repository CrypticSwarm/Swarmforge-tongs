// The one place this tong starts a subprocess.
//
// Everything else in the tong reaches `git` and `gpg` through the `Run` seam
// below, which means two things: unit tests can drive the whole signing path with
// a recorded transcript and no binaries installed, and there is a single audited
// spot to check that no value ever reaches a shell.
//
// `spawn` is always called with an argv array and no `shell` option, so a caller
// value is a single argv word no matter what it contains -- it cannot become a
// flag, a path, or a shell metacharacter. The MCP surface takes no free-form
// strings at all (see server.ts), so nothing the agent sends even reaches here.

import { spawn } from "node:child_process";

export class RunError extends Error {}

export type RunOptions = {
  stdin?: Buffer;
  /**
   * For gpg's `--passphrase-fd 3`, which keeps the passphrase off argv
   * (`/proc/<pid>/cmdline` is world-readable) and off the filesystem.
   */
  fd3?: Buffer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type RunResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
};

export type Run = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** So a pathological repository cannot exhaust memory. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function collect(stream: NodeJS.ReadableStream, chunks: Buffer[], state: { bytes: number }): void {
  stream.on("data", (chunk: Buffer) => {
    if (state.bytes >= MAX_OUTPUT_BYTES) return;
    const remaining = MAX_OUTPUT_BYTES - state.bytes;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(slice);
    state.bytes += slice.length;
  });
}

export const realRun: Run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    // fd 3 is a pipe only when the caller has something to put on it; otherwise
    // the child must not inherit a stray descriptor.
    const stdio: Array<"pipe" | "ignore"> = ["pipe", "pipe", "pipe"];
    if (options.fd3) stdio.push("pipe");

    const child = spawn(command, [...args], {
      stdio,
      cwd: options.cwd,
      env: options.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    collect(child.stdout!, stdoutChunks, { bytes: 0 });
    collect(child.stderr!, stderrChunks, { bytes: 0 });

    if (options.fd3) {
      const extra = child.stdio[3] as NodeJS.WritableStream;
      extra.on("error", () => {
        /* the child may exit before reading; that surfaces as a non-zero exit */
      });
      extra.end(options.fd3);
    }

    child.stdin!.on("error", () => {
      /* likewise for a child that exits without draining stdin */
    });
    child.stdin!.end(options.stdin ?? Buffer.alloc(0));

    child.on("error", (err) => reject(new RunError(`cannot run ${command}: ${err.message}`)));
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      }),
    );
  });

export async function runOrThrow(
  run: Run,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<Buffer> {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.toString("utf8").trim();
    throw new RunError(`${command} ${args.join(" ")} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}
