import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, booleanFromEnv, dispatchFromEnv } from "../src/config.js";
import { RESERVED_VERBS } from "../src/server.js";

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

describe("dispatchFromEnv", () => {
  const NAME = "GITHUB_TONG_DISPATCH";
  const RESERVED = new Set(["push_branch", "list_workflows"]);
  const read = (raw: string | undefined) => dispatchFromEnv(NAME, raw, RESERVED);

  it("reads each entry, trimming whitespace", () => {
    assert.deepEqual(read(" deploy_production=deploy-production.yml@default , deploy_staging=deploy.staging.yaml@current"), [
      { verb: "deploy_production", file: "deploy-production.yml", ref: "default" },
      { verb: "deploy_staging", file: "deploy.staging.yaml", ref: "current" },
    ]);
  });

  it("reserves list_workflows alongside the built-in verbs", () => {
    assert.throws(() => dispatchFromEnv(NAME, "list_workflows=deploy.yml@default", RESERVED_VERBS), /already taken/);
  });

  it("lets two verbs share a workflow file", () => {
    assert.equal(read("a=deploy.yml@default,b=deploy.yml@current").length, 2);
  });

  it("treats unset and empty as no verbs", () => {
    assert.deepEqual(read(undefined), []);
    assert.deepEqual(read("  "), []);
  });

  it("refuses any malformed entry, naming the key and the entry", () => {
    const cases: Array<[string, RegExp]> = [
      ["deploy=deploy.yml", /is not <verb>=<workflow file>@<default\|current>/],
      ["deploy=deploy.yml@default,", /entry '' is not/],
      ["deploy=a=b.yml@default", /is not/],
      ["Deploy=deploy.yml@default", /lowercase letters/],
      ["1deploy=deploy.yml@default", /lowercase letters/],
      ["deploy-prod=deploy.yml@default", /lowercase letters/],
      [`${"a".repeat(65)}=deploy.yml@default`, /lowercase letters/],
      ["push_branch=deploy.yml@default", /already taken: push_branch/],
      ["list_workflows=deploy.yml@default", /already taken: list_workflows/],
      ["a=x.yml@default,a=y.yml@current", /already taken: a/],
      ["deploy=../deploy.yml@default", /no directory/],
      ["deploy=sub/deploy.yml@default", /no directory/],
      ["deploy=deploy.json@default", /\.yml or \.yaml/],
      ["deploy=deploy.yml@main", /'default' or 'current'/],
      ["deploy=deploy.yml@Default", /'default' or 'current'/],
    ];
    for (const [raw, expected] of cases) {
      assert.throws(
        () => read(raw),
        (err: Error) => err instanceof ConfigError && err.message.startsWith(`${NAME} entry `) && expected.test(err.message),
        raw,
      );
    }
  });
});
