// Process entrypoint. Reads its configuration from the environment, imports the
// signing key into the tmpfs keyring entrypoint.sh prepared, and serves MCP.
//
// Startup is fail-closed: a missing key, a key that is not a usable secret key, or
// a workspace that is not a git work tree stops the process here rather than
// leaving a tong that accepts calls and fails every one of them.

import { access } from "node:fs/promises";
import { realRun } from "./exec.js";
import { importSigningKey } from "./gpg.js";
import { Repo } from "./repo.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const workspace = process.env.GIT_SIGNING_WORKSPACE ?? "/workspace";

const armoredKey = process.env.GIT_SIGNING_KEY;
const passphrase = process.env.GIT_SIGNING_KEY_PASSPHRASE;

// Child processes inherit this process's environment, so drop the key material
// from it as soon as it is read. git and gpg get what they need over pipes.
delete process.env.GIT_SIGNING_KEY;
delete process.env.GIT_SIGNING_KEY_PASSPHRASE;

if (!armoredKey) {
  console.error(
    "git-signing: GIT_SIGNING_KEY is unset. It must be an ASCII-armored private key delivered as a " +
      "${secret:...} reference in the tong definition.",
  );
  process.exit(1);
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const repo = new Repo(realRun, workspace, exists);

const key = await (async () => {
  try {
    const imported = await importSigningKey(realRun, armoredKey);
    await repo.assertIsRepo();
    return imported;
  } catch (err) {
    console.error(`git-signing: ${(err as Error).message}`);
    process.exit(1);
  }
})();

const httpServer = createApp({ repo, run: realRun, key, passphrase }).listen(port, () => {
  console.log(
    `git-signing listening on :${port} (key ${key.fingerprint}, workspace ${workspace}, ` +
      `${passphrase === undefined ? "no passphrase" : "passphrase supplied"})`,
  );
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
