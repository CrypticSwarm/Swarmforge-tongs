# AGENTS.md

Complete working rules for this repo. Nothing here requires reading another file
first. Applies repo-wide unless a nested `AGENTS.md` in a tong directory
overrides it.

## What this repo is

Standalone tongs for [Swarmforge](https://github.com/CrypticSwarm/Swarmforge). A
**tong** is a Swarmforge-managed sidecar container started alongside the anvil
(the harness container the agent runs in), holding something the agent must not
touch, usually credentials, and exposing an MCP server the agent calls over
the session network.

Each top-level directory is one tong. The root holds only documentation and a
`Makefile` that recurses into tong directories.

## The one hard constraint

**Each top-level directory is a standalone tong.** Never couple the root to a
tong directory, or two tong directories to each other:

- No root `package.json`, `tsconfig.json`, lockfile, or shared `node_modules`.
- No `../` imports, no symlinks into a sibling, no `shared/` or `common/`
  directory.
- Duplicate scaffolding instead. The duplication is the point: a tong must
  survive `cp -r <tong>/ elsewhere/ && git init` unchanged.

This keeps monorepo-vs-multi-repo an open question — splitting later is a
`git mv`, not a refactor. If you are about to add a third kind of file at the
root, that is a design change to raise rather than do.

## Tong directory layout

```
<tong-name>/
  <tong-name>.tong.yaml   # Swarmforge tong definition — example, not installed
  Dockerfile
  Makefile                # build / test / image / clean — the contract with the root
  README.md
  .gitignore
  package.json            # or whatever the implementation language needs
  tsconfig.json
  src/
  test/
```

## Conventions

| Thing | Convention |
| --- | --- |
| Directory name | `kebab-case`, names the capability (`git-signing`, not `git-tong`) |
| Definition file | `<dir-name>.tong.yaml` |
| Image tag | `swarmforge-tong-<dir-name>:latest` |
| MCP `interface.name` | the capability, unprefixed (`github`) — it is a DNS alias on the session network |
| Default stack | TypeScript on Node, `@modelcontextprotocol/sdk` over HTTP, `node --test` |

The stack is a default, not a rule — a tong is an image with an MCP port, and
nothing downstream cares what is inside it. A tong in another language just has
to honor the `Makefile` contract.

## Never add a top-level `*.yaml`

Swarmforge tong discovery reads only **top-level** `*.yaml` in a layer's `tongs/`
directory. Definitions live one level down at `<tong-name>/<tong-name>.tong.yaml`
so that checking this repo out — even as `SWARMFORGE_REPO_TONGS_DIR` — does not
auto-install its tongs into every session. A `*.yaml` at the repo root would
break that. Enabling a tong is always an explicit copy into a layer.

The committed definition is an example. Its `${secret:...}` refs are
placeholders; say so in that tong's README so nobody copies a path expecting it
to resolve.

## Adding a tong

1. Create `<tong-name>/`, named for the capability.
2. Write `<tong-name>/<tong-name>.tong.yaml` (one level down — see above).
3. Add a `Makefile` exposing `build`, `test`, `image`, and `clean`. The root
   recurses into these by name. A target that does not apply is a no-op, not an
   error.
4. Add a `Dockerfile`, tagged `swarmforge-tong-<tong-name>:latest` by `image`.
5. Add a `README.md` covering: what the tong holds, the MCP verbs it exposes,
   every grant it requests and why, and the copy-into-a-layer command to enable
   it.
6. Add a row to the tong table in the root `README.md`.

## Tong definitions

`lifecycle`, `image`, and `interface` are required; unknown keys are tolerated.
Prefer `lifecycle: session` for anything credential-holding — a `shared` tong
survives across sessions and may not mount the workspace.

Do not restate the full upstream schema in this repo's docs; link to
<https://github.com/CrypticSwarm/Swarmforge#tongs-sidecar-processes> so there is
one source of truth for it.

## Secrets

- Credentials enter a tong only through `env:` `${secret:<provider>:<ref>}`
  references, which the host launcher resolves and streams in over a FIFO. In
  tong code that is a plain `process.env` read.
- Never commit a secret value, bake one into an image, pass one as a build arg,
  or write one to disk at runtime.
- A tong with secret `env:` needs `/bin/sh` in its image — the launcher wraps the
  entrypoint with a shell prologue that reads the secrets off the FIFO.

## Least privilege

- Request only the grants the tong's own capability needs. Do not merge two
  capabilities into one image to avoid creating a directory. The union grant
  defeats the first-run approval prompt that makes grants visible.
- `mounts:` takes only the magic words `workspace[:mode]` and
  `docker-socket[:mode]`; raw host paths are not expressible. Use the narrowest
  mode that works (`workspace:ro` unless writes are required).
- `docker-socket` is full host docker control. If a tong needs it, justify it
  explicitly in that tong's README.
- A tong that only calls a remote API declares no `mounts:` at all.

## Untrusted input

Anything the agent sends an MCP verb is untrusted. Spawn subprocesses without a
shell and pass values as whole argv words; never interpolate a caller value into
a command string, a path, or a flag. Prefer constrained parameter types
(enumerated values) over free-form strings wherever the surface allows it.

## Style

- Shell entrypoints start with `set -euo pipefail`.
- Fail closed. A malformed config or missing required secret stops startup with a
  clear message rather than degrading to a permissive default.

## Testing

```sh
make test                    # every tong
make test TONG=git-signing   # one tong
cd git-signing && make test  # equivalent; each tong's Makefile stands alone
```

`build`, `image`, and `clean` work the same way. Cover the security boundary
first: argv construction, parameter validation, config rejection. Keep `test`
runnable without docker and without a real credential — anything needing a live
container or vault goes behind a separate `test:e2e` target.

---

`README.md` is the human-facing overview of this repo. It states no rule that is
not already above, so there is no need to read it before working here.
