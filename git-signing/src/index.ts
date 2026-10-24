import { access } from "node:fs/promises";
import { realRun } from "./exec.js";
import { importSigningKey } from "./gpg.js";
import { Repo } from "./repo.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const workspace = process.env.GIT_SIGNING_WORKSPACE ?? "/workspace";

const armoredKey = process.env.GIT_SIGNING_KEY;
const passphrase = process.env.GIT_SIGNING_KEY_PASSPHRASE;

// Before any spawn: children inherit the environment; key material goes over pipes instead.
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
