# asana

A [Swarmforge](https://github.com/CrypticSwarm/Swarmforge) tong that works in one
Asana workspace on the agent's behalf.

## What it holds

An Asana **personal access token**, from a `${secret:...}` reference. The agent
never sees it, and no verb accepts or returns it.

## MCP verbs

Reached at `http://asana:8080/mcp` on the session network.

| Verb | Params | What it does |
| --- | --- | --- |
| `current_user` | none | Names the token's user (name, gid, email) and the pinned workspace (name, gid). |
| `get_task` | `task_gid` | Reads one task in full, with its description as plain text (`notes`) and HTML (`html_notes`). |
| `list_tasks` | one of `project_gid`, `section_gid`, `parent_gid`; `incomplete_only?`, `limit?`, `cursor?` | Lists a project's or section's tasks, or a task's subtasks. |
| `search_tasks` | any of `text`, `assignee`, `project_gid` or `section_gid`, `tag_gid`, `completed`, `due_on_after`, `due_on_before`; `limit?` | Searches the workspace, newest first. Needs Asana Premium. |

- An unknown or malformed parameter is refused before Asana is called.
- `assignee` is a user gid or `me`.
- A list returns at most `limit` tasks (default 50, max 100). One ending in a
  `cursor` has more; pass it back for the next page. A full search page says so;
  narrow the search to see more.
- A task outside the pinned workspace is refused, as is a `list_tasks` project,
  section, or parent outside it.
- An Asana error comes back as an error result with its status and message.
- `ASANA_WORKSPACE_ID` pins one workspace; no verb accepts one. Startup stops if
  the token or workspace id is missing or malformed, or the token cannot read the
  workspace.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `lifecycle: session` | It holds a credential. |
| `env: ASANA_TOKEN` | The token. |
| `env: ASANA_WORKSPACE_ID` | The workspace's gid. Not a credential. |

No `mounts:` and no `docker-socket`. The tong contacts only `app.asana.com`.

An Asana personal access token cannot be scoped: it reaches every workspace its
user can. The tong pins one.

## Enabling it

```sh
make image TONG=asana                               # swarmforge-tong-asana:latest
cp asana/asana.tong.yaml ~/.swarmforge/tongs/asana.yaml
```

Then **edit the copy**. Both `REPLACE-ME` values are placeholders: the secret
reference will not resolve, and the workspace id stops startup.

```yaml
env:
  ASANA_TOKEN: ${secret:op:op://Private/asana-tong/token}
  ASANA_WORKSPACE_ID: "1100000000000001"
```

`GET https://app.asana.com/api/1.0/users/me` lists the token's workspaces and gids.

To pull instead of build, use
[`crypticswarm/asana-tong`](https://hub.docker.com/r/crypticswarm/asana-tong)
(`linux/amd64`, `linux/arm64`), pinned by digest:

```sh
docker buildx imagetools inspect crypticswarm/asana-tong:latest --format '{{.Manifest.Digest}}'
docker pull crypticswarm/asana-tong@sha256:<digest>
```

```yaml
image: crypticswarm/asana-tong@sha256:<digest>
```
