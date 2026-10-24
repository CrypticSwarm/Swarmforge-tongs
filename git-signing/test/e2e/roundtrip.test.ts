import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realRun, runOrThrow } from "../../src/exec.js";
import { importSigningKey, type SigningKey } from "../../src/gpg.js";
import { Repo } from "../../src/repo.js";
import { inspect, signCommits } from "../../src/sign.js";

const EMAIL = "tong-e2e@example.invalid";
const NAME = "Tong E2E";

let root = "";
let gnupgHome = "";
let workspace = "";
let remote = "";
let key: SigningKey;

const exists = (path: string) => access(path).then(() => true, () => false);

async function git(cwd: string, args: string[]): Promise<string> {
  const out = await runOrThrow(realRun, "git", args, {
    cwd,
    env: {
      ...process.env,
      GNUPGHOME: gnupgHome,
      GIT_AUTHOR_NAME: NAME,
      GIT_AUTHOR_EMAIL: EMAIL,
      GIT_COMMITTER_NAME: NAME,
      GIT_COMMITTER_EMAIL: EMAIL,
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
  return out.toString("utf8").trim();
}

async function commitFile(name: string, contents: string, message: string): Promise<string> {
  await writeFile(join(workspace, name), contents);
  await git(workspace, ["add", name]);
  await git(workspace, ["commit", "-m", message]);
  return git(workspace, ["rev-parse", "HEAD"]);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "git-signing-e2e-"));
  gnupgHome = join(root, "gnupg");
  workspace = join(root, "workspace");
  remote = join(root, "remote.git");

  // A throwaway test key, so an empty passphrase on argv is fine here.
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  await runOrThrow(
    realRun,
    "gpg",
    [
      "--batch",
      "--quiet",
      "--pinentry-mode", "loopback",
      "--passphrase", "",
      "--quick-generate-key",
      `${NAME} <${EMAIL}>`,
      "ed25519",
      "sign",
      "never",
    ],
    { env: { ...process.env, GNUPGHOME: gnupgHome } },
  );
  const armored = (
    await runOrThrow(realRun, "gpg", ["--batch", "--quiet", "--armor", "--export-secret-keys", EMAIL], {
      env: { ...process.env, GNUPGHOME: gnupgHome },
    })
  ).toString("utf8");

  key = await importSigningKey(
    (command, args, options) =>
      realRun(command, args, { ...options, env: { ...process.env, GNUPGHOME: gnupgHome } }),
    armored,
  );

  await runOrThrow(realRun, "git", ["init", "--bare", "-b", "main", remote]);
  await runOrThrow(realRun, "git", ["init", "-b", "main", workspace]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await git(workspace, ["config", "user.name", NAME]);
  await git(workspace, ["config", "user.email", EMAIL]);
});

after(async () => {
  if (!root) return;
  // Stop gpg-agent first so it neither outlives the test nor races the rm.
  await realRun("gpgconf", ["--homedir", gnupgHome, "--kill", "all"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

function repo(): Repo {
  const run = (command: string, args: readonly string[], options?: Parameters<typeof realRun>[2]) =>
    realRun(command, args, { ...options, env: { ...process.env, GNUPGHOME: gnupgHome } });
  return new Repo(run, workspace, exists);
}

function runWithGnupg(command: string, args: readonly string[], options?: Parameters<typeof realRun>[2]) {
  return realRun(command, args, { ...options, env: { ...process.env, GNUPGHOME: gnupgHome } });
}

describe("signing a real repository", () => {
  test("signs unpublished commits and leaves published ones alone", async () => {
    const published = await commitFile("base.txt", "base\n", "published base");
    await git(workspace, ["push", "-q", "origin", "main"]);
    await git(workspace, ["checkout", "-q", "-b", "feature"]);

    const localA = await commitFile("a.txt", "a\n", "local a");
    const localB = await commitFile("b.txt", "b\n", "local b");

    const treeBefore = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
    const before = new Map<string, string>();
    for (const sha of [localA, localB]) {
      before.set(sha, await git(workspace, ["show", "-s", "--format=%an|%ae|%ad|%cn|%ce|%cd|%s|%T", sha]));
    }

    const status = await inspect(repo(), key);
    assert.deepEqual(status.blockers, []);
    assert.deepEqual(
      status.commits.map((c) => c.sha),
      [localA, localB],
      "only the two unpublished commits are candidates",
    );

    const outcome = await signCommits(repo(), runWithGnupg, key, undefined);
    assert.equal(outcome.rewritten.length, 2);

    for (const { to } of outcome.rewritten) {
      const state = await git(workspace, ["log", "--format=%G?", "-1", to]);
      assert.match(state, /^[GU]$/, `git reports signature state '${state}' for ${to}`);
      await git(workspace, ["verify-commit", to]);
    }

    await git(workspace, ["fsck", "--no-progress", "--no-dangling"]);

    assert.equal(await git(workspace, ["rev-parse", "HEAD^{tree}"]), treeBefore);
    assert.equal(await git(workspace, ["diff", "--stat", `${localB}..HEAD`]), "");

    for (const { from, to } of outcome.rewritten) {
      assert.equal(
        await git(workspace, ["show", "-s", "--format=%an|%ae|%ad|%cn|%ce|%cd|%s|%T", to]),
        before.get(from),
        `identity or tree changed rewriting ${from}`,
      );
    }

    assert.equal(await git(workspace, ["rev-parse", "HEAD~2"]), published);

    assert.equal(await git(workspace, ["rev-parse", "HEAD"]), outcome.newHead);
    assert.equal(await git(workspace, ["rev-parse", outcome.backupRef!]), localB);
    assert.equal(await git(workspace, ["rev-parse", "HEAD^"]), outcome.rewritten[0].to);
  });

  test("a second pass is a no-op", async () => {
    const head = await git(workspace, ["rev-parse", "HEAD"]);
    const outcome = await signCommits(repo(), runWithGnupg, key, undefined);
    assert.deepEqual(outcome.rewritten, []);
    assert.equal(await git(workspace, ["rev-parse", "HEAD"]), head);
  });

  test("a dirty working tree is preserved across signing", async () => {
    await commitFile("c.txt", "c\n", "local c");
    await writeFile(join(workspace, "dirty.txt"), "uncommitted\n");
    await writeFile(join(workspace, "c.txt"), "modified\n");
    const dirtyBefore = await git(workspace, ["status", "--porcelain"]);

    const outcome = await signCommits(repo(), runWithGnupg, key, undefined);
    assert.equal(outcome.rewritten.length, 1);

    assert.equal(await git(workspace, ["status", "--porcelain"]), dirtyBefore);
    await git(workspace, ["verify-commit", "HEAD"]);
  });

  test("refuses when the committer is not a UID on the key", async () => {
    await git(workspace, ["checkout", "-q", "-b", "other-identity"]);
    await runOrThrow(realRun, "git", ["commit", "--allow-empty", "-q", "-m", "someone else"], {
      cwd: workspace,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Other",
        GIT_AUTHOR_EMAIL: "other@example.invalid",
        GIT_COMMITTER_NAME: "Other",
        GIT_COMMITTER_EMAIL: "other@example.invalid",
      },
    });

    const status = await inspect(repo(), key);
    assert.match(status.blockers.join("\n"), /other@example\.invalid is not a user ID/);
    await assert.rejects(() => signCommits(repo(), runWithGnupg, key, undefined), /cannot sign/);
  });
});
