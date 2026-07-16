# dev-stream

A local-first desktop activity timeline for your machine.

Agents, CLIs, hooks, CI jobs, GitHub, Linear, and anything that can make an HTTP
request can post into one searchable feed. Events arrive live, stay on your
computer, and can be filtered, saved, read, archived, or opened without changing
tools.

## What it does

- Collects local development activity in a live desktop timeline.
- Searches post titles, bodies, and tags with SQLite FTS5.
- Filters by source, project, repository, kind, and tag.
- Saves filters as views with independent unread counts.
- Archives posts without deleting them.
- Supports macOS and Vim-style keyboard navigation.
- Accepts events through a CLI, localhost API, Claude Code hooks, MCP, and
  sandboxed source plugins.
- Spools posts while the app is offline and drains them on the next launch.

## Architecture

```text
Claude hooks ─┐
CLI / curl ───┼── localhost HTTP + token ──► ingestion API ──► SQLite
MCP clients ──┘                                  │                │
                                                │ SSE            │
Source plugins ── permission-scoped workers ────┘                ▼
                                                        SvelteKit timeline
                                                        in a native webview
```

The desktop app and CLI are TypeScript end to end. The backend runs on Deno,
the interface is SvelteKit, and the desktop shell uses Deno's native webview.

## Install from source

Requirements:

- macOS
- Deno 2.9 or newer
- Node.js

```sh
deno task install
```

This installs:

- `~/.local/bin/dev-stream`
- `~/Applications/dev-stream.app`

