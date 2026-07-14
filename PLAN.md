# dev-stream — V1 Plan

A local-first desktop app that acts as a "Twitter feed" for a developer's own machine:
tools, agents, CLIs, and integrations post events to a timeline the user can scroll,
filter, and save views over.

Built on **Deno ≥ 2.9 `deno desktop`** (native webview, single-binary compile,
cross-compilation) with a **SvelteKit** frontend.

---

## Architecture at a glance

```
                                ┌──────────────────────────────────┐
  claude hooks ──┐              │  dev-stream.app (deno desktop)   │
  dev-stream CLI ┼─ HTTP/token ─┼─► Ingest API  ──► SQLite (posts) │
  curl / anything┘              │  (localhost:4517) │              │
                                │       SSE ◄───────┘              │
  MCP clients ── stdio ── MCP   │        ▼                         │
  (claude, etc.)  server ──HTTP─┤  SvelteKit UI in webview         │
                                │  (timeline, filters, views)      │
  GitHub / Linear ── pollers ───┤  built-in source workers         │
                                └──────────────────────────────────┘
```

Key decisions:

- **TypeScript end-to-end.** Deno runs TS natively (backend, CLI, and MCP server
  need no build step); SvelteKit is scaffolded with TypeScript + `svelte-check`.
  A shared `src/shared/types.ts` defines the `Post`, `View`, and filter types
  used by the server, the CLI, the MCP tools, and the frontend, plus a
  `bindings.d.ts` (the documented pattern) so `bindings.<name>()` calls in the
  webview are type-checked against the backend's `win.bind()` handlers.
- **SQLite via `node:sqlite`** (built into Deno 2, zero deps) at `~/.dev-stream/stream.db`.
  Posts are append-mostly; views are saved filter queries. FTS5 for search.
- **One generic ingestion surface** — a localhost HTTP API with a bearer token
  (`~/.dev-stream/token`, created on first run). *Everything* writes through it:
  the CLI, Claude hooks, integrations, the MCP server, and any random `curl`.
  This satisfies the "anything can write to the timeline without a plugin" goal
  and means there's exactly one code path to validate/dedupe posts.
- **Spool fallback**: when the app isn't running, the CLI appends JSON lines to
  `~/.dev-stream/spool/`. The app drains the spool on startup, so hooks never
  lose posts and never block on a dead server.
- **Live updates via SSE** from the local server (Deno desktop bindings are
  request/response only — no streaming — so the webview subscribes to
  `GET /api/events` for new-post pushes; bindings are used for window-level
  things like "reveal in Finder", notifications, settings).
- **SvelteKit with the Deno Deploy adapter** (first in `deno desktop`'s
  detection order). Fallback if it fights us: `adapter-static` + serve the
  output ourselves with `Deno.serve()` — the docs explicitly bless this.

### Post model

```jsonc
{
  "id": "ulid",
  "ts": "2026-07-13T21:04:00Z",       // server-assigned if absent
  "source": "claude-code",            // free-form origin slug
  "kind": "event",                    // event | note | alert | pr | issue | ...
  "title": "Edited src/routes/+page.svelte",
  "body": "optional **markdown**",
  "tags": ["hooks", "editing"],
  "meta": {                           // open-ended, but indexed keys:
    "project": "dev-stream",
    "repo": "phin-tech/dev-stream",
    "branch": "main",
    "url": "https://github.com/...",
    "duration_ms": 1234
  },
  "dedupe_key": "optional — same key within N minutes updates instead of duplicates"
}
```

`project`, `repo`, `source`, `kind`, and `tags` get real columns/indexes; the rest
of `meta` stays as JSON. Views are saved filters over exactly those fields plus
time ranges and full-text search.

---

## Phase 0 — Platform spike (de-risk first)

`deno desktop` shipped in 2.9 and is the newest part of the stack, so prove the
whole pipeline before writing product code.

- Install/upgrade Deno ≥ 2.9 (not currently on PATH on this machine).
- `git init`, scaffold SvelteKit (Vite) with the Deno Deploy adapter.
- Hello-world window: `npm run build && deno desktop .`, then dev loop with `--hmr`.
- Prove one `win.bind()` round-trip and one second `Deno.serve()` on a fixed port
  alongside the webview's auto-bound server.
- Compile and launch a real `.app` bundle; try one cross-compile target.

**Exit:** a compiled app opens a SvelteKit page that calls a binding and fetches
from the fixed-port server. If any of these fail, fall back to adapter-static
before Phase 1.

## Phase 1 — Data layer + ingestion API

The spine of the product. No UI polish yet.

- SQLite schema + migrations (posts, views, sources, FTS5 index).
- `POST /api/posts` (single + batch), `GET /api/posts` with cursor pagination and
  filter params (`source`, `project`, `repo`, `kind`, `tag`, `q`, `since/until`).
- `GET /api/events` (SSE) broadcasting new posts.
- Bearer-token auth; token + port written to `~/.dev-stream/` on first run so
  clients can discover both. Bind to `127.0.0.1` only.
