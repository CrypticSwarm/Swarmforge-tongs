# Swarmforge Tongs

Standalone [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tongs.

A **tong** is a Swarmforge-managed sidecar container started alongside the anvil,
the harness container the coding agent works in. The name captures the primary
use case: holding something hot, usually credentials, so the agent never touches
it directly. A credential-holding tong runs as a sibling container exposing an
MCP server the agent calls over the session network; the secret material lives
only in the tong's process space, and the host launcher resolves it from your
vault before the container starts.

The [upstream README][sf-tongs] documents the tong definition schema, the four
discovery layers, secret providers, and the first-run approval gate. This repo
builds tongs against that contract rather than restating it.

[sf-tongs]: https://github.com/CrypticSwarm/Swarmforge#tongs-sidecar-processes

## Tongs in this repo

| Tong | Status | Holds | Interface |
| --- | --- | --- | --- |
| [`git-signing`](git-signing/) | built | commit signing key; workspace `rw` | `mcp` |
| [`github`](github/) | built | GitHub token; workspace `rw` | `mcp` |

Git and GitHub are deliberately **separate** tongs, separated by the credential
each one holds rather than by what it mounts. Both want the workspace: signing
rewrites commit objects, and pushing needs the objects plus a remote-tracking ref
update. What differs is the secret. A combined tong would be the union of both,
forcing any project that merely wants to open a pull request to also hold a GPG
signing key, and any project that wants signed commits to also hold a token that
can write to its GitHub repository — exactly the privilege bundling the approval
prompt exists to make visible.

## Why one directory per tong

Every top-level directory is a self-contained tong: its own build, its own
tests, its own `Dockerfile`, no shared root tooling and no cross-directory
imports. Copying a directory out and running `git init` on it produces a working
repo.

This repo is a monorepo for convenience, not for coupling. If a tong later wants
its own release cadence, issue tracker, or access control, it gets lifted out
into its own repo without edits. Duplicating a little scaffolding across
directories is the intended cost of keeping that option open.

## Building and testing

```sh
make list      # show discovered tongs
make build     # compile every tong
make test      # test every tong
make images    # docker build every tong image
make clean     # remove every tong's build output
```

Scope any target to one tong with `TONG=<dir-name>`:

```sh
make test TONG=git-signing
```

Or work inside a tong directory directly — each one's `Makefile` stands alone:

```sh
cd git-signing && make test
```

The root `Makefile` discovers tongs by globbing `*/*.tong.yaml` and delegates to
each directory's own `Makefile`, so it never learns any tong's build system.

## Enabling a tong

Tongs here are not auto-discovered — Swarmforge reads only top-level `*.yaml` in
a layer's `tongs/` directory, and these definitions live a level down. Checking
out this repo therefore hands nothing to your sessions until you opt in:

```sh
make image TONG=<tong-name>                                  # builds swarmforge-tong-<name>:latest
cp <tong-name>/<tong-name>.tong.yaml ~/.swarmforge/tongs/<tong-name>.yaml
```

Then start the anvil as usual. The user layer (`~/.swarmforge/tongs/`) is trusted
and skips the approval gate; a workspace-sourced copy prompts on first run.

If the tong needs secrets, configure `~/.swarmforge/secret-providers.yaml` first
and edit the copied definition's `${secret:...}` references to point at your own
vault paths — the committed ones are placeholders.

For anything you publish, prefer a pinned digest (`image: ...@sha256:...`) over a
floating `:latest` tag. Approving a moving target approves whatever it moves to.

## Contributing

`AGENTS.md` is the contributor contract — repo conventions, how to add a tong,
and the security rules every tong is expected to follow. It is written for
coding agents but is the authoritative reference for humans too.
