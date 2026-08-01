// Byte-fidelity tests for the commit-object module. This is the part of the tong
// that must be exactly right: a stray byte changes the object's hash, and a
// mis-shaped `gpgsig` header produces commits git reports as unsigned.

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import {
  CommitParseError,
  attachSignature,
  identity,
  isSigned,
  parentShas,
  parseCommit,
  rewriteParents,
  serializeCommit,
  stripSignature,
} from "../src/commit.js";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PARENT = "1111111111111111111111111111111111111111";

const PLAIN = [
  `tree ${TREE}`,
  `parent ${PARENT}`,
  "author Ada Lovelace <ada@example.com> 1700000000 +0000",
  "committer Ada Lovelace <ada@example.com> 1700000001 +0100",
  "",
  "Add the analytical engine",
  "",
  "Longer body.",
  "",
].join("\n");

describe("parse/serialize round-trip", () => {
  test("preserves a plain commit byte for byte", () => {
    const raw = Buffer.from(PLAIN, "utf8");
    assert.deepEqual(serializeCommit(parseCommit(raw)), raw);
  });

  test("preserves headers git commit-tree cannot reproduce", () => {
    // `encoding` and `mergetag` are exactly why this tong builds commit objects
    // itself instead of shelling out to `git commit-tree -S`.
    const raw = Buffer.from(
      [
        `tree ${TREE}`,
        `parent ${PARENT}`,
        "author Ada <ada@example.com> 1700000000 +0000",
        "committer Ada <ada@example.com> 1700000000 +0000",
        "encoding ISO-8859-1",
        "mergetag object 2222222222222222222222222222222222222222",
        " type commit",
        " tag v1.0",
        " tagger Ada <ada@example.com> 1699999999 +0000",
        " ",
        " Release 1.0",
        "",
        "Merge tag 'v1.0'",
        "",
      ].join("\n"),
      "utf8",
    );
    assert.deepEqual(serializeCommit(parseCommit(raw)), raw);
  });

  test("preserves non-UTF-8 bytes in an author name", () => {
    // Latin-1 'é' (0xe9) is not valid UTF-8; decoding it to a string and back
    // would replace it and change the commit's hash.
    const name = Buffer.from([0x41, 0xe9]);
    const raw = Buffer.concat([
      Buffer.from(`tree ${TREE}\nauthor `, "utf8"),
      name,
      Buffer.from(" <a@example.com> 1700000000 +0000\ncommitter ", "utf8"),
      name,
      Buffer.from(" <a@example.com> 1700000000 +0000\n\nmsg\n", "utf8"),
    ]);
    assert.deepEqual(serializeCommit(parseCommit(raw)), raw);
  });

  test("preserves a commit with an empty message", () => {
    const raw = Buffer.from(
      `tree ${TREE}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\n`,
      "utf8",
    );
    const commit = parseCommit(raw);
    assert.equal(commit.message.length, 0);
    assert.deepEqual(serializeCommit(commit), raw);
  });

  test("rejects a commit with no tree header", () => {
    const raw = Buffer.from("parent abc\nauthor A <a@x> 1 +0000\n\nmsg\n", "utf8");
    assert.throws(() => parseCommit(raw), CommitParseError);
  });

  test("rejects a header block that opens with a continuation line", () => {
    assert.throws(() => parseCommit(Buffer.from(" orphaned\n\nmsg\n", "utf8")), CommitParseError);
  });
});

describe("parents", () => {
  test("reads parents in order", () => {
    const raw = Buffer.from(
      [`tree ${TREE}`, "parent aaa", "parent bbb", "author A <a@x> 1 +0000", "committer A <a@x> 1 +0000", "", "m", ""].join("\n"),
      "utf8",
    );
    assert.deepEqual(parentShas(parseCommit(raw)), ["aaa", "bbb"]);
  });

  test("rewrites only mapped parents, keeping order", () => {
    // The unmapped second parent is the common case for a merge whose other side
    // is already published: it must keep its SHA.
    const raw = Buffer.from(
      [`tree ${TREE}`, "parent aaa", "parent bbb", "author A <a@x> 1 +0000", "committer A <a@x> 1 +0000", "", "m", ""].join("\n"),
      "utf8",
    );
    const rewritten = rewriteParents(parseCommit(raw), new Map([["aaa", "zzz"]]));
    assert.deepEqual(parentShas(rewritten), ["zzz", "bbb"]);
  });
});

