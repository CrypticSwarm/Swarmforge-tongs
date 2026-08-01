// The signing orchestration: which commits are eligible, which are refused, and
// what the rewrite walk produces. Driven entirely through the fake git/gpg in
// fake-git.ts, so this runs with no docker, no gpg, and no key.

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { isSigned, parentShas, parseCommit, serializeCommit, stripSignature } from "../src/commit.js";
import type { SigningKey } from "../src/gpg.js";
import { Repo } from "../src/repo.js";
import { SigningError, inspect, signCommits } from "../src/sign.js";
import { FakeGit, commit } from "./fake-git.js";

const KEY: SigningKey = {
  fingerprint: "AAAABBBBCCCCDDDDEEEEFFFF00001111222233334",
  uids: ["Ada <ada@example.com>"],
  emails: ["ada@example.com"],
};

function repoFor(git: FakeGit, exists?: (path: string) => Promise<boolean>): Repo {
  return new Repo(
    git.run,
    "/workspace",
    exists ?? (async (path) => (git.inProgress ? path.endsWith(git.inProgress) : false)),
  );
}

/** A branch with `count` unsigned commits on top of a published base. */
function branchWithUnsigned(count: number, options: { committerEmail?: string } = {}): FakeGit {
  const git = new FakeGit();
  const base = commit(git, { message: "published base" });
  git.published.add(base);
  let head = base;
  for (let i = 0; i < count; i++) {
    head = commit(git, { parents: [head], message: `local ${i}`, committerEmail: options.committerEmail });
  }
  git.setHead(head);
  return git;
}

describe("inspect", () => {
  test("lists only commits absent from origin", async () => {
    const git = branchWithUnsigned(2);
    const status = await inspect(repoFor(git), KEY);
    assert.equal(status.blockers.length, 0);
    assert.deepEqual(
      status.commits.map((c) => c.subject),
      ["local 0", "local 1"],
    );
    assert.equal(status.commits.every((c) => c.rewrite), true);
  });

  test("reports the tracked upstream for context", async () => {
    const git = branchWithUnsigned(1);
    assert.equal((await inspect(repoFor(git), KEY)).upstreamRef, "origin/feature");
  });

  test("falls back to origin's default branch when nothing is tracked", async () => {
    const git = branchWithUnsigned(1);
    git.upstream = null;
    // Both @{upstream} and refs/remotes/origin/HEAD are unavailable here, which is
    // reported as "none tracked" rather than treated as a blocker -- the candidate
    // set does not depend on it.
    assert.equal((await inspect(repoFor(git), KEY)).upstreamRef, null);
  });

  test("leaves an already-signed commit alone when its parents are untouched", async () => {
    const git = new FakeGit();
    const base = commit(git, { message: "published base" });
    git.published.add(base);
    const signed = commit(git, { parents: [base], message: "signed by someone else", signature: "theirs" });
    git.setHead(signed);

    const status = await inspect(repoFor(git), KEY);
    assert.deepEqual(status.commits.map((c) => ({ signed: c.signed, rewrite: c.rewrite })), [
      { signed: true, rewrite: false },
    ]);
  });

  test("re-signs a signed commit whose parent must be rewritten", async () => {
    // Rewriting the parent changes its SHA, so the child's object changes too and
    // its old signature can no longer be valid.
    const git = new FakeGit();
    const base = commit(git, { message: "published base" });
    git.published.add(base);
    const unsigned = commit(git, { parents: [base], message: "unsigned" });
    const signed = commit(git, { parents: [unsigned], message: "signed", signature: "theirs" });
    git.setHead(signed);

    const status = await inspect(repoFor(git), KEY);
    assert.deepEqual(status.commits.map((c) => ({ subject: c.subject, rewrite: c.rewrite })), [
      { subject: "unsigned", rewrite: true },
      { subject: "signed", rewrite: true },
    ]);
  });

  test("nothing to do when every unpublished commit is already signed", async () => {
    const git = new FakeGit();
    const base = commit(git, { message: "published base" });
    git.published.add(base);
    git.setHead(commit(git, { parents: [base], message: "already signed", signature: "mine" }));

    const status = await inspect(repoFor(git), KEY);
    assert.equal(status.commits.filter((c) => c.rewrite).length, 0);
    assert.equal(status.blockers.length, 0);
  });
});

describe("blockers", () => {
  test("detached HEAD", async () => {
    const git = branchWithUnsigned(1);
    git.branch = null;
    const status = await inspect(repoFor(git), KEY);
    assert.match(status.blockers.join("\n"), /detached/);
  });

  test("an operation in progress", async () => {
    const git = branchWithUnsigned(1);
    git.inProgress = "rebase-merge";
    const status = await inspect(repoFor(git), KEY);
    assert.match(status.blockers.join("\n"), /rebase-merge operation is in progress/);
  });

  test("no origin refs at all", async () => {
    const git = branchWithUnsigned(1);
    git.originRefs = [];
    const status = await inspect(repoFor(git), KEY);
    assert.match(status.blockers.join("\n"), /no refs\/remotes\/origin/);
    // Without a published baseline the candidate list is meaningless, so it is not
    // reported at all rather than shown as the whole history.
    assert.deepEqual(status.commits, []);
  });

  test("committer email is not a UID on the key", async () => {
    const git = branchWithUnsigned(1, { committerEmail: "someone-else@example.com" });
    const status = await inspect(repoFor(git), KEY);
    assert.match(status.blockers.join("\n"), /someone-else@example\.com is not a user ID/);
  });

  test("UID matching ignores case", async () => {
    const git = branchWithUnsigned(1, { committerEmail: "Ada@Example.COM" });
    assert.deepEqual((await inspect(repoFor(git), KEY)).blockers, []);
  });

  test("a mismatched committer on a commit that is not being rewritten does not block", async () => {
    const git = new FakeGit();
    const base = commit(git, { message: "published base" });
    git.published.add(base);
    const theirs = commit(git, { parents: [base], committerEmail: "them@example.com", signature: "theirs" });
    git.setHead(theirs);
    assert.deepEqual((await inspect(repoFor(git), KEY)).blockers, []);
  });

  test("sign_commits refuses while any blocker stands", async () => {
    const git = branchWithUnsigned(1);
    git.inProgress = "MERGE_HEAD";
    await assert.rejects(() => signCommits(repoFor(git), git.run, KEY, undefined), SigningError);
    assert.deepEqual(git.refUpdates, [], "nothing should have been written");
  });
});

