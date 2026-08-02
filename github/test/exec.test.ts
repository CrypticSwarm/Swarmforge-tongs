// realRun against real child processes. The only binary used is the node running
// the tests (process.execPath), so the suite still needs no git and no network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OUTPUT_BYTES, RunError, realRun, runOrThrow } from "../src/exec.js";

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