describe("signatures", () => {
  const ARMOR = ["-----BEGIN PGP SIGNATURE-----", "", "iQEzBAABCgAd", "=Ab3d", "-----END PGP SIGNATURE-----", ""].join("\n");

  test("attachSignature reproduces git's byte layout", () => {
    const unsigned = parseCommit(Buffer.from(PLAIN, "utf8"));
    const signed = serializeCommit(attachSignature(unsigned, Buffer.from(ARMOR, "utf8")));

    // git's do_sign_commit: the header goes last in the header block, and every
    // armor line -- including the first, and including the blank one -- is
    // prefixed with exactly one space.
    const expected = [
      `tree ${TREE}`,
      `parent ${PARENT}`,
      "author Ada Lovelace <ada@example.com> 1700000000 +0000",
      "committer Ada Lovelace <ada@example.com> 1700000001 +0100",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " iQEzBAABCgAd",
      " =Ab3d",
      " -----END PGP SIGNATURE-----",
      "",
      "Add the analytical engine",
      "",
      "Longer body.",
      "",
    ].join("\n");
    assert.equal(signed.toString("utf8"), expected);
  });

  test("stripping the attached signature restores the signed payload exactly", () => {
    // This is the invariant git relies on to verify: the payload it reconstructs
    // by removing the gpgsig header must equal the bytes that were signed.
    const unsigned = parseCommit(Buffer.from(PLAIN, "utf8"));
    const payload = serializeCommit(unsigned);
    const signed = attachSignature(unsigned, Buffer.from(ARMOR, "utf8"));
    assert.deepEqual(serializeCommit(stripSignature(signed)), payload);
  });

  test("re-signing replaces an existing signature rather than stacking one", () => {
    const unsigned = parseCommit(Buffer.from(PLAIN, "utf8"));
    const once = attachSignature(unsigned, Buffer.from(ARMOR, "utf8"));
    const twice = attachSignature(once, Buffer.from(ARMOR, "utf8"));
    assert.equal(twice.headers.filter((h) => h.name === "gpgsig").length, 1);
    assert.deepEqual(serializeCommit(twice), serializeCommit(once));
  });

  test("detects both gpgsig spellings and strips them", () => {
    for (const header of ["gpgsig", "gpgsig-sha256"]) {
      const raw = Buffer.from(
        [`tree ${TREE}`, "author A <a@x> 1 +0000", "committer A <a@x> 1 +0000", `${header} -----BEGIN PGP SIGNATURE-----`, " sig", " -----END PGP SIGNATURE-----", "", "m", ""].join("\n"),
        "utf8",
      );
      const commit = parseCommit(raw);
      assert.equal(isSigned(commit), true, header);
      assert.equal(isSigned(stripSignature(commit)), false, header);
    }
  });

  test("an unsigned commit reads as unsigned", () => {
    assert.equal(isSigned(parseCommit(Buffer.from(PLAIN, "utf8"))), false);
  });
});

describe("identity", () => {
  test("reads name and email from author and committer", () => {
    const commit = parseCommit(Buffer.from(PLAIN, "utf8"));
    assert.deepEqual(identity(commit, "author"), { name: "Ada Lovelace", email: "ada@example.com" });
    assert.deepEqual(identity(commit, "committer"), { name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("handles a punctuated name and a plus-addressed email", () => {
    const raw = Buffer.from(
      `tree ${TREE}\nauthor Ada Lovelace, Jr. <ada+git@example.com> 1 +0000\ncommitter Ada Lovelace, Jr. <ada+git@example.com> 1 +0000\n\nm\n`,
      "utf8",
    );
    assert.deepEqual(identity(parseCommit(raw), "committer"), {
      name: "Ada Lovelace, Jr.",
      email: "ada+git@example.com",
    });
  });

  test("tolerates a timestamp git no longer writes", () => {
    // Only the email is used; the trailing date is copied through untouched, so a
    // historical spelling must not block signing.
    const raw = Buffer.from(
      `tree ${TREE}\nauthor A <a@x> 1 +00:00\ncommitter A <a@x> 1 +00:00\n\nm\n`,
      "utf8",
    );
    assert.equal(identity(parseCommit(raw), "committer")?.email, "a@x");
  });

  test("returns null when the field is missing", () => {
    const raw = Buffer.from(`tree ${TREE}\nauthor A <a@x> 1 +0000\n\nm\n`, "utf8");
    assert.equal(identity(parseCommit(raw), "committer"), null);
  });
});
