# git-signing

A [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tong that signs the
commits in your session workspace that have not been published to `origin`.

## What it holds

A GPG **private signing key**, delivered as a `${secret:...}` reference the host
launcher resolves before the container starts and streams in over a FIFO. The key
exists only in this container's process space and its tmpfs keyring. The agent
never sees it, and no verb accepts or returns key material.

## MCP verbs

Reached at `http://git-signing:8080/mcp` on the session network.

| Verb | Params | What it does |
| --- | --- | --- |
| `signing_status` | none | Reports the branch, its upstream, the key fingerprint and UIDs, every unpublished commit and whether it is already signed, and anything blocking signing. Read-only. |
| `sign_commits` | none | Signs every unpublished commit that needs it, moves the branch, and saves the previous head to a backup ref. No-op when everything is already signed. |

**Neither verb takes a parameter.** No ref, path, or key id crosses the boundary,
so there is nothing for a caller to inject — the tong derives all three itself.

## What gets signed

Everything reachable from `HEAD` but from **no** `refs/remotes/origin/*` ref —
`git rev-list --topo-order --reverse HEAD --not --remotes=origin`.

That is "not in the upstream repo", and it is deliberately stricter than
`origin/<branch>..HEAD`: a commit already published on some *other* origin branch
is excluded too. Signing rewrites commits, and rewriting something already pushed
would change history other people already have.

A commit already carrying a `gpgsig` header is left alone — including one signed
by somebody else — unless one of its parents had to be rewritten, in which case
its object changes anyway and the old signature could no longer be valid.

### Signing rewrites commits

Adding a signature changes the commit object, so its SHA changes, and so does
every descendant's. The tong:

- keeps each commit's tree byte-identical, so **no working-tree file is touched**
  and a dirty checkout is safe;
- preserves author and committer name, email, and timestamps exactly, along with
  headers `git commit-tree` would drop (`encoding`, `mergetag`);
- saves the pre-signing head to `refs/swarmforge/git-signing/pre-sign/<branch>`
  and moves the branch with a compare-and-swap against the head it inspected.

To undo, `git reset --soft <old-head>` — the response prints the command.

### It refuses to run when

- `HEAD` is detached (signing moves a branch ref).
- A rebase, merge, cherry-pick, revert, or bisect is in progress — the saved state
  references commits that are about to be rewritten.
- No `refs/remotes/origin/*` ref exists. Nothing is known to be published, so the
  entire history would count as unsigned work. Run `git fetch origin` first.
- A commit's **committer email is not a UID on the signing key**. A signature is a
  claim about who made the commit; the tong will not make that claim on behalf of
  an identity the key does not carry. Fix `user.email`, or use a matching key.
- The key is revoked, expired, disabled, has no signing-capable subkey, or the
  secret holds more or fewer than exactly one key.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `mounts: [workspace:rw]` | Signing writes new commit objects into `.git` and moves the branch ref. Both are writes; `ro` cannot work. Trees are never modified, so no file in the working tree changes. |
| `lifecycle: session` | It holds a credential and mounts the workspace. A `shared` tong outlives the session and cannot mount the workspace at all. |
| `env: GIT_SIGNING_KEY` | The signing key itself. |
| `env: GIT_SIGNING_KEY_PASSPHRASE` | Optional; only if your key is passphrase-protected. |

No `docker-socket`. No network egress.

## Enabling it

```sh
make image TONG=git-signing                                   # swarmforge-tong-git-signing:latest
cp git-signing/git-signing.tong.yaml ~/.swarmforge/tongs/git-signing.yaml
```

Then **edit the copy**. The `${secret:...}` references in the committed
definition are placeholders — `REPLACE-ME` is not a real vault path and will fail
to resolve until you change it. Point them at your own vault, using a provider
name you have declared in `~/.swarmforge/secret-providers.yaml`:

```yaml
env:
  GIT_SIGNING_KEY: ${secret:op:op://Private/git-signing/private-key}
  GIT_SIGNING_KEY_PASSPHRASE: ${secret:op:op://Private/git-signing/passphrase}
```

Delete the `GIT_SIGNING_KEY_PASSPHRASE` line entirely if your key has no
passphrase — an unresolvable reference stops the launch, and there is no
empty-value fallback.

Store the key as an ASCII-armored private export:

```sh
gpg --armor --export-secret-keys <fingerprint>
```

The user layer (`~/.swarmforge/tongs/`) is trusted and skips the approval gate. A
workspace-sourced copy prompts on first run. For anything you publish, pin the
image by digest rather than `:latest`.

## Where the key lives at runtime

GPG cannot sign without a keyring on a filesystem. `entrypoint.sh` creates
`GNUPGHOME` under `/dev/shm` — tmpfs, mode 0700, wiped when the container stops —
so the key is never written to a disk-backed layer. This is a deliberate
compromise, documented here rather than papered over; the key material itself
still only ever reaches `gpg` on stdin, and the passphrase only on fd 3, never on
argv (`/proc/<pid>/cmdline` is readable inside the container) and never in a file.

The entrypoint also drops to the uid that owns the mounted workspace before doing
any of this. Writing `.git` objects as root would leave them owned by root and
break the anvil's next git write.

## Building and testing

```sh
make build      # compile TypeScript
make test       # unit tests — no docker, no gpg, no key
make test-e2e   # end-to-end — needs git and gpg on PATH
make image      # docker build
make clean
```

`make test` covers the security boundary: commit-object byte fidelity, the
`gpgsig` header layout against git's own `do_sign_commit`, candidate selection,
every refusal above, and that the passphrase never reaches argv. It drives a fake
`git`/`gpg` through the single `Run` seam in `src/exec.ts`, so it needs no
binaries.

`make test-e2e` generates a throwaway key in a temp `GNUPGHOME`, builds a real
repository with a real `origin`, signs it, and checks the result with real
`git verify-commit`, `git fsck`, and a diff of every author/committer field.
