import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, booleanFromEnv } from "../src/config.js";

const KEY = "GITHUB_TONG_REQUIRE_SIGNED_COMMITS";

describe("booleanFromEnv", () => {
  it("reads the two values it documents, however they are spelled", () => {
    for (const raw of ["true", "TRUE", " True "]) {
      assert.equal(booleanFromEnv(KEY, raw), true, raw);
    }
    for (const raw of ["false", "FALSE", " False "]) {
      assert.equal(booleanFromEnv(KEY, raw), false, raw);
    }
  });

  it("treats unset and empty as the default", () => {
    assert.equal(booleanFromEnv(KEY, undefined), false);
    assert.equal(booleanFromEnv(KEY, ""), false);
    assert.equal(booleanFromEnv(KEY, "   "), false);
  });

  // A knob that turns a check on cannot have near-misses quietly land on "off".
  it("refuses anything else, naming the key and the value", () => {
    for (const raw of ["1", "0", "yes", "no", "on", "off", "ture"]) {
      assert.throws(
        () => booleanFromEnv(KEY, raw),
        (err: Error) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, new RegExp(`${KEY} is set to '${raw}'`));
          assert.match(err.message, /'true' or 'false'/);
          return true;
        },
        raw,
      );
    }
  });
});
