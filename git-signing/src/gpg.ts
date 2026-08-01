// The signing key: importing it, describing it, and using it.
//
// Key material enters this process exactly once, as the `GIT_SIGNING_KEY`
// environment variable the launcher delivered over its secret FIFO, and reaches
// gpg only on stdin. The passphrase reaches gpg only on fd 3. Neither is ever an
// argv word (`/proc/<pid>/cmdline` is world-readable to the container) nor a
// file. GNUPGHOME is a tmpfs directory created by entrypoint.sh; gpg needs a
// keyring on a filesystem, and memory is the closest this gets to none.

import { type Run, runOrThrow } from "./exec.js";

export class GpgError extends Error {}

export type SigningKey = {
  /** Full 40-character primary fingerprint. */
  fingerprint: string;
  uids: string[];
  /** Lowercased emails parsed out of `uids`, for the committer identity check. */
  emails: string[];
};

function unescapeColonField(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function emailOf(uid: string): string | null {
  const match = /<([^>]+)>/.exec(uid);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parse `gpg --with-colons --list-secret-keys` down to the one key we sign with.
 *
 * Fails closed on anything ambiguous -- no secret key, more than one, revoked,
 * expired, or no signing-capable component. Picking the wrong key of several
 * would produce commits that verify as somebody else.
 */
export function parseSecretKeys(colons: string): SigningKey {
  const records = colons
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(":"));

  type Partial = { validity: string; capabilities: string; fingerprint?: string; uids: string[]; subCaps: string[] };
  const keys: Partial[] = [];
  let current: Partial | null = null;
  let lastRecordWasSubkey = false;

  for (const fields of records) {
    switch (fields[0]) {
      case "sec":
        current = { validity: fields[1] ?? "", capabilities: fields[11] ?? "", uids: [], subCaps: [] };
        keys.push(current);
        lastRecordWasSubkey = false;
        break;
      case "ssb":
        if (current) current.subCaps.push(fields[11] ?? "");
        lastRecordWasSubkey = true;
        break;
      case "fpr":
        // `fpr` describes whichever key record preceded it; only the primary's
        // fingerprint is wanted, and `--local-user <primary>` lets gpg choose the
        // right signing subkey underneath it.
        if (current && !lastRecordWasSubkey && !current.fingerprint) current.fingerprint = fields[9] ?? "";
        break;
      case "uid":
        if (current && fields[9]) current.uids.push(unescapeColonField(fields[9]));
        break;
      default:
        break;
    }
  }

  if (keys.length === 0) {
    throw new GpgError(
      "GIT_SIGNING_KEY imported no secret key; it must be an ASCII-armored private key " +
        "(gpg --armor --export-secret-keys <fingerprint>), not a public key export",
    );
  }
  if (keys.length > 1) {
    throw new GpgError(
      `GIT_SIGNING_KEY contains ${keys.length} secret keys; provide exactly one so there is no ambiguity about who signs`,
    );
  }

  const key = keys[0];
  if (!key.fingerprint) throw new GpgError("gpg reported a secret key with no fingerprint");
  if (key.validity === "r") throw new GpgError(`signing key ${key.fingerprint} is revoked`);
  if (key.validity === "e") throw new GpgError(`signing key ${key.fingerprint} is expired`);
  if (key.validity === "d") throw new GpgError(`signing key ${key.fingerprint} is disabled`);

  const canSign =
    key.capabilities.includes("s") || key.subCaps.some((caps) => caps.includes("s"));
  if (!canSign) {
    throw new GpgError(
      `signing key ${key.fingerprint} has no signing-capable key or subkey (gpg reports capabilities '${key.capabilities}')`,
    );
  }

  const uids = key.uids;
  const emails = uids.map(emailOf).filter((email): email is string => email !== null);
  return { fingerprint: key.fingerprint, uids, emails };
}

const BASE_ARGS = ["--batch", "--no-tty", "--quiet"] as const;

export async function importSigningKey(run: Run, armoredKey: string): Promise<SigningKey> {
  await runOrThrow(run, "gpg", [...BASE_ARGS, "--import"], {
    stdin: Buffer.from(armoredKey, "utf8"),
  });
  const colons = await runOrThrow(run, "gpg", [...BASE_ARGS, "--with-colons", "--list-secret-keys"]);
  return parseSecretKeys(colons.toString("utf8"));
}

/**
 * Split out from `detachSign` so a test can assert that the passphrase is on fd 3
 * and the fingerprint is a whole argv word, without a keyring present.
 */
export function detachSignArgv(fingerprint: string, hasPassphrase: boolean): string[] {
  const args = [...BASE_ARGS, "--armor", "--detach-sign", "--local-user", fingerprint];
  if (hasPassphrase) {
    // loopback keeps gpg from trying to reach a pinentry that does not exist in
    // this container; the passphrase itself travels on fd 3, never on argv.
    args.push("--pinentry-mode", "loopback", "--passphrase-fd", "3");
  } else {
    // Without this an unprotected key still works, but a key that turns out to be
    // protected would hang waiting for input instead of failing.
    args.push("--pinentry-mode", "error");
  }
  return args;
}

export async function detachSign(
  run: Run,
  payload: Buffer,
  key: SigningKey,
  passphrase: string | undefined,
): Promise<Buffer> {
  return runOrThrow(run, "gpg", detachSignArgv(key.fingerprint, passphrase !== undefined), {
    stdin: payload,
    fd3: passphrase === undefined ? undefined : Buffer.from(passphrase, "utf8"),
  });
}