`install` runs `deno task setup` first, so a fresh clone is bootstrapped
automatically. `setup` populates `node_modules/` (`deno install` — `deno.json`
uses `nodeModulesDir: manual`, so Deno won't auto-install) and generates
`.svelte-kit/tsconfig.json` (`npm run prepare` → svelte-kit sync). Both are
gitignored and both are required for the build to type-check:

- Without `node_modules`, `zod` and `@modelcontextprotocol/sdk` resolve to
  nothing and the MCP server fails with implicit-`any` errors (TS7006 / TS7031).
- Without `.svelte-kit/tsconfig.json` (which the root `tsconfig.json` extends),
  the module options collapse into a conflicting `bundler` + `NodeNext` combo
  (TS5095 / TS5109).

Run `deno task setup` on its own if you only need the dev/test toolchain
without building the app.

Open the app, then post an event:

```sh
dev-stream post "Shipped archive support" --kind note --tag release
```

If the app is not running, the CLI writes to `~/.dev-stream/spool/`. The app
drains that queue on launch using the events' original timestamps.

## Keyboard

The Help tab and command palette are generated from the same shortcut catalog as
the application commands.

| Action | macOS | Vim-style |
| --- | --- | --- |
| Command palette | `⌘K` | `:` |
| Shortcut reference | `⌘/` | `?` |
| Settings | `⌘,` | |
| Timeline | `⌘0` | |
| Toggle views sidebar | `⌘B` | `z` |
| Focus search | `⌘F` | `/` |
| Open Source / Project / Repo filter | | `f s` / `f p` / `f r` |
| Open Kind / Tag filter | | `f k` / `f t` |
| Clear all filters | | `f c` |
| Select next / previous | `↓` / `↑` | `j` / `k` |
| Jump to first / last | `⌘↑` / `⌘↓` | `g g` / `G` |
| Move half a page | `⌃D` / `⌃U` | |
| Quick Look | `Space` | |
| Open persistent details | `Return` | `o` |
| Open primary link | `⌘Return` | `g l` |
| Mark read or unread | | `m` |
| Archive or restore | | `a` |
| Show newer posts | | `.` |

Quick Look is temporary: press `Space` or `Esc` to dismiss it. `Return`
opens the selected post's persistent details.

Inside a filter, use `j`/`k` or the arrow keys to move, `Space` to toggle
multiple values, type to jump to a value, `Return` to finish, and `Esc` to close.
Pressing `Return` in search applies the query and returns focus to the first result.

## CLI

```sh
# Simple post
dev-stream post "Deployed to production" --source ci --kind event --tag deploy

# Markdown body from a command
npm test 2>&1 | dev-stream post --source ci --title "Test run"

# Raw post or batch from stdin
echo '{"source":"release","title":"Version 0.2 shipped"}' | dev-stream post --json

# Follow the live timeline
dev-stream tail

# Check local app discovery
dev-stream status

# Install Claude Code hooks
dev-stream init claude

# Run the MCP server over stdio
dev-stream mcp
```

`--project` and `--repo` default to the current Git repository when possible.
Use `--dedupe-key` for repeated status updates that should update one post
instead of producing duplicates.

## Claude Code

```sh
dev-stream init claude
dev-stream init claude --global
```

The installer merges hooks into the existing Claude Code settings rather than
overwriting them. Re-running it updates dev-stream's entries without duplication.

Useful events become timeline posts:

| Claude event | Timeline result |
| --- | --- |
| File edit | A concise edit card |
| Shell command | Command and output |
| Failed tool call | Alert |
| Session stop | Reply title and body |
| Notification | Deduplicated alert |

Read-only tool noise is intentionally ignored. Hook delivery always exits
successfully so a timeline failure cannot block an agent session.

## MCP

```sh
claude mcp add dev-stream -- dev-stream mcp
```

The MCP server exposes tools to post, search, list saved views, and fetch view
posts.

## Local HTTP API

The app discovers its bound port and bearer token through:

| File | Purpose |
| --- | --- |
| `~/.dev-stream/port` | Active localhost port |
| `~/.dev-stream/token` | Bearer token, stored with mode `0600` |

The server binds to `127.0.0.1`. Every route except `/api/health` requires the
token.

```sh
TOKEN=$(cat ~/.dev-stream/token)
PORT=$(cat ~/.dev-stream/port)
API=http://127.0.0.1:$PORT

curl -X POST "$API/api/posts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "source": "ci",
    "kind": "alert",
    "title": "Deploy failed on main",
    "summary": "The production build exited with status 1.",
    "body": "Step **build** failed.",
    "tags": ["deploy", "failed"],
    "meta": {
      "project": "dev-stream",
      "repo": "phin-tech/dev-stream"
    },
    "dedupe_key": "build-1234"
  }'
```

`POST /api/posts` accepts one object, a bare array, or
`{"posts": [...]}`. Batch writes are atomic.

### Important routes

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Discovery and liveness |
| `GET /api/events` | Live SSE stream |
| `GET·POST /api/posts` | Query or create posts |
| `GET /api/posts/:id` | Fetch one post |
| `POST /api/posts/:id/seen` | Mark read |
| `POST /api/posts/:id/unseen` | Mark unread |
| `POST /api/posts/:id/archive` | Archive |
| `POST /api/posts/:id/restore` | Restore |
| `GET /api/facets` | Filter values and counts |
| `GET·POST /api/views` | List or create saved views |
| `PATCH·DELETE /api/views/:id` | Update or remove a view |
| `GET·PUT /api/settings` | Read or update settings |
| `GET /api/sources` | Installed source plugins |

Post queries support repeatable `source`, `project`, `repo`, `kind`, and
`tag` parameters, plus `q`, `since`, `until`, `archived`, `limit`,
and an opaque pagination `cursor`.

## Source plugins

Plugins are installed from Settings and run in permission-scoped Deno workers.
A plugin cannot poll until its manifest is trusted. Network access is restricted
to declared hosts, and changing a manifest revokes its previous trust grant.

Official plugin sources can provide integrations such as GitHub notifications
and Linear issue updates. Their posts use the normal ingestion path, so they are
searchable, filterable, archivable, and visible to saved views.

Credentials currently live in the machine-local SQLite database. They are not
synced, but they are not stored in Keychain yet.

## Data behavior

- Saved views are named filters with independent unread markers.
- Muting hides a source or tag without deleting its history.
- Archive is reversible and separate from muting.
- Retention is disabled by default and uses event time when enabled.
- Pagination uses a stable keyset cursor so new live events do not shift older
  pages.
- Markdown is sanitized before rendering.

## Development

```sh
deno task dev          # Vite frontend and headless backend
deno task api          # backend only
npm run check          # Svelte and TypeScript diagnostics
deno task test         # unit and integration tests
npm run test:e2e -- --workers=1
```

The browser suite shares one local backend and database, so run it with one worker
when executing the full file.

### Repository layout

| Path | Responsibility |
| --- | --- |
| `main.ts` | Desktop entrypoint and native window |
| `server/` | SQLite, API, SSE, archive, views, plugins, retention |
| `cli/` | CLI and Claude hook adapter |
| `mcp/` | MCP stdio server |
| `src/` | SvelteKit interface and shared types |
| `e2e/` | Desktop timeline browser regressions |

## Build and release

```sh
deno task build:cli
deno task build:app
deno task install
```

The local app is ad-hoc codesigned after bundling. Distribution builds should use
a Developer ID identity and the normal notarization flow.
