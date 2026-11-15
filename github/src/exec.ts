// The one place this tong starts a subprocess: argv array, no shell, so each value is one argv word.
// Never put the token in argv; /proc/<pid>/cmdline is readable in the container.

import { spawn } from "node:child_process";

export class RunError extends Error {}

export type RunOptions = {
  stdin?: Buffer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the command's whole process group after this long. */
  timeoutMs?: number;
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
    const { timeoutMs } = options;
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env,
      // Its own process group, so a timeout reaches helpers like git-remote-https too.
      detached: timeoutMs !== undefined,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    collect(child.stdout!, stdoutChunks, { bytes: 0 });
    collect(child.stderr!, stderrChunks, { bytes: 0 });

    child.stdin!.on("error", () => {
      /* a child that exits without draining stdin surfaces as a non-zero exit */
    });
    child.stdin!.end(options.stdin ?? Buffer.alloc(0));

    // Kills the group at `timeoutMs` and rejects then, without waiting for `close`.
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              /* the group has already exited */
            }
            // Releases the pipes, in case a process escaped the group and still holds them.
            child.stdout!.destroy();
            child.stderr!.destroy();
            reject(new RunError(`${command} timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new RunError(`cannot run ${command}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A killed push must never read as a completed one.
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
