import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, configFromEnv } from "../src/config.js";

const TOKEN = "2/1/2:abc";

function refused(env: Parameters<typeof configFromEnv>[0], message: RegExp): void {
  assert.throws(
    () => configFromEnv(env),
    (err: Error) => err instanceof ConfigError && message.test(err.message),
  );
}

describe("configFromEnv", () => {
  it("reads the token and workspace gid, trimmed", () => {
    assert.deepEqual(configFromEnv({ ASANA_TOKEN: ` ${TOKEN}\n`, ASANA_WORKSPACE_ID: " 1100000000000001 " }), {
      token: TOKEN,
      workspaceGid: "1100000000000001",
    });
  });

  it("refuses a missing or blank token", () => {
    for (const ASANA_TOKEN of [undefined, "", "  "]) {
      refused({ ASANA_TOKEN, ASANA_WORKSPACE_ID: "1" }, /^ASANA_TOKEN is unset/);
    }
  });

  it("refuses a token that could break the Authorization header", () => {
    for (const ASANA_TOKEN of ["a b", "a\r\nX-Evil: 1", "tökén"]) {
      refused({ ASANA_TOKEN, ASANA_WORKSPACE_ID: "1" }, /^ASANA_TOKEN has whitespace, control, or non-ASCII/);
    }
  });

  it("refuses a workspace that is not a gid, without echoing it", () => {
    for (const ASANA_WORKSPACE_ID of [undefined, "REPLACE-ME", "12a", "-1", "1".repeat(21), "../users"]) {
      refused({ ASANA_TOKEN: TOKEN, ASANA_WORKSPACE_ID }, /^ASANA_WORKSPACE_ID is unset or not a gid; set it to the workspace's gid, digits only\.$/);
    }
  });
});
