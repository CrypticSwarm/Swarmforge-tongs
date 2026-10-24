// Raw commit objects as Buffers: names and messages need not be UTF-8, and re-encoding would change the hash.
// Unknown headers (encoding, mergetag) are copied through; git commit-tree -S would drop them.

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

// git ends headers at the first `\n\n`; a mergetag's blank lines are indented to ` \n`, so they never match.
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

export function serializeCommit(commit: Commit): Buffer {
  return Buffer.concat([
    ...commit.headers.map(serializeHeader),
    Buffer.from([LF]),
    commit.message,
  ]);
}

// `gpgsig-sha256` is the sha256-repository spelling.
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

export function parentShas(commit: Commit): string[] {
  return commit.headers
    .filter((h) => h.name === "parent")
    .map((h) => h.value.toString("utf8"));
}

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

// The timestamp is matched loosely: old repositories hold timezone spellings git no longer writes.
const IDENTITY_RE = /^(?<name>.*?) <(?<email>[^>]*)>(?: .*)?$/s;

export type Identity = { name: string; email: string };

export function identity(commit: Commit, field: "author" | "committer"): Identity | null {
  const header = commit.headers.find((h) => h.name === field);
  if (!header) return null;
  const match = IDENTITY_RE.exec(header.value.toString("utf8"));
  if (!match?.groups) return null;
  return { name: match.groups.name, email: match.groups.email };
}

/** gpgsig goes last in the header block, where git puts it. */
export function attachSignature(commit: Commit, armoredSignature: Buffer): Commit {
  const stripped = stripSignature(commit);
  // A trailing newline would serialize as an empty continuation line.
  let value = armoredSignature;
  while (value.length > 0 && value[value.length - 1] === LF) {
    value = value.subarray(0, value.length - 1);
  }
  return {
    headers: [...stripped.headers, { name: "gpgsig", value: Buffer.from(value) }],
    message: stripped.message,
  };
}
