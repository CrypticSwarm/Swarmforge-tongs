import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** Only config failures: anything past them would call the real Asana. */
function start(env: Record<string, string>): { status: number | null; stderr: string } {
  const reportEnv = 'data:text/javascript,process.on("exit",()=>console.error("env token:",process.env.ASANA_TOKEN))';
  const { status, stderr } = spawnSync(process.execPath, ["--import", reportEnv, INDEX], {
    env: { PATH: process.env.PATH ?? "", PORT: "0", ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status, stderr };
}

describe("startup", () => {
  it("stops without a token", () => {
    const { status, stderr } = start({ ASANA_WORKSPACE_ID: "1" });
    assert.equal(status, 1);
    assert.match(stderr, /^asana: ASANA_TOKEN is unset/);
  });

  it("stops on the example's placeholder workspace, with the token already out of the environment", () => {
    const { status, stderr } = start({ ASANA_TOKEN: "2/1/2:secret", ASANA_WORKSPACE_ID: "REPLACE-ME" });
    assert.equal(status, 1);
    assert.match(stderr, /^asana: ASANA_WORKSPACE_ID is unset or not a gid/);
    assert.match(stderr, /^env token: undefined$/m);
  });
});
