# git-signing

A [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tong that signs the
commits in your session workspace that have not been published to `origin`.

## What it holds

A GPG **private signing key**, from a `${secret:...}` reference. The agent never
sees it, and no verb accepts or returns key material.

## MCP verbs

Reached at `http://git-signing:8080/mcp` on the session network. Serves MCP
revision 2026-07-28, and falls back to stateless 2025-era serving for clients that
open with `initialize`.

| Verb | Params | What it does |
| --- | --- | --- |
| `signing_status` | none | Reports the branch, its upstream, the key fingerprint and UIDs, every unpublished commit and whether it is signed, and anything blocking signing. Read-only. |
| `sign_commits` | none | Signs every unpublished commit that needs it, moves the branch, and saves the previous head to a backup ref. No-op when everything is signed. |

A parameter sent anyway is refused.

## What gets signed

Every commit reachable from `HEAD` but not from any `refs/remotes/origin/*` ref:

```sh
git rev-list --topo-order --reverse HEAD --not --remotes=origin
```

- A commit on any `origin` branch, not just this branch's upstream, counts as
  published and is left alone.
- A commit that already has a `gpgsig` header is left alone, even one signed by
  someone else. If one of its parents was rewritten, it is re-signed.

### Signing rewrites commits

Each signed commit, and every descendant, gets a new SHA. The tong:

- keeps each tree byte-identical, so no working-tree file changes and a dirty
  checkout is safe;
- keeps author and committer names, emails, and timestamps exactly, and every
  other header (such as `encoding` and `mergetag`) except the old signature;
- saves the old head to `refs/swarmforge/git-signing/pre-sign/<branch>` and moves
  the branch only if it still points at the head it inspected.

To undo, run `git reset --soft <old-head>`. The response prints the command.

### `sign_commits` refuses when

`signing_status` lists each of these:

- `HEAD` is detached.
- A rebase, merge, cherry-pick, revert, or bisect is in progress.
- No `refs/remotes/origin/*` ref exists. Run `git fetch origin` first.
- A commit's committer email is not a UID on the signing key. Fix `user.email`, or
  use a matching key.

### The tong fails to start when

The reason is in the container log.

- `GIT_SIGNING_KEY` is unset, or does not hold exactly one key.
- The key is revoked, expired, disabled, or cannot sign.
- The workspace is not mounted, or is not a git repository.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `mounts: [workspace:rw]` | Signing writes commit objects into `.git` and moves the branch ref. Working-tree files never change. |
| `lifecycle: session` | It holds a credential and mounts the workspace. A `shared` tong outlives the session and cannot mount the workspace. |
| `env: GIT_SIGNING_KEY` | The signing key. |
| `env: GIT_SIGNING_KEY_PASSPHRASE` | Optional; only for a passphrase-protected key. |

No `docker-socket`. No network egress.

## Enabling it

```sh
make image TONG=git-signing                                   # swarmforge-tong-git-signing:latest
cp git-signing/git-signing.tong.yaml ~/.swarmforge/tongs/git-signing.yaml
```

Then **edit the copy**. Its `${secret:...}` references are placeholders:
`REPLACE-ME` will not resolve. Point them at your own vault, using a provider from
`~/.swarmforge/secret-providers.yaml`:

```yaml
env:
  GIT_SIGNING_KEY: ${secret:op:op://Private/git-signing/private-key}
  GIT_SIGNING_KEY_PASSPHRASE: ${secret:op:op://Private/git-signing/passphrase}
```

Delete the `GIT_SIGNING_KEY_PASSPHRASE` line if your key has no passphrase. An
unresolvable reference stops the launch.

Store the key as an ASCII-armored private export:

```sh
gpg --armor --export-secret-keys <fingerprint>
```

The user layer (`~/.swarmforge/tongs/`) skips the approval gate; a
workspace-sourced copy prompts on first run. Pin `image:` by digest in any
definition you share.

To pull instead of build, use
[`crypticswarm/git-signing-tong`](https://hub.docker.com/r/crypticswarm/git-signing-tong)
(`linux/amd64`, `linux/arm64`). Look up its digest, pull it, and set the copy's
`image:` to it:

```sh
docker buildx imagetools inspect crypticswarm/git-signing-tong:latest --format '{{.Manifest.Digest}}'
docker pull crypticswarm/git-signing-tong@sha256:<digest>
```

```yaml
image: crypticswarm/git-signing-tong@sha256:<digest>
```

## Where the key lives at runtime

- `GNUPGHOME` is a mode-0700 directory under `/dev/shm` (tmpfs), wiped when the
  container stops. The key is never written to disk.
- Neither the key nor the passphrase goes on argv. The passphrase is never written
  to a file.
- The entrypoint drops to the uid that owns the workspace, so new `.git` objects
  are not owned by root.

## Building and testing

```sh
make build      # compile TypeScript
make test       # unit tests — no docker, no gpg, no key
make test-e2e   # end-to-end — needs git and gpg on PATH
make image      # docker build
make clean
```

- `make test` drives a fake `git` and `gpg`, and runs the HTTP app in-process
  against the SDK client.
- `make test-e2e` signs a real repository with a throwaway key and checks it with
  `git verify-commit` and `git fsck`.