describe("signCommits", () => {
  test("signs each commit and moves the branch", async () => {
    const git = branchWithUnsigned(2);
    const originalHead = git.head;
    const repo = repoFor(git);

    const outcome = await signCommits(repo, git.run, KEY, undefined);

    assert.equal(outcome.rewritten.length, 2);
    assert.equal(outcome.newHead, git.refs.get("refs/heads/feature"));
    assert.notEqual(outcome.newHead, originalHead);

    for (const { to } of outcome.rewritten) {
      assert.equal(isSigned(parseCommit(git.objects.get(to)!)), true);
    }
  });

  test("relinks each rewritten commit to its rewritten parent", async () => {
    const git = branchWithUnsigned(3);
    const outcome = await signCommits(repoFor(git), git.run, KEY, undefined);

    const [first, second, third] = outcome.rewritten;
    assert.deepEqual(parentShas(parseCommit(git.objects.get(second.to)!)), [first.to]);
    assert.deepEqual(parentShas(parseCommit(git.objects.get(third.to)!)), [second.to]);
  });

  test("keeps a published merge parent at its original SHA", async () => {
    const git = new FakeGit();
    const base = commit(git, { message: "published base" });
    const sideline = commit(git, { parents: [base], message: "published sideline" });
    git.published.add(base);
    git.published.add(sideline);
    const local = commit(git, { parents: [base], message: "local work" });
    const merge = commit(git, { parents: [local, sideline], message: "merge published sideline" });
    git.setHead(merge);

    const outcome = await signCommits(repoFor(git), git.run, KEY, undefined);
    const newMerge = outcome.rewritten.find((r) => r.from === merge)!;
    const parents = parentShas(parseCommit(git.objects.get(newMerge.to)!));

    assert.equal(parents.length, 2);
    assert.notEqual(parents[0], local, "the local first parent was rewritten");
    assert.equal(parents[1], sideline, "the published second parent kept its SHA");
  });

  test("preserves the tree and the author and committer lines verbatim", async () => {
    const git = branchWithUnsigned(1);
    const before = git.objects.get(git.head)!;
    const outcome = await signCommits(repoFor(git), git.run, KEY, undefined);

    const after = git.objects.get(outcome.rewritten[0].to)!;
    // Removing the signature we just added must give back the original bytes:
    // nothing else about the commit changed.
    assert.deepEqual(serializeCommit(stripSignature(parseCommit(after))), before);
  });

  test("signs the payload git will later reconstruct to verify", async () => {
    const git = branchWithUnsigned(1);
    const outcome = await signCommits(repoFor(git), git.run, KEY, undefined);

    const written = parseCommit(git.objects.get(outcome.rewritten[0].to)!);
    assert.equal(git.signedPayloads.length, 1);
    assert.deepEqual(git.signedPayloads[0], serializeCommit(stripSignature(written)));
  });

  test("saves the pre-signing head to a backup ref before moving the branch", async () => {
    const git = branchWithUnsigned(1);
    const originalHead = git.head;
    const outcome = await signCommits(repoFor(git), git.run, KEY, undefined);

    assert.equal(outcome.backupRef, "refs/swarmforge/git-signing/pre-sign/feature");
    assert.equal(git.refs.get(outcome.backupRef!), originalHead);
    assert.deepEqual(
      git.refUpdates.map((u) => u.ref),
      ["refs/swarmforge/git-signing/pre-sign/feature", "refs/heads/feature"],
      "the backup must be written before the branch moves",
    );
    // The branch move is a compare-and-swap against the head we inspected.
    assert.equal(git.refUpdates[1].expected, originalHead);
  });

  test("is a no-op when everything is already signed", async () => {
    const git = new FakeGit();
    const base = commit(git, { message: "published base" });
    git.published.add(base);
    git.setHead(commit(git, { parents: [base], message: "already signed", signature: "mine" }));

    const outcome = await signCommits(repoFor(git), git.run, KEY, undefined);
    assert.deepEqual(outcome.rewritten, []);
    assert.equal(outcome.backupRef, null);
    assert.deepEqual(git.refUpdates, []);
  });

  test("leaves the branch where it was when signing fails part-way", async () => {
    const git = branchWithUnsigned(2);
    const originalHead = git.head;
    git.gpgFails = true;

    await assert.rejects(() => signCommits(repoFor(git), git.run, KEY, undefined));
    assert.equal(git.refs.get("refs/heads/feature"), originalHead);
    assert.deepEqual(git.refUpdates, []);
  });
});
