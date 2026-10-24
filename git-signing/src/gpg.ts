// Key via stdin, passphrase via fd 3: never argv (readable in /proc) or a file.

import { type Run, runOrThrow } from "./exec.js";

export class GpgError extends Error {}

export type SigningKey = {
  fingerprint: string;
  uids: string[];
  /** Lowercased, from `uids`. */
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

/** Input is `gpg --with-colons --list-secret-keys` output. */
export function parseSecretKeys(colons: string): SigningKey {
  const records = colons
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(":"));

  type ParsedKey = { validity: string; capabilities: string; fingerprint?: string; uids: string[]; subkeyCapabilities: string[] };
  const keys: ParsedKey[] = [];
  let current: ParsedKey | null = null;
  let lastRecordWasSubkey = false;

  for (const fields of records) {
    switch (fields[0]) {
      case "sec":
        current = { validity: fields[1] ?? "", capabilities: fields[11] ?? "", uids: [], subkeyCapabilities: [] };
        keys.push(current);
        lastRecordWasSubkey = false;
        break;
      case "ssb":
        if (current) current.subkeyCapabilities.push(fields[11] ?? "");
        lastRecordWasSubkey = true;
        break;
      case "fpr":
        // `fpr` follows any key record; keep only the primary's, and gpg picks the signing subkey.
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
    key.capabilities.includes("s") || key.subkeyCapabilities.some((caps) => caps.includes("s"));
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

export function detachSignArgv(fingerprint: string, hasPassphrase: boolean): string[] {
  const args = [...BASE_ARGS, "--armor", "--detach-sign", "--local-user", fingerprint];
  if (hasPassphrase) {
    // The container has no pinentry.
    args.push("--pinentry-mode", "loopback", "--passphrase-fd", "3");
  } else {
    // A key that turns out to be protected fails instead of hanging.
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
