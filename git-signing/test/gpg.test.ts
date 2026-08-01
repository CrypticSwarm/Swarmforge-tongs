// Key selection and gpg argv construction. Both are security boundaries: picking
// the wrong key of several would sign as the wrong person, and a passphrase that
// slipped onto argv would be readable from /proc.

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { GpgError, detachSignArgv, parseSecretKeys } from "../src/gpg.js";

// Shape taken from real `gpg --with-colons --list-secret-keys` output.
const ONE_KEY = [
  "sec:u:255:22:1122334455667788:1700000000:::u:::scESC:::+:::23::0:",
  "fpr:::::::::AAAABBBBCCCCDDDDEEEEFFFF00001111222233334:",
  "grp:::::::::0000000000000000000000000000000000000000:",
  "uid:u::::1700000000::ABCDEF::Ada Lovelace <ada@example.com>::::::::::0:",
  "ssb:u:255:18:99AABBCCDDEEFF00:1700000000::::::e:::+:::23:",
  "fpr:::::::::9999888877776666555544443333222211110000:",
  "",
].join("\n");

describe("parseSecretKeys", () => {
  test("reads the primary fingerprint, not a subkey's", () => {
    const key = parseSecretKeys(ONE_KEY);
    assert.equal(key.fingerprint, "AAAABBBBCCCCDDDDEEEEFFFF00001111222233334");
  });

  test("collects user IDs and their emails", () => {
    const key = parseSecretKeys(ONE_KEY);
    assert.deepEqual(key.uids, ["Ada Lovelace <ada@example.com>"]);
    assert.deepEqual(key.emails, ["ada@example.com"]);
  });

  test("lowercases emails so the committer check is case-insensitive", () => {
    const colons = ONE_KEY.replace("ada@example.com", "Ada@Example.COM");
    assert.deepEqual(parseSecretKeys(colons).emails, ["ada@example.com"]);
  });

  test("undoes gpg's colon-field escaping", () => {
    const colons = ONE_KEY.replace(
      "Ada Lovelace <ada@example.com>",
      "Ada\\x3a Lovelace <ada@example.com>",
    );
    assert.deepEqual(parseSecretKeys(colons).uids, ["Ada: Lovelace <ada@example.com>"]);
  });

  test("keeps a UID with no email out of the email list", () => {
    const colons = ONE_KEY.replace("Ada Lovelace <ada@example.com>", "Ada Lovelace");
    const key = parseSecretKeys(colons);
    assert.deepEqual(key.uids, ["Ada Lovelace"]);
    assert.deepEqual(key.emails, []);
  });

  test("rejects a public-key-only import", () => {
    // A public key export produces `pub`/`sub` records and no `sec`, so there is
    // nothing to sign with.
    const colons = ONE_KEY.replace("sec:", "pub:").replace("ssb:", "sub:");
    assert.throws(() => parseSecretKeys(colons), /imported no secret key/);
  });

  test("rejects more than one secret key", () => {
    assert.throws(() => parseSecretKeys(ONE_KEY + ONE_KEY), /2 secret keys/);
  });

  test("rejects a revoked, expired, or disabled key", () => {
    for (const [validity, expected] of [["r", /revoked/], ["e", /expired/], ["d", /disabled/]] as const) {
      const colons = ONE_KEY.replace("sec:u:", `sec:${validity}:`);
      assert.throws(() => parseSecretKeys(colons), expected);
    }
  });

  test("rejects a key with no signing-capable component", () => {
    // Capabilities without 's' anywhere: an encryption-only key.
    const colons = ONE_KEY.replace(":scESC:", ":eE:").replace(/:e:::\+:::23:$/m, ":e:::+:::23:");
    assert.throws(() => parseSecretKeys(colons), GpgError);
  });

  test("accepts a primary that cannot sign when a subkey can", () => {
    const colons = ONE_KEY.replace(":scESC:", ":cSC:").replace("18:99AABBCCDDEEFF00:1700000000::::::e:", "18:99AABBCCDDEEFF00:1700000000::::::s:");
    assert.equal(parseSecretKeys(colons).fingerprint, "AAAABBBBCCCCDDDDEEEEFFFF00001111222233334");
  });
});

describe("detachSignArgv", () => {
  const FPR = "AAAABBBBCCCCDDDDEEEEFFFF00001111222233334";

  test("never puts the passphrase on argv", () => {
    const argv = detachSignArgv(FPR, true);
    assert.deepEqual(argv.includes("--passphrase"), false);
    assert.deepEqual(argv.includes("--passphrase-file"), false);
    assert.deepEqual(argv.slice(argv.indexOf("--passphrase-fd")), ["--passphrase-fd", "3"]);
  });

  test("uses loopback pinentry only when a passphrase is supplied", () => {
    assert.equal(detachSignArgv(FPR, true).join(" ").includes("--pinentry-mode loopback"), true);
    // With no passphrase, a key that turns out to be protected must fail rather
    // than block on a pinentry that does not exist in this container.
    assert.equal(detachSignArgv(FPR, false).join(" ").includes("--pinentry-mode error"), true);
  });

  test("passes the fingerprint as a single argv word", () => {
    const argv = detachSignArgv(FPR, false);
    assert.equal(argv[argv.indexOf("--local-user") + 1], FPR);
  });

  test("always requests an armored detached signature", () => {
    const argv = detachSignArgv(FPR, false);
    assert.equal(argv.includes("--armor"), true);
    assert.equal(argv.includes("--detach-sign"), true);
    assert.equal(argv.includes("--batch"), true);
  });
});
