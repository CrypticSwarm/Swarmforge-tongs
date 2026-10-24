# github

A [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tong that fetches and
pushes branches, manages pull requests, reads GitHub Actions CI, and dispatches
allowlisted workflows for the repository checked out in your session workspace.

## What it holds

A GitHub **token**, from a `${secret:...}` reference. The agent never sees it, and
no verb accepts or returns it.

## MCP verbs

Reached at `http://github:8080/mcp` on the session network. Serves MCP 2026-07-28;
2025-era clients that open with `initialize` also work.

| Verb | Params | What it does |
| --- | --- | --- |
| `fetch_origin` | none | `git fetch origin`: every branch into `refs/remotes/origin/*`, plus new tags that point into them. See [Fetching](#fetching). |
| `push_branch` | none | Pushes the checked-out branch and moves `refs/remotes/origin/<branch>` to match. Never force-pushes. |
| `create_pr` | `title`, `body?`, `base?`, `draft?` | Pushes the branch, then opens a pull request from it. `base` defaults to the default branch. |
| `get_pr` | `number` | Reads one pull request: title, description, branches, state, and when it was opened, closed, and merged. |
| `find_pr` | `head` | Lists up to 10 pull requests opened from a branch of this repository, newest first, closed and merged ones included. |
| `update_pr` | `number`, `title?`, `body?`, `base?`, `state?`, `draft?` | Edits a pull request; `state: open` reopens one. See [Editing a pull request](#editing-a-pull-request). |
| `merge_pr` | `number`, `method?` | Merges an open pull request with `merge` (default), `squash`, or `rebase`. See [Merging](#merging). |
| `ci_status` | `sha?`, `pr?`, `run?` | Lists up to 10 Actions runs for a commit, newest first, or one run by id, with each job's state and failed step. See [Reading CI](#reading-ci). |
| `ci_job` | `job_id` | Lists a job's steps with state, start offset, and duration, plus its runner. |
| `ci_log` | `job_id`, `step?`, `start?`, `limit?` | Returns part of a job's log. Defaults to the end of the failed step, or of the whole log. |
| an allowlisted verb | `inputs?` | Dispatches one workflow and returns the run id. See [Dispatching workflows](#dispatching-workflows). |
| `list_workflows` | none | Lists each dispatch verb's workflow, branch, and inputs, why a dispatch would be refused now, and any verb dropped at startup. Only with `GITHUB_TONG_DISPATCH: "true"`. |

- An unknown parameter is refused, or dropped if the JSON-RPC layer discards it.
  Either way it never reaches git or GitHub.
- The tong only acts on the repository named by the workspace's `origin`. See
  [The repository](#the-repository).

## Reading CI

- `ci_status` with no parameters reports on `origin/<branch>` for the checked-out
  branch, and says when `HEAD` differs from it.
- `pr` checks a pull request's head, `sha` any commit, and `run` one run. Ref names
  are not accepted.
- It also reports skipped jobs in a successful run, skipped steps in a successful
  job, runs cancelled before any step started, and what usually holds a `waiting`
  or `pending` run.
- A step's `ci_log` can include a line from a neighboring step at either edge.
- Log output is capped and stripped of control characters; the reply says which
  `start` continues it. Only the end of a very large log is kept, and one over
  256 MiB is not read.

Caveats:

- **A log is untrusted.** It is the output of whatever code CI ran, including a
  pull request from a fork.
- **Secret masking is GitHub's, and partial.** Values derived from a secret are not
  masked.
- **Actions only.** Checks from other apps and legacy commit statuses are not read.
- **Logs expire**, after 90 days by default.

## Editing a pull request

- Each field you pass to `update_pr` **replaces its value outright**. To add to a
  description, read it with `get_pr` and send the whole new text.
- An edit that changes nothing says so.
- The head branch cannot be changed. Push to it instead.
- A `base` equal to the head branch is refused, as in `create_pr`.
- Draft status cannot be changed on a merged pull request.
- If the `draft` change fails, the text edit has still landed; the error says so.

## Merging

`merge_pr` merges only what `gh pr merge` would merge without `--admin`
(`mergeStateStatus` `CLEAN`, `HAS_HOOKS`, or `UNSTABLE`). It also refuses:

- a draft;
- a base with a merge queue;
- a head that moved since the check.

The repository's settings decide the allowed methods, the commit messages, and
whether the head branch is deleted. A `rebase` merge re-creates the commits
unsigned.

**Not airtight.** A token whose account can bypass branch rules still bypasses a
rule or base changed between the check and the merge, or a rule GitHub does not
report as `BLOCKED`. `push_branch` can also push a protected branch. For a hard guarantee,
use a token whose account cannot bypass.

## Dispatching workflows

Off unless the tong definition sets `GITHUB_TONG_DISPATCH: "true"`. The verbs then
come from `.github/swarmforge-dispatch.yml` on the default branch, one per entry:

```yaml
deploy_production: { workflow: deploy-production.yml, ref: default }
deploy_staging: { workflow: deploy-staging.yml, ref: current }
```

- `workflow` is a file name in `.github/workflows/`.
- `ref: default` runs on the default branch.
- `ref: current` runs on the checked-out branch, using that branch's copy of the
  workflow file, which the agent can edit. GitHub must have the branch at `HEAD`,
  and it must not be the default branch.
- A verb name is up to 64 lowercase letters, digits, and `_`, starting with a
  letter.
- An approval covers a verb's name, not what the allowlist binds it to, so approve
  verbs per project, not globally.

Each call:

- reads the allowlist again, so a removed or changed verb is refused at once (an
  added one appears next session);
- reads the workflow file at the branch's tip on GitHub and checks `inputs`
  against its `workflow_dispatch` inputs;
- refuses an unknown input, an unset required input with no default (`required`
  in `list_workflows`), and an unset `boolean` with no default, which GitHub
  refuses (`must pass`);
- takes JSON booleans and numbers for `boolean` and `number` inputs, and one of the
  options for `choice`;
- never sets an `environment` input;
- returns the run id. Follow it with `ci_status run=<id>`.

A dispatch that gets a 5xx or no answer may have started anyway; the error says so.

At startup:

- A verb is dropped if its entry is malformed, or its workflow is missing, has no
  `workflow_dispatch`, or requires an `environment` input.
- Every verb is dropped if the allowlist is unreadable, not valid YAML 1.2, over
  16 KiB, not a map, or over 20 verbs.
- The tong still starts; `list_workflows` and the server instructions name each
  drop.

### Securing dispatch

- **The allowlist is only as trusted as the default branch.** Protect it, require
  code-owner review with a code owner on `.github/`, and use a token whose account
  cannot bypass branch rules.
- **The allowlist guards against mistakes, not misuse.** The agent can already run
  its own code with the repository's secrets: a push starts its branch's `push` and
  `pull_request` workflows, and a `current` verb runs its copy of the workflow.
  Protect production outside the tong with both:
  - the `production` environment deploying only from the default branch;
  - the cloud role's OIDC trust requiring `sub` to be exactly
    `repo:<owner>/<repo>:environment:production`.

  Without both, the agent can deploy to production from a branch it pushed. A
  client prompt on a `current` verb is a prompt, not a gate.
- **Not airtight.** GitHub dispatches a branch, not a commit, so a push from
  outside the tong between the check and the dispatch runs an unchecked file.
  `ci_status run=<id>` reports the commit that ran.
- **Dispatches run as the token's owner.** With "Prevent self-review" on an
  environment, that account cannot approve the agent's deploys.

## The repository

- At startup the tong reads `remote.origin.url` from the workspace and pins
  `<owner>/<repo>` for the life of the container. No verb or config key names a
  repository.
- Pushes and fetches go to a URL built from the pin, so changing `origin` later
  has no effect. Your remote is never written; SSH remotes are fine.
- An `origin` that is not on `github.com` stops startup.
- A workspace with no `origin`, or no git repository, gets a tong with no verbs.
  Adding a remote later needs a new session.

## Fetching

`fetch_origin` fetches `+refs/heads/*:refs/remotes/origin/*` and the tags that
follow. Unlike `git fetch origin`, it:

- **never prunes**, so a branch deleted on GitHub still counts as published to
  [`git-signing`](../git-signing/). A force-pushed branch does move its `origin/`
  ref, so commits dropped from it count as unpublished again;
- **writes no `FETCH_HEAD`**. Use `origin/<branch>`;
- **skips submodules**, whose fetch would send the token to their remotes.

A branch deleted on GitHub and recreated as `<name>/<more>` collides with the stale
`origin/<name>`. The fetch fails, but lists the refs that did move; delete the stale
ref with `git update-ref -d` and fetch again.

## Pushing

A push also updates `origin/<branch>`, so [`git-signing`](../git-signing/) never
rewrites a pushed commit. Sign, then push.

It refuses when:

- `HEAD` is detached.
- The push is not a fast-forward. There is no force option; rebase or rename the
  branch and push again.
- A commit the push would add is unsigned, with
  [signed commits required](#requiring-signed-commits).

## Requiring signed commits

```yaml
env:
  GITHUB_TONG_REQUIRE_SIGNED_COMMITS: "true"
```

- Every push, including the one in `create_pr`, refuses if a commit it would add has
  no signature. Nothing is pushed, and the error names the commits.
- It checks exactly the commits `sign_commits` signs, so signing then pushing
  always passes.
- It checks that a signature is present, not that it is valid. GitHub's branch
  protection decides that.
- Like `GITHUB_TONG_DISPATCH`, it takes `true` or `false`. Unset means `false`;
  any other value stops startup.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `mounts: [workspace:rw]` | Reads `origin` to learn the repository, writes `refs/remotes/origin/<branch>` after a push, and writes fetched objects and refs. No working-tree file changes. |
| `lifecycle: session` | It holds a credential and mounts the workspace. A `shared` tong outlives the session and cannot mount the workspace. |
| `env: GITHUB_TOKEN` | The token. |
| `env: GITHUB_TONG_REQUIRE_SIGNED_COMMITS` | Optional, not a credential. `"true"` refuses to push unsigned commits. |
| `env: GITHUB_TONG_DISPATCH` | Optional, not a credential. `"true"` serves the repository's dispatch verbs. |

No `docker-socket`. The tong contacts only `github.com`, `api.github.com`, and the
log storage a log download redirects to. Enforcing that is the launcher's job.

## The token

Use a **fine-grained personal access token** scoped to the repositories the tong
serves, with:

- **Contents: read and write**: fetch, push, and merge. Startup stops if the token
  cannot push to the repository.
- **Pull requests: read and write**: open, read, and edit pull requests.
- **Actions: read**: the `ci_*` verbs. Without it they fail with a `403` that names
  it; the other verbs still work.
- **Actions: read and write**, in place of read, only for dispatch verbs. This also
  lets the token re-run, cancel, and delete runs, and enable or disable workflows.

A token's permissions cover every repository it lists, so `GITHUB_TONG_DISPATCH`,
not the token, switches dispatch, for the whole tong.

A classic `repo` token works but is account-wide. An SSH key cannot open pull
requests.

## Workspace git config

- The agent's container must mount `.git/config`, `.git/hooks`, `.git/branches`,
  `.git/remotes`, and `.git/commondir` read-only. The anvil does this; don't run the
  tong where the agent can write them.
- The tong's own `-c` overrides are a second layer only: they cannot undo a
  workspace `url.<base>.insteadOf`, which would send the token to another host.

## Enabling it

```sh
make image TONG=github                              # swarmforge-tong-github:latest
cp github/github.tong.yaml ~/.swarmforge/tongs/github.yaml
```

Then **edit the copy**. Its `${secret:...}` reference is a placeholder:
`REPLACE-ME` will not resolve. Point it at your own vault:

```yaml
env:
  GITHUB_TOKEN: ${secret:op:op://Private/github-tong/token}
```

The user layer (`~/.swarmforge/tongs/`) skips the approval gate; a
workspace-sourced copy prompts on first run.

To pull instead of build, use
[`crypticswarm/github-tong`](https://hub.docker.com/r/crypticswarm/github-tong)
(`linux/amd64`, `linux/arm64`), pinned by digest:

```sh
docker buildx imagetools inspect crypticswarm/github-tong:latest --format '{{.Manifest.Digest}}'
docker pull crypticswarm/github-tong@sha256:<digest>
```

```yaml
image: crypticswarm/github-tong@sha256:<digest>
```

## Building and testing

```sh
make build      # compile TypeScript
make test       # unit tests — no docker, no token, no network
make image      # docker build
make clean
```
