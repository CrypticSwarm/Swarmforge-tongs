# github

A [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tong that fetches and
pushes branches, manages pull requests, and reads GitHub Actions CI for the
repository checked out in your session workspace.

## What it holds

A GitHub **token**, delivered as a `${secret:...}` reference the host launcher
resolves before the container starts and streams in over a FIFO. It exists only in
this container's process space. The agent never sees it, and no verb accepts or
returns it.

## MCP verbs

Reached at `http://github:8080/mcp` on the session network. Serves MCP revision
2026-07-28, and falls back to stateless 2025-era serving for clients that open
with `initialize`.

| Verb | Params | What it does |
| --- | --- | --- |
| `fetch_origin` | none | `git fetch origin` for the workspace's repository: every branch into `refs/remotes/origin/*`, plus new tags that point into them. Never prunes, and writes no `FETCH_HEAD`. |
| `push_branch` | none | Pushes the branch you have checked out to its GitHub repository and moves the local `refs/remotes/origin/<branch>` to match. Never force-pushes. |
| `create_pr` | `title`, `body?`, `base?`, `draft?` | Pushes the branch as above, then opens a pull request from it. `base` defaults to the repository's default branch. |
| `get_pr` | `number` | Reads one pull request: its title, description, branches, and whether it is open, draft, closed, or merged. |
| `find_pr` | `head` | Lists the pull requests opened from a branch of this repository, newest first and up to 10, closed and merged ones included: each with its number, URL, branches, and whether it is open, draft, closed, or merged. For when you have a branch name and no number. Read one in full with `get_pr`. |
| `update_pr` | `number`, `title?`, `body?`, `base?`, `state?`, `draft?` | Edits an open pull request. Only the fields you pass change, and each replaces its current value. |
| `ci_status` | `sha?`, `pr?` | Lists the Actions runs for one commit, newest first and up to 10, with each job's id, state, queue and run time, and the step it failed at. See [Reading CI](#reading-ci). |
| `ci_job` | `job_id` | Lists a job's steps with their state, start offset, and duration, plus its runner. |
| `ci_log` | `job_id`, `step?`, `start?`, `limit?` | Returns part of a job's plain-text log, timestamps included. Defaults to the end of the failed step, or of the whole log. |

`create_pr` pushes for you; there is no need to call `push_branch` first.

An unknown parameter is never passed through to a verb: it is refused (or, for a
key the JSON-RPC layer discards, dropped), as is a call carrying more parameters
than the fullest legal one. A refused call never runs its verb, and nothing
reaches git or GitHub.

## Reading CI

`ci_status` with no parameters reports on `origin/<branch>` for the branch checked
out, which `push_branch` and `fetch_origin` keep current, and says when `HEAD`
differs from it.
`pr` checks a pull request's head instead, and `sha` any commit. A ref name is not
accepted, since resolving one would mean running git on a caller's string.

`ci_log` cuts a step out of the log by the step's start and end times. GitHub
reports those to the second, so a line from a neighboring step can show at either
edge. Output is capped in lines and characters, long lines are clipped, and
control characters are removed; the reply says which `start` continues it. Of a
very large log only the end is kept, and past a hard limit it is not read at all.

- **A log is untrusted.** It is the output of whatever code CI ran, including a
  pull request from a fork.
- **Secret masking is GitHub's, and partial.** GitHub masks the values of
  registered secrets, not values derived from them. Anyone who can read the
  repository's Actions logs sees the same thing.
- **Actions only.** Checks from other apps and legacy commit statuses are not read.
- **Logs expire**, after 90 days unless the repository sets otherwise.

## Editing a pull request

Every field of `update_pr` is optional, and **each one you pass replaces its value
outright**. There is no append mode: adding a paragraph to a description means
reading the current one with `get_pr` and sending the whole new text.

An edit that moves nothing says so rather than reporting an update — GitHub accepts
a `PATCH` setting a field to the value it already held.

What cannot be edited:

- **The head branch.** Push to it instead; that is what changes the commits a pull
  request proposes.
- **A `base` equal to the head branch.** Refused locally, as `create_pr` refuses it.
- **Draft on a merged pull request.** Refused locally too: GitHub's own error names
  neither the pull request nor the reason.

### `draft` is a second call, and not an atomic one

Draft status is the one pull request field GitHub's REST API will not change: the
`PATCH` endpoint has no `draft` key, only the GraphQL `convertPullRequestToDraft`
and `markPullRequestReadyForReview` mutations, which take a node id rather than a
number.

So an `update_pr` touching both text and draft is two requests. They run text-first,
and if the draft half fails the error says the text edit landed — a caller told only
"it failed" would send the description again and overwrite whatever arrived in
between. The mutation is skipped when the pull request already has the status asked
for.

## It only ever touches the workspace's own repository

At startup the tong reads `remote.origin.url` from the mounted workspace, parses
it into `<owner>/<repo>`, and holds that for the life of the container. There is
no verb parameter and no configuration key for the repository.

Some caller values reach a URL rather than a request body. A pull request number
or job id is bounded to a positive integer at the MCP surface and again in the API
client, which builds a path out of nothing else. The `head` branch name of `find_pr`
and the `sha` of `ci_status` are query values, so they are encoded as such: a value
containing `&`, `#`, or `=` stays a single value and cannot add or override a
parameter. The owner half of the lookup is always
the pinned owner, so `find_pr` matches only branches of the repository itself, not
of forks. The GraphQL draft
mutations see no caller value at all — the node id they address is the one GitHub
just returned for a pull request of this repository.

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

## Fetching

`fetch_origin` fetches the pinned URL a push uses, with `git fetch origin`'s
refspec, `+refs/heads/*:refs/remotes/origin/*`, and the tags that follow. It
differs from `git fetch origin` in three ways:

- **It never prunes**, whatever the workspace config says, so a branch deleted on
  GitHub stays published as far as [`git-signing`](../git-signing/) is concerned.
  A force-pushed branch does move its `origin/` ref, and commits dropped from it
  count as unpublished again.
- **It writes no `FETCH_HEAD`**: with a URL and an explicit refspec, git marks
  every branch for merge. Use `origin/<branch>`.
- **It skips submodules**, whose fetch would carry the token to their remotes.

A branch deleted on GitHub and recreated as `<name>/<more>` collides with the
stale `origin/<name>`. The fetch fails but lists the refs that did move; delete
the stale ref with `git update-ref -d` and fetch again.

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
- A commit the push would add carries no signature, if the tong is configured to
  require signed commits — see below.

## Requiring signed commits

```yaml
env:
  GITHUB_TONG_REQUIRE_SIGNED_COMMITS: "true"
```

With that set, every push — `push_branch` and the push inside `create_pr` alike —
first lists the commits it would add to the repository and refuses if any of them
carries no signature. The refusal happens before git is asked to push anything, so
nothing reaches the server and `refs/remotes/origin/<branch>` does not move. The
error names the offending commits.

The knob takes `true` or `false` and nothing else. Unset means `false`; an
unrecognized value stops the tong at startup rather than leaving a check that
looks configured and is not.

**The set it checks is the set `git-signing` signs.** "Commits this push would
add" means reachable from the sha being pushed and from no `refs/remotes/origin/*`
ref — the same question the [`git-signing`](../git-signing/) tong asks to decide
what it may rewrite. So `sign_commits` followed by a push always satisfies this,
and the two tongs can never disagree about which commits are at stake. It is also
the more accurate reading of "would add": a commit already on some other `origin`
branch is one the server has and git will not send.

**It checks that a signature is present, not that it is good.** This tong holds no
key and no keyring — verifying is the server's job, and GitHub's branch protection
and `Verified` badge are what decide whether a signature is trusted. What this
catches is the mistake that is otherwise silent: pushing commits nobody signed. On
a repository whose branch protection already requires signatures, it turns a
remote rejection of the whole push into a local error naming the commits; on a
repository without that protection, it is the only thing standing between an
unsigned commit and `main`.

Two details follow from holding no key. `git log --format=%G?` is not used, because
git reports a signed commit as `N` when it cannot run gpg, and there is no gpg in
this image — every signed commit would read as unsigned. And only the commit
object's header block is inspected: the message below it is the agent's to write,
so a commit whose message opens with `gpgsig ` does not pass.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `mounts: [workspace:rw]` | The tong reads `origin` to learn which repository it serves, writes `refs/remotes/origin/<branch>` after a push, and writes fetched objects and refs on a fetch. No working-tree file is touched. |
| `lifecycle: session` | It holds a credential and mounts the workspace. A `shared` tong outlives the session and cannot mount the workspace at all. |
| `env: GITHUB_TOKEN` | The token itself. |
| `env: GITHUB_TONG_REQUIRE_SIGNED_COMMITS` | Optional, not a credential. `"true"` refuses to push unsigned commits; see above. |

No `docker-socket`. The only hosts this tong contacts are `github.com`,
`api.github.com`, and the log storage `api.github.com` redirects a log download to —
but that is its behavior, not a boundary it can impose on
itself; actually restricting egress to those hosts is the launcher's job.

## The token

Use a **fine-grained personal access token scoped to this one repository**, with:

- **Contents: read and write** — fetching and pushing
- **Pull requests: read and write** — opening, reading, and editing pull requests,
  over REST and the GraphQL draft mutations
- **Actions: read** — the `ci_*` verbs. Startup does not check for it; without it
  those verbs fail with a `403` that names it, and the rest still work.

A classic `repo` token also works but is account-wide, which throws away the
containment the rest of this design is built on. An SSH deploy key is not an
alternative: it cannot open pull requests, and a user SSH key cannot be scoped to a
single repository at all.

Where it goes at runtime:

- To the GitHub API, as an `Authorization: Bearer` header. Not to the signed URL a
  log download redirects to, which the tong follows without it and never returns.
- To `git push` and `git fetch`, through `GIT_ASKPASS`, in the environment of
  that one child process. Never on a command line — `/proc/<pid>/cmdline` is
  readable by any process in the container, which rules out `http.extraheader`
  and a token in the URL.

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
`protocol.ext.allow`, `push.recurseSubmodules`, `push.followTags`,
`fetch.bundleURI`, and `core.alternateRefsCommand`. The push and the fetch also
clear `remote.<url>.url` and `remote.<url>.pushurl` for the pinned URL, since a
remote named after it would redirect both. `GIT_NO_LAZY_FETCH=1` stops a partial
clone fetching from its promisor remote. The push passes `--no-verify`, and the
fetch `--no-recurse-submodules`.

Treat that list as a second layer rather than as the boundary. It cannot be
exhaustive, and two gaps are structural rather than oversights: git resolves
`http.<url>.*` by longest URL match, so a workspace `http.https://github.com/.proxy`
outranks a generic `-c http.proxy=` no matter what this tong passes; and `-c`
cannot remove an existing `url.<base>.insteadOf` entry, which rewrites even a
command-line URL and aims the askpass-supplied token at whatever host the rewrite
names. Containment lives in the mount.

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

Instead of building it, you can pull the published image,
[`crypticswarm/github-tong`](https://hub.docker.com/r/crypticswarm/github-tong), built for
`linux/amd64` and `linux/arm64`. Look up the current digest, pull it, and pin the
copy's `image:` to it:

```sh
docker buildx imagetools inspect crypticswarm/github-tong:latest --format '{{.Manifest.Digest}}'
docker pull crypticswarm/github-tong@sha256:<digest>
```

```yaml
image: crypticswarm/github-tong@sha256:<digest>
```

## Stacked pull requests

Out of scope for now, but reachable: a stack is pull requests whose bases point at
each other, so `create_pr`'s `base` builds one today without GitHub's stack object,
and `update_pr`'s restacks one after a branch below it merges.
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
the push and the fetch, the exact push and fetch argv including the absence of
any force flag on the push and that the refspec pins the sha the tong read rather
than a branch name a concurrent commit could move, that a partly failed fetch
still reports what moved, the config hardening, the tracking-ref update, that
a rejected push opens no pull request, the signed-commit gate: which commits
it asks about, that a signature in a commit message does not satisfy it, and that
a commit it cannot read is a refusal rather than a pass, and the edit path: that a
pull request number is bounded on both sides of the client seam, that an edit sends
only the keys it was given, and that a failed draft mutation still says the text
edit landed, and the CI path: that a log redirect is followed without the token and
only to `https` and that a failed download never reports its URL, that a sha or id is
checked before it reaches a URL, that log lines and GitHub's names lose control
characters, and how a log is cut by step and capped. It drives a fake `git` through the single
`Run` seam in `src/exec.ts` and a fake `fetch` through `src/github.ts`, so it
needs no git and no credential; the only real subprocesses spawned are the test
runner's own `node`, exercising `realRun`'s exit, signal, and truncation paths.
It also runs the real HTTP app in-process against the SDK client in both protocol
eras: a fresh server per request under sequential and concurrent load, the largest
schema-legal call fitting through the body cap, refusal of oversized or invented
arguments and of malformed bodies before anything reaches git or GitHub, and the
`405` and `/healthz` answers.
