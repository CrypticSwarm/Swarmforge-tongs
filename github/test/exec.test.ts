// realRun against real child processes: only process.execPath, so no git or network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTPUT_BYTES, RunError, realRun, runOrThrow } from "../src/exec.js";

/** Runs `body` with a pidfile path in a fresh temp dir, removed afterwards. */
async function withPidfile(body: (pidfile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "exec-test-"));
  try {
    await body(join(dir, "pid"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Asserts the process whose pid is in `pidfile` is dead shortly after. */
async function assertKilled(pidfile: string): Promise<void> {
  const pid = Number(readFileSync(pidfile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, `process ${pid} survived`);
}

/** Whether `pid` runs; a zombie waiting on a reaper does not. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

const node = (code: string) => realRun(process.execPath, ["-e", code]);

describe("realRun", () => {
  it("reports exit codes and captures both streams", async () => {
    const result = await node(`process.stdout.write("out"); process.stderr.write("err"); process.exit(3);`);
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout.toString("utf8"), "out");
    assert.equal(result.stderr, "err");
  });

  it("treats a signal-killed child as a failure, never as exit 0", async () => {
    await assert.rejects(
      () => node(`process.kill(process.pid, "SIGKILL");`),
      (err: Error) => {
        assert.ok(err instanceof RunError);
        assert.match(err.message, /SIGKILL/);
        return true;
      },
    );
  });

  it("kills the whole process group at the timeout, and settles at once", async () => {
    await withPidfile(async (pidfile) => {
      // A grandchild holding the pipes, as git-remote-https does for git.
      const code =
        `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], ` +
        `{ stdio: "inherit" }); require("node:fs").writeFileSync(${JSON.stringify(pidfile)}, String(c.pid)); ` +
        `setTimeout(() => {}, 3000);`;
      const started = Date.now();
      await assert.rejects(() => realRun(process.execPath, ["-e", code], { timeoutMs: 300 }), /timed out after 0\.3s/);
      assert.ok(Date.now() - started < 1500, "settled without waiting on the grandchild");
      await assertKilled(pidfile);
    });
  });

  it("kills a command that ignores SIGTERM and SIGINT", async () => {
    await withPidfile(async (pidfile) => {
      const code =
        `process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); ` +
        `require("node:fs").writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setTimeout(() => {}, 10_000);`;
      await assert.rejects(() => realRun(process.execPath, ["-e", code], { timeoutMs: 300 }), /timed out after 0\.3s/);
      await assertKilled(pidfile);
    });
  });

  it("does not call a kill from elsewhere a timeout", async () => {
    await assert.rejects(
      () => realRun(process.execPath, ["-e", `process.kill(process.pid, "SIGKILL");`], { timeoutMs: 10_000 }),
      (err: Error) => err instanceof RunError && !/timed out/.test(err.message) && /SIGKILL/.test(err.message),
    );
  });

  it("leaves no timer behind once a command finishes in time", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const before = timers();
    await realRun(process.execPath, ["-e", ""], { timeoutMs: 60_000 });
    assert.equal(timers(), before);
    await assert.rejects(() => realRun("/nonexistent/definitely-not-a-command", [], { timeoutMs: 60_000 }), RunError);
    assert.equal(timers(), before);
  });

  it("truncates runaway output instead of buffering it all", async () => {
    const result = await node(`process.stdout.write(Buffer.alloc(${MAX_OUTPUT_BYTES} + 4096, 97));`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, MAX_OUTPUT_BYTES);
  });

  it("rejects when the command does not exist", async () => {
    await assert.rejects(() => realRun("/nonexistent/definitely-not-a-command", []), RunError);
  });
});

describe("runOrThrow", () => {
  it("surfaces stderr in the failure message", async () => {
    await assert.rejects(
      () => runOrThrow(realRun, process.execPath, ["-e", `process.stderr.write("the detail"); process.exit(1);`]),
      /the detail/,
    );
  });
});