- Dedupe-key upsert logic; spool-drain on startup.
- Single-instance guard (second launch focuses the existing window).

**Exit:** `curl` can post and query; SSE tails new posts; data survives restart.

## Phase 2 — Timeline UI

- Feed with virtualized/infinite scroll, newest-first, live-prepend from SSE
  (with a "N new posts" pill rather than yanking the scroll position).
- Post card: source icon/color, title, relative time, markdown body (sanitized),
  tag/project/repo chips, expandable raw-meta view, links out (repo, url).
- Filter bar: source / project / kind / tag pickers + full-text search box —
  all mapped 1:1 onto the Phase 1 query params.
- Settings page: port, token reveal/regenerate, DB location, retention.

**Exit:** posting via curl shows up live in a scrollable, filterable feed.

## Phase 3 — CLI + Claude Code hooks

- `dev-stream` CLI as a separate small `deno compile` binary:
  - `dev-stream post "msg" [--title] [--source] [--project] [--repo] [--tag ...] [--kind] [--meta k=v]`
  - stdin piping (`some-cmd | dev-stream post --source ci`), `--json` for raw post objects
  - auto-discovers port/token; falls back to the spool when the app is down
  - `dev-stream tail` (SSE follower) as a nice-to-have debugging tool
- Claude Code integration = documented hook recipes (no plugin needed):
  `PostToolUse` / `Stop` / `Notification` hooks in `settings.json` that shell out
  to `dev-stream post`, with `--source claude-code` and project/repo inferred
  from cwd/git.
- `dev-stream init claude` helper that writes those hooks into project settings.

**Exit:** a Claude Code session in any repo produces a live activity stream.

## Phase 4 — Views (the "make it a product" phase)

- Saved views: name + persisted filter set, CRUD via API + UI sidebar.
- Pinned/default view, per-view unread counts since last visit.
- Facet counts in the filter bar (post counts per source/project/tag).
- Quality-of-life: keyboard nav (j/k), mute a source/tag from a card, retention
  sweep (auto-delete posts older than N days, configurable).

**Exit:** "Claude activity on repo X", "all PR events", "everything tagged #deploy"
exist as one-click views.

## Phase 5 — MCP server

Makes the timeline agent-native: any MCP client can read/write it with zero setup.

- `dev-stream mcp` — stdio MCP server (official TS SDK runs fine on Deno),
  bridging to the local HTTP API. Tools:
  - `post_to_timeline(title, body?, tags?, project?, repo?, kind?, meta?)`
  - `search_timeline(query?, filters?, limit?)` — lets an agent ask "what did I
    ship this week?" / "what happened in repo X today?"
  - `list_views()` / `get_view_posts(view)`
- Docs + one-liner install: `claude mcp add dev-stream -- dev-stream mcp`.

**Exit:** Claude (or any MCP client) can post to and query the timeline.

## Phase 6 — Integrations: GitHub & Linear

Built-in "source workers" inside the app process — just privileged clients of the
same ingestion API.

- Source framework: enable/disable + credentials in settings, poll loop with
  cursor persistence, dedupe keys so re-polls don't duplicate.
- **GitHub**: PAT → poll notifications + events for chosen repos (PRs opened/merged,
  reviews, CI status). Webhooks are out of scope for V1 (localhost).
- **Linear**: API key → poll issue updates for chosen teams/projects.
- Rich card rendering for `kind: pr | issue` (state badges, assignee, links).

**Exit:** PR and Linear activity interleaves with local dev activity in one feed.

## Phase 7 — Packaging & V1 release

- App icon; `deno.json` `desktop` config (name, per-platform outputs).
- `--compress` builds; cross-compile matrix (mac arm64/x64, windows, linux) —
  `.dmg` needs a macOS host, which we have.
- macOS codesign identity config (ad-hoc default is fine for personal V1).
- CLI distribution alongside the app (compiled per-platform, or `deno install`).
- README: post API reference, hook recipes, MCP setup. Optional: `Deno.autoUpdate()`
  wiring — nice built-in, but can slip to V1.1.
- Smoke-test checklist: fresh machine, first-run token creation, spool drain,
  10k-post scroll performance.

**Exit:** a downloadable, compiled app + CLI a stranger could set up from the README.

---

## Risks & open questions

- **`deno desktop` maturity** (new in 2.9): Phase 0 exists to find the sharp edges
  early; adapter-static + self-serving is the documented escape hatch.
- **Ingestion while the app is closed**: V1 answer is the spool file. If it turns
  out you want *always-on* capture (pollers running headless), V2 can split the
  server into a background daemon the app attaches to — the API contract makes
  that split cheap later.
- **Port collisions**: pick 4517 by default but bind-any-free-port and write the
  actual port to `~/.dev-stream/port` so clients never hardcode it.
- **Bindings limits**: JSON-serializable payloads only, no streaming, per-window —
  hence the decision to lean on HTTP+SSE and keep bindings for OS-y things.
