# Swarmforge Tongs

Standalone [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tongs.

A **tong** is a sidecar container Swarmforge starts alongside the anvil, the
container the agent works in. It holds something the agent must not touch,
usually a credential, and exposes an MCP server the agent calls over the session
network.

The tong definition schema, discovery layers, secret providers, and approval gate
are documented [upstream][sf-tongs].

[sf-tongs]: https://github.com/CrypticSwarm/Swarmforge#tongs-sidecar-processes

## Tongs in this repo

| Tong | Status | Holds | Interface |
| --- | --- | --- | --- |
| [`git-signing`](git-signing/) | built | commit signing key; workspace `rw` | `mcp` |
| [`github`](github/) | built | GitHub token; workspace `rw` | `mcp` |

Each top-level directory is one self-contained tong with its own build, tests, and
`Dockerfile`.

## Building and testing

```sh
make list      # show discovered tongs
make build     # compile every tong
make test      # test every tong
make images    # docker build every tong image
make clean     # remove every tong's build output
```

Scope a target to one tong with `TONG=<dir-name>`, or run `build`, `test`, `image`,
or `clean` inside the tong's directory:

```sh
make test TONG=git-signing
cd git-signing && make test
```

## Enabling a tong

Tongs here are not auto-discovered. Build the image, then copy its definition into
a layer:

```sh
make image TONG=<tong-name>                                  # builds swarmforge-tong-<tong-name>:latest
cp <tong-name>/<tong-name>.tong.yaml ~/.swarmforge/tongs/<tong-name>.yaml
```

- If the tong needs secrets, first configure `~/.swarmforge/secret-providers.yaml`,
  then point the copy's `${secret:...}` references at your own vault. The committed
  ones are placeholders.
- A published tong can be pulled instead of built; its README's "Enabling it"
  section names the repository. Pin it by digest (`image: ...@sha256:...`), since
  an approval of `:latest` covers whatever it later points to.
- The user layer (`~/.swarmforge/tongs/`) skips the approval gate; a
  workspace-sourced copy prompts on first run.

Then start the anvil as usual.

## Contributing

[`AGENTS.md`](AGENTS.md) holds the repo conventions, how to add a tong, and the
security rules every tong follows.
