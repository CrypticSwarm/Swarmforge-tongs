// Raw git commit objects, as bytes.
//
// This module is pure and total: no subprocesses, no filesystem, no key
// material. It exists so the one operation that must be byte-exact -- turning an
// unsigned commit object into the same commit object carrying a `gpgsig` header
// -- is testable without git or gpg present.
//
// A commit object is a header block, a blank line, then the message:
//
//     tree <sha>\n
//     parent <sha>\n            (zero or more)
//     author Name <mail> <ts> <tz>\n
//     committer Name <mail> <ts> <tz>\n
//     [gpgsig <armor line>\n <armor line>\n ...]\n
//     [encoding ...]\n
//     [mergetag <tag object>\n ...]\n
//     \n
//     message bytes
//
// A header value continues onto following lines when they begin with a single
// space; that space is stripped to recover the value. Everything this module does
// not explicitly touch is copied through untouched, which is why `encoding` and
// `mergetag` survive a rewrite that `git commit-tree` would have dropped.
//
// Buffers, not strings, throughout: commit messages and author names are
// arbitrary bytes, and git does not promise them to be valid UTF-8. Decoding and
// re-encoding would corrupt a latin-1 name and change the object's hash.

const LF = 0x0a;
const SPACE = 0x20;

export class CommitParseError extends Error {}

export type CommitHeader = {
  name: string;
  /** Continuation lines rejoined by `\n`, with their leading space removed. */
  value: Buffer;
};

export type Commit = {
  headers: CommitHeader[];
  message: Buffer;
};

// git ends the header block at the *first* `\n\n`, so a mergetag's own blank
// lines (indented to ` \n`) cannot be mistaken for it.
function indexOfHeaderEnd(raw: Buffer): number {
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === LF && raw[i + 1] === LF) return i;
  }
  return -1;
}

export function parseCommit(raw: Buffer): Commit {
  const headerEnd = indexOfHeaderEnd(raw);
  const headerBlock = headerEnd === -1 ? raw : raw.subarray(0, headerEnd);
  const message = headerEnd === -1 ? Buffer.alloc(0) : raw.subarray(headerEnd + 2);

  const headers: CommitHeader[] = [];
  let cursor = 0;
  while (cursor < headerBlock.length) {
    let lineEnd = headerBlock.indexOf(LF, cursor);
    if (lineEnd === -1) lineEnd = headerBlock.length;
    const line = headerBlock.subarray(cursor, lineEnd);

    if (line[0] === SPACE) {
      const previous = headers[headers.length - 1];
      if (!previous) throw new CommitParseError("commit header block starts with a continuation line");
      previous.value = Buffer.concat([previous.value, Buffer.from([LF]), line.subarray(1)]);
    } else {
      const split = line.indexOf(SPACE);
      if (split === -1) throw new CommitParseError(`malformed commit header line: ${line.toString("utf8")}`);
      headers.push({
        name: line.subarray(0, split).toString("utf8"),
        value: Buffer.from(line.subarray(split + 1)),
      });
    }
    cursor = lineEnd + 1;
  }

  if (!headers.some((h) => h.name === "tree")) {
    throw new CommitParseError("commit object has no 'tree' header");
  }
  return { headers, message };
}

function serializeHeader(header: CommitHeader): Buffer {
  const parts: Buffer[] = [Buffer.from(`${header.name} `, "utf8")];
  let cursor = 0;
  let first = true;
  while (cursor <= header.value.length) {
    let lineEnd = header.value.indexOf(LF, cursor);
    if (lineEnd === -1) lineEnd = header.value.length;
    if (!first) parts.push(Buffer.from([LF, SPACE]));
    parts.push(header.value.subarray(cursor, lineEnd));
    first = false;
    if (lineEnd === header.value.length) break;
    cursor = lineEnd + 1;
  }
  parts.push(Buffer.from([LF]));
  return Buffer.concat(parts);
}

/** The exact bytes git would hash. */
export function serializeCommit(commit: Commit): Buffer {
  return Buffer.concat([
    ...commit.headers.map(serializeHeader),
    Buffer.from([LF]),
    commit.message,
  ]);
}

// `gpgsig-sha256` is the sha256-repository spelling. Both are dropped before
// re-signing: a signature over the old bytes is meaningless once the object changes.
const SIGNATURE_HEADERS = new Set(["gpgsig", "gpgsig-sha256"]);

export function isSigned(commit: Commit): boolean {
  return commit.headers.some((h) => SIGNATURE_HEADERS.has(h.name));
}

export function stripSignature(commit: Commit): Commit {
  return {
    headers: commit.headers.filter((h) => !SIGNATURE_HEADERS.has(h.name)),
    message: commit.message,
  };
}

/** Parent SHAs in order -- which matters: the first is the merge's first parent. */
export function parentShas(commit: Commit): string[] {
  return commit.headers
    .filter((h) => h.name === "parent")
    .map((h) => h.value.toString("utf8"));
}

/**
 * Leaving unmapped parents alone is the normal case for a merge whose second
 * parent is already published: it keeps its SHA, and the merge still points at it.
 */
export function rewriteParents(commit: Commit, mapping: ReadonlyMap<string, string>): Commit {
  return {
    headers: commit.headers.map((header) => {
      if (header.name !== "parent") return header;
      const old = header.value.toString("utf8");
      const replacement = mapping.get(old);
      return replacement ? { name: "parent", value: Buffer.from(replacement, "utf8") } : header;
    }),
    message: commit.message,
  };
}

// Only the name and email are read; the trailing `<timestamp> <tz>` is matched
// loosely because it is copied through untouched and historical repositories
// contain timezone spellings git still accepts but no longer writes.
const IDENTITY_RE = /^(?<name>.*?) <(?<email>[^>]*)>(?: .*)?$/s;

export type Identity = { name: string; email: string };

/**
 * Null when the header is absent or does not have git's shape -- callers treat
 * that as "cannot confirm this identity" and fail closed rather than guessing.
 */
export function identity(commit: Commit, field: "author" | "committer"): Identity | null {
  const header = commit.headers.find((h) => h.name === field);
  if (!header) return null;
  const match = IDENTITY_RE.exec(header.value.toString("utf8"));
  if (!match?.groups) return null;
  return { name: match.groups.name, email: match.groups.email };
}

/**
 * Attach an armored signature, reproducing git's own byte layout (`do_sign_commit`
 * in commit.c): the header goes last in the header block, immediately before the
 * blank line, and *every* line of the armor -- including the first -- is prefixed
 * with one space. `serializeHeader` re-adds those spaces, so the value stored here
 * is the armor with its newlines intact and no indentation.
 *
 * Signing is over the commit *without* this header, so callers serialize first,
 * sign those bytes, then call this with the result.
 */
export function attachSignature(commit: Commit, armoredSignature: Buffer): Commit {
  const stripped = stripSignature(commit);
  // gpg's armor ends with a newline. Keeping it would serialize as a trailing
  // continuation line holding nothing, which is not what git writes.
  let value = armoredSignature;
  while (value.length > 0 && value[value.length - 1] === LF) {
    value = value.subarray(0, value.length - 1);
  }
  return {
    headers: [...stripped.headers, { name: "gpgsig", value: Buffer.from(value) }],
    message: stripped.message,
  };
}
