# dev-stream

A local-first desktop app that is a **Twitter feed for your own machine**. Tools,
agents, CLIs and integrations post events to a timeline you can scroll, filter, and
save views over.

Claude Code edits a file, CI fails a deploy, a PR gets merged, a Linear issue moves
— they all land in one scrollable feed, live.

Everything writes through **one localhost HTTP API**. There is no plugin system,
because there doesn't need to be one: if a thing can `curl`, it can post to your
timeline.

```
                                ┌──────────────────────────────────┐
  claude hooks ──┐              │  dev-stream.app (deno desktop)   │
  dev-stream CLI ┼─ HTTP/token ─┼─► Ingest API  ──► SQLite (posts) │
  curl / anything┘              │  (localhost:4517) │              │
                                │       SSE ◄───────┘              │
  MCP clients ── stdio ── MCP   │        ▼                         │
  (claude, etc.)  server ──HTTP─┤  SvelteKit UI in webview         │
                                │  (timeline, filters, views)      │
  source plugins ── sandboxed ──┤  permission-scoped workers      │
                                └──────────────────────────────────┘
```

Built on Deno 2.9's `deno desktop` (native webview, single-binary compile) with a
SvelteKit frontend. TypeScript end to end.

---

## Quick start

Requires **Deno ≥ 2.9** and **Node** (for the SvelteKit build only).
[Task](https://taskfile.dev) is optional but assumed below.

```sh
npm install
task build          # → out/dev-stream.app and out/dev-stream (the CLI)
task run            # launch it
```

Put `out/dev-stream` on your PATH, then post something:

```sh
dev-stream post "Shipped v1" --tag release
```

It appears in the window immediately. To stream your Claude Code sessions into it:

```sh
cd ~/some/repo
dev-stream init claude       # writes .claude/settings.json hooks
```

If the app isn't running, posts are **spooled** to `~/.dev-stream/spool/` and drain
on next launch. A hook never blocks and never loses an event.

---

## The HTTP API

The app writes two files on first run, and that is the entire discovery protocol:

| File                  | Contents                                  |
| --------------------- | ----------------------------------------- |
| `~/.dev-stream/port`  | The port it actually bound (4517 if free) |
| `~/.dev-stream/token` | A bearer token (mode `0600`)              |

Bound to `127.0.0.1` only. Every route except `/api/health` needs
`Authorization: Bearer <token>`.

```sh
TOKEN=$(cat ~/.dev-stream/token)
PORT=$(cat ~/.dev-stream/port)
API=http://127.0.0.1:$PORT
```

### Post

`POST /api/posts` takes a single object, a bare array, or `{"posts": [...]}`.
A batch is atomic: one bad post rejects the whole thing, so retrying can't duplicate.

```sh
curl -X POST $API/api/posts -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "source": "ci",
    "kind":   "alert",
    "title":  "Deploy failed on main",
    "body":   "Step **build** exited with `1`.",
    "tags":   ["deploy", "failed"],
    "meta":   { "project": "dev-stream",
                "repo":    "phin-tech/dev-stream",
                "url":     "https://github.com/..." },
    "dedupe_key": "build-1234"
  }'
```

| Field        | Required | Notes                                                              |
| ------------ | -------- | ------------------------------------------------------------------ |
| `source`     | yes      | Free-form origin slug (`ci`, `claude-code`, anything).             |
| `title`      | yes      | The card headline.                                                 |
| `ts`         |          | ISO-8601. Server-assigned if absent. Normalized to UTC.            |
| `kind`       |          | `event` (default) \| `note` \| `alert` \| `pr` \| `issue` \| …     |
| `body`       |          | Markdown. Sanitized at render.                                     |
| `tags`       |          | Lowercased, `#` stripped, deduped.                                 |
| `meta`       |          | Open-ended. `project` and `repo` become indexed columns.           |
| `dedupe_key` |          | Re-posting the same key within **10 minutes** *updates* that card. |

`dedupe_key` is what makes a poller idempotent: a build reporting every 60s mutates
one card instead of appending a hundred.

### Query

`GET /api/posts` — newest first, cursor-paginated.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "$API/api/posts?source=ci&tag=deploy&q=failed&limit=50"
```

| Param                            | Notes                                              |
| -------------------------------- | -------------------------------------------------- |
| `source` `project` `repo` `kind` | Repeatable, or comma-separated. OR within a param. |
| `tag`                            | Repeatable. **AND** — a post must carry every tag. |
| `q`                              | Full-text (FTS5) over title, body and tags.        |
| `since` / `until`                | ISO-8601, inclusive.                               |
| `limit`                          | Default 50, max 200.                               |
| `cursor`                         | Opaque; from the previous page's `next_cursor`.    |

Different params AND together. Pagination is keyset, not `OFFSET`, because the feed
has a live head — it stays correct (and flat, ~0.6 ms) while new posts arrive
mid-scroll.

### Everything else

| Route                                                                        | Purpose                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /api/health`                                                            | Unauthenticated. Discovery + liveness.        |
| `GET /api/events`                                                            | SSE. New posts, live. (`?token=` allowed — `EventSource` can't set headers.) |
| `GET /api/posts/:id`                                                         | One post.                                     |
| `GET /api/facets`                                                            | Filter-bar values + counts. Same params as `/api/posts`. |
| `GET`·`POST /api/views`                                                      | Saved views. `PATCH`/`DELETE /api/views/:id`. |
| `POST /api/views/:id/seen`                                                   | Advance the unread marker.                    |
| `GET`·`PUT /api/settings`                                                    | Retention, mutes.                             |
| `GET /api/sources`, `PUT /api/sources/:slug`, `POST /api/sources/:slug/poll` | Integrations.                                 |
| `POST /api/token/regenerate`                                                 | Rotate the bearer token.                      |

---

## CLI

```sh
dev-stream post "Deployed to prod" --tag deploy --kind note
npm test 2>&1 | dev-stream post --source ci --title "Test run"
echo '{"source":"x","title":"raw"}' | dev-stream post --json

dev-stream tail                 # follow the timeline live
dev-stream status               # is the app running, and where?
dev-stream init claude          # install Claude Code hooks
dev-stream mcp                  # run as an MCP server (stdio)
```

`--project` and `--repo` default to the git repo directory name and the `origin`
remote, so hooks and pipes carry context without anyone typing it.

---

## Claude Code

```sh
dev-stream init claude            # this project
dev-stream init claude --global   # every project
```

That merges hooks into `.claude/settings.json` (preserving anything already there;
re-running updates rather than duplicating). Each shells out to `dev-stream hook`,
which reads Claude's JSON payload on stdin and turns it into a post:

| Event          | Becomes                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `PostToolUse`  | "Edited server/posts.ts", "Ran: npm test" (+ output). Failures → `alert`. |
| `Stop`         | The reply's first line as the title, the rest as the body.               |
| `Notification` | An `alert`, deduped per session so a waiting prompt doesn't spam.        |
| `SessionStart` | "Claude session started".                                                |

Matched on `Edit|MultiEdit|Write|NotebookEdit|Bash|Task` — deliberately **not**
`Read`/`Grep`/`Glob`, which fire constantly and say nothing about what changed.

`dev-stream hook` always exits 0. A hook that failed loudly would interrupt your
Claude session over a timeline post, which is never the right trade.

---

## MCP

```sh
claude mcp add dev-stream -- dev-stream mcp
```

Gives any MCP client four tools: `post_to_timeline`, `search_timeline`,
`list_views`, `get_view_posts`. Now you can ask *"what did I ship this week?"* or
*"what broke in dev-stream today?"* and have it answered from your own activity.

---

## Integrations

Settings → Integrations → Install plugin from GitHub. Official plugins:

- `https://github.com/phin-tech/dev-stream-plugins/tree/main/github`
- `https://github.com/phin-tech/dev-stream-plugins/tree/main/linear`

- **GitHub** — a PAT with `notifications` + `repo`. Polls your notifications:
  PRs, reviews requested, issues, failing check suites. Optionally scoped to repos.
- **Linear** — a personal API key. Polls issues by `updatedAt`, optionally by team.

They run in permission-scoped workers and cannot poll until you trust the manifest.
Their posts use the same ingestion path, so they are filterable and searchable like
everything else. A first poll looks back 24h rather than importing an entire backlog.

> Credentials are stored in plaintext in the local SQLite DB. Single-user,
> machine-local — but worth knowing before pasting a broadly-scoped token.
> (Keychain is the obvious V1.1 improvement.)

---

## Views, mutes, retention

- **Views** are saved filters — "Claude on repo X", "everything tagged #deploy" —
  with unread counts since you last opened them.
- **Muting** a source or tag (⋯ on any card) hides it *everywhere*, including
  `dev-stream tail`. It never deletes: unmuting brings the history back.
- **Retention** is off by default. Set it and posts older than N days are swept at
  startup and daily — by *event* time, so a post backfilled today about last year
  counts as a year old.
- **Keyboard**: `j`/`k` to move, `g` to jump to the top, `.` to take new posts.

---

## Development

```sh
task dev        # Vite dev server + headless backend, with hot reload
task api        # just the backend — curl it without a window
task check      # deno check + svelte-check
task test       # the full suite
task            # list every target
```

`task api` runs the whole backend with no webview, which is how the API is developed
and tested. `DEV_STREAM_HOME` relocates `~/.dev-stream` (the tests use it, so they
never touch your real timeline).

Every Task target maps onto a `deno task` of the same name, so
`deno task api` works too if you'd rather not install Task.

### Layout

| Path        | What                                                                  |
| ----------- | --------------------------------------------------------------------- |
| `main.ts`   | Desktop entrypoint: SvelteKit + window + bindings + backend.           |
| `server/`   | SQLite, ingestion API, SSE, spool, views, retention, integrations.     |
| `cli/`      | The `dev-stream` binary and the Claude hook adapter.                   |
| `mcp/`      | The stdio MCP server.                                                  |
| `src/`      | SvelteKit UI. `src/shared/types.ts` is the contract everything shares. |

### Release

```sh
task release      # signed .app with icon
task build:all    # cross-compiled CLI binaries
```

The release build re-runs `codesign` on purpose: `deno desktop` copies the icon into
the bundle *after* signing it, which invalidates the signature. Swap the ad-hoc `-`
identity for a Developer ID to distribute. `--compress` is deliberately unused — see
the note in `deno.json`.

---

## Smoke test

On a fresh machine:

- [ ] First launch creates `~/.dev-stream/{token,port,stream.db}`; token is `0600`.
- [ ] `curl` posts, and the card appears in the window without a refresh.
- [ ] Kill the app, `dev-stream post` → spooled. Relaunch → it drains into the feed
      at its original timestamp, not at the top.
- [ ] Launch a second instance → the running window focuses; no duplicate.
- [ ] `dev-stream init claude`, then a Claude session → live activity.
- [ ] 10k posts: feed and filters stay responsive. (Measured: first page 0.4 ms,
      search 1.9 ms, facets 6.5 ms, deep keyset page 0.6 ms.)
- [ ] Restart → data survives.
