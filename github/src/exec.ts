// The one place this tong starts a subprocess.
//
// `spawn` is always called with an argv array and no `shell` option, so a value is
// a single argv word no matter what it contains. The token is not among them:
// `/proc/<pid>/cmdline` is readable by any process in this container, so it reaches
// git through GIT_ASKPASS and the environment instead (see repo.ts).

import { spawn } from "node:child_process";

export class RunError extends Error {}

export type RunOptions = {
  stdin?: Buffer;
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
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    collect(child.stdout!, stdoutChunks, { bytes: 0 });
    collect(child.stderr!, stderrChunks, { bytes: 0 });

    child.stdin!.on("error", () => {
      /* a child that exits without draining stdin surfaces as a non-zero exit */
    });
    child.stdin!.end(options.stdin ?? Buffer.alloc(0));

    child.on("error", (err) => reject(new RunError(`cannot run ${command}: ${err.message}`)));
    child.on("close", (code, signal) => {
      // A signal-killed child has no exit code; `code ?? 0` would report it as
      // success, and a killed push must never read as a completed one.
      if (code === null) {
        reject(new RunError(`${command} was killed by ${signal ?? "a signal"}`));
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
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
