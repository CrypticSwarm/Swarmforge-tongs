# github

A [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tong that pushes
branches and opens pull requests for the repository checked out in your session
workspace.

## What it holds

A GitHub **token**, delivered as a `${secret:...}` reference the host launcher
resolves before the container starts and streams in over a FIFO. It exists only in
this container's process space. The agent never sees it, and no verb accepts or
returns it.

## MCP verbs

Reached at `http://github:8080/mcp` on the session network.

| Verb | Params | What it does |
| --- | --- | --- |
| `push_branch` | none | Pushes the branch you have checked out to its GitHub repository and moves the local `refs/remotes/origin/<branch>` to match. Never force-pushes. |
| `create_pr` | `title`, `body?`, `base?`, `draft?` | Pushes the branch as above, then opens a pull request from it. `base` defaults to the repository's default branch. |

`create_pr` pushes for you; there is no need to call `push_branch` first.

## It only ever touches the workspace's own repository

At startup the tong reads `remote.origin.url` from the mounted workspace, parses
it into `<owner>/<repo>`, and holds that for the life of the container. There is
no verb parameter and no configuration key for the repository.

Two things follow from that:

- **The pin is enforced, not just remembered.** Pushes go to a URL the tong builds
  from the pinned owner and repo, not to the remote named `origin`. The workspace
  belongs to the agent, so `git remote set-url origin` is always available to it —
  and after startup the tong never reads that remote again.
- **Your remote is only ever read.** SSH remotes are fine and stay untouched; the
  tong pushes over HTTPS with the token. It needs no SSH key, and your
  `origin` keeps whatever URL you gave it.

A remote pointing anywhere but `github.com` stops startup rather than aiming the
token at an unknown server.

## Push updates the remote-tracking ref, deliberately

Pushing to a URL rather than to a named remote means git does not update
`refs/remotes/origin/<branch>` itself, so the tong does it.

That matters because of the [`git-signing`](../git-signing/) tong: it decides what
it may rewrite by asking which commits are reachable from **no**
`refs/remotes/origin/*` ref. A stale tracking ref would let a later `sign_commits`
rewrite commits that are already on the server.

In the other direction the two compose without any special handling: `git-signing`
only rewrites commits that were never pushed, so the branch tip it moves was never
on `origin` and the follow-up push is a fast-forward. Sign, then push.

### It refuses to run when

- `HEAD` is detached — there is no branch to push.
- The push is not a fast-forward. There is no force verb, and no flag to add one.
  Rebase or rename the branch and push again.
- The workspace has no `origin`, or `origin` is not a GitHub repository.
- The token cannot see the repository. That is checked at startup, because a
  fine-grained token missing this repository and a repository that does not exist
  are the same 404 later on.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `mounts: [workspace:rw]` | The tong reads `origin` to learn which repository it serves, and writes `refs/remotes/origin/<branch>` after a push. No working-tree file is touched. |
| `lifecycle: session` | It holds a credential and mounts the workspace. A `shared` tong outlives the session and cannot mount the workspace at all. |
| `env: GITHUB_TOKEN` | The token itself. |

No `docker-socket`. The only hosts this tong contacts are `github.com` and
`api.github.com` — but that is its behavior, not a boundary it can impose on
itself; actually restricting egress to those hosts is the launcher's job.

## The token

Use a **fine-grained personal access token scoped to this one repository**, with:

- **Contents: read and write** — pushing
- **Pull requests: read and write** — opening the pull request

A classic `repo` token also works but is account-wide, which throws away the
containment the rest of this design is built on. An SSH deploy key is not an
alternative: it cannot open pull requests, and a user SSH key cannot be scoped to a
single repository at all.

Where it goes at runtime:

- To the GitHub API, as an `Authorization: Bearer` header.
- To `git push`, through `GIT_ASKPASS`, in the environment of that one child
  process. Never on a command line — `/proc/<pid>/cmdline` is readable by any
  process in the container, which rules out `http.extraheader` and a token in the
  URL.

## Hardening the workspace's git

The session workspace belongs to the agent, so without care its `.git/config`
would be an input to the one git process that holds the token. That is not a
theoretical concern: a `core.fsmonitor` or `core.gitProxy` entry runs a command as
a child of that process, and a `url.<x>.insteadOf` entry rewrites the push URL out
from under the pin — sending the token wherever the rewrite points.

**What contains that is the anvil's mount.** `.git/config` and `.git/hooks`, along
with `.git/branches`, `.git/remotes`, and `.git/commondir`, are mounted read-only
in the agent's container, so a hostile entry cannot be written in the first place.
The rest of `.git` stays writable, which is all the agent and this tong need.

Every git invocation here also overrides the dangerous keys on the command line —
`core.hooksPath`, `core.fsmonitor`, `core.gitProxy`, `credential.helper`,
`protocol.ext.allow`, `push.recurseSubmodules`, and `push.followTags` — and the
push passes `--no-verify`.

Treat that list as a second layer rather than as the boundary. It cannot be
exhaustive, and two gaps are structural rather than oversights: git resolves
`http.<url>.*` by longest URL match, so a workspace `http.https://github.com/.proxy`
outranks a generic `-c http.proxy=` no matter what this tong passes; and `-c` can
add config but never remove it, so an existing `url.<base>.insteadOf` entry —
which rewrites even a command-line push URL, aiming the askpass-supplied token at
whatever host the rewrite names — cannot be neutralized from the command line at
all. Containment lives in the mount.

## Enabling it

```sh
make image TONG=github                              # swarmforge-tong-github:latest
cp github/github.tong.yaml ~/.swarmforge/tongs/github.yaml
```

Then **edit the copy**. The `${secret:...}` reference in the committed definition
is a placeholder — `REPLACE-ME` is not a real vault path and will fail to resolve
until you change it:

```yaml
env:
  GITHUB_TOKEN: ${secret:op:op://Private/github-tong/token}
```

The user layer (`~/.swarmforge/tongs/`) is trusted and skips the approval gate. A
workspace-sourced copy prompts on first run. For anything you publish, pin the
image by digest rather than `:latest`.

## Stacked pull requests

Out of scope for now, but reachable: a stack is pull requests whose bases point at
each other, so `create_pr`'s `base` builds one today without GitHub's stack object.
Adding GitHub's own stacks later needs no new grant — the REST stack endpoints are
ordinary API calls, and the local half of `gh stack` would work against the
workspace this tong already mounts.

## Building and testing

```sh
make build      # compile TypeScript
make test       # unit tests — no docker, no token, no network
make image      # docker build
make clean
```

`make test` covers the security boundary: origin parsing and everything it
rejects, that the token never reaches argv and reaches git's environment only for
the push, the exact push argv including the absence of any force flag and that
the refspec pins the sha the tong read rather than a branch name a concurrent
commit could move, the config hardening, the remote-tracking ref update, and that
a rejected push opens no pull request. It drives a fake `git` through the single
`Run` seam in `src/exec.ts` and a fake `fetch` through `src/github.ts`, so it
needs no git and no credential; the only real subprocesses spawned are the test
runner's own `node`, exercising `realRun`'s exit, signal, and truncation paths.
