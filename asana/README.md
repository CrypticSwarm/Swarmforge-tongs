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
| `create_task` | `name`; `project_gid?` with `section_gid?`, `parent_gid?`; `notes?` or `html_notes?`, `assignee?`, `due_on?` or `due_at?`, `start_on?`, `resource_subtype?`, `custom_fields?`, `blocked_by?` | Creates a task in a project or section, or a subtask. |
| `update_task` | `task_gid`; any of `name`, `notes` or `html_notes`, `assignee`, `due_on` or `due_at`, `start_on`, `resource_subtype`, `completed`, `approval_status`, `custom_fields`, `move_to`, `remove_from_project`, `parent_gid`, `remove_blocked_by`, `add_blocked_by` | Changes the given fields, placement, parent, and blockers, and reports each. |
| `delete_task` | `task_gid` | Moves a task to the token user's Asana trash, restorable for 30 days. |
| `list_comments` | `task_gid`; `include_system?`, `include_html?`, `limit?`, `cursor?` | Lists a task's comments, oldest first; `include_system` adds activity like assignments. |
| `add_comment` | `task_gid`; `text` or `html_text` | Comments on a task as the token's user. |
| `get_project` | `project_gid` | Reads one project with its first 100 sections, portfolios, and goals; custom fields with enum options; and the project's own field values. |
| `update_project` | `project_gid`, `custom_fields` | Sets the project's own custom field values, such as its portfolios' fields. |
| `list_portfolios` | `owner?`, `limit?`, `cursor?` | Lists a user's portfolios. Only a service account's token can name another user. |
| `get_portfolio` | `portfolio_gid`; `limit?`, `cursor?` | Reads a portfolio with its custom fields and a page of its items, with each item's values. |
| `add_to_portfolio` | `portfolio_gid`, `project_gid` | Adds a project to a portfolio. |
| `remove_from_portfolio` | `portfolio_gid`, `project_gid` | Takes a project out of a portfolio. |
| `get_goal` | `goal_gid` | Reads a goal with its metric, parent goals, and first 100 supporters and their contribution weights. |
| `find_projects` | `query`; `limit?` | Finds projects by name, most recently used first. |
| `list_users` | `query?` or `cursor?`; `limit?` | Lists the workspace's users, or finds them by name or email, most worked with first. |

- An unknown or malformed parameter is refused before Asana is called.
- `assignee` is a user gid or `me`.
- `create_task` needs `project_gid`, `parent_gid`, or both; `section_gid` must
  be in `project_gid`.
- `html_notes` and `html_text` are one `<body>...</body>` element. A description
  or comment is at most 20000 characters.
- `custom_fields` maps a field's gid or exact name to a value: an option's
  name or gid as `get_task` shows it (enum), a list of them (multi_enum), user
  gids or `me` (people), a number, text, or a `YYYY-MM-DD` or ISO 8601
  date-time (date). null clears one. At most 20 fields, 20 values each, and 20
  people in all.
- `create_task` resolves `custom_fields` against `project_gid`'s fields, so it
  needs `project_gid`; `update_task` and `update_project` against the task's or
  project's own. Any bad field, option, or person refuses the whole write.
- In `update_task`, null clears `notes`, `assignee`, `due_on`, `due_at`, and
  `start_on`. Send `approval_status` without `completed`; Asana derives it.
- `move_to` is `{project_gid, section_gid?}`; moving within a project the task
  is already in needs `section_gid`. `parent_gid: null` makes a task top-level.
- `blocked_by`, `remove_blocked_by`, and `add_blocked_by` take at most 20 task
  gids each.
- `update_task`, and `create_task` with `blocked_by`, are not atomic: after the
  first Asana call, each other change is its own call, in table order, with no
  retries. A failure lists what already changed and what was not sent.
- Writes run one at a time, across every session sharing the tong. A write that
  gets a 5xx, no answer, or an unreadable answer says it may have gone through.
- A list returns at most `limit` items (default 50, max 100). One ending in a
  `cursor` has more; pass it back for the next page. A full search or lookup page
  says so; narrow it to see more.
- With a `query`, `find_projects` and `list_users` return one page, with no cursor.
- A task, project, portfolio, goal, or user outside the pinned workspace is refused,
  as is any project, section, parent, blocker, or assignee a verb names outside
  it. Writes check this before sending.
- An Asana error comes back as an error result with its status and message.
  `get_project` instead shows portfolios or goals it cannot list, such as on a
  plan without goals, as not available with that error.
- `ASANA_WORKSPACE_ID` pins one workspace; no verb accepts one. Startup stops if
  the token or workspace id is missing or malformed, or the token cannot read the
  workspace.

## Grants it requests, and why

| Grant | Why |
| --- | --- |
| `lifecycle: shared` | It mounts nothing, and every session sharing it acts as the token's Asana user. Trade-off vs `session`: the token stays loaded between sessions, even once rotated, until its container is removed. |
| `env: ASANA_TOKEN` | The token. |
| `env: ASANA_WORKSPACE_ID` | The workspace's gid. Not a credential. |

No `mounts:` and no `docker-socket`. The tong contacts only `app.asana.com`.

An Asana personal access token cannot be scoped: it reaches every workspace its
user can. The tong pins one.

## Enabling it

```sh
make image TONG=asana                               # swarmforge-tong-asana:latest
cp asana/asana.tong.yaml "$SWARMFORGE_ORG_CONFIG_ROOT/.swarmforge/tongs/asana.yaml"
```

That is the org layer, the usual setup. For one user only, copy it to
`~/.swarmforge/tongs/asana.yaml` instead. Both layers skip the approval gate; a
workspace-sourced copy prompts on first run.

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
