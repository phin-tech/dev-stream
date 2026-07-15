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

## Phase 0 — Platform spike (de-risk first) — ✅ DONE

`deno desktop` shipped in 2.9 and is the newest part of the stack, so prove the
whole pipeline before writing product code.

- ✅ Deno 2.9.2; SvelteKit scaffolded with the Deno Deploy adapter.
- ✅ Hello-world window, `win.bind()` round-trip, second `Deno.serve()` on a
  fixed port alongside the webview's auto-bound server.
- ✅ Compiled + launched a real `.app` bundle.

**Exit met.** No fallback to adapter-static needed. Sharp edges found (all now
encoded in `main.ts` comments, and all still load-bearing):

- The **first** `Deno.serve()` in the process is hijacked to the webview's port
  via `DENO_SERVE_ADDRESS` and ignores the port you pass. Subsequent calls honour
  theirs — which is exactly why SvelteKit is served first and the API second.
- `bindings` in the page is an on-demand Proxy, so a call that races registration
  rejects with "No callback bound" rather than failing an existence check; the
  frontend retries (`src/lib/bindings.ts`).
- The webview enforces CORS like Safari: the page's origin is the SvelteKit port,
  so calls to the API are cross-origin and need CORS headers + preflight, or they
  fail as the opaque "TypeError: Load failed".

> ⚠️ **Phase 0's claim that bindings worked was never actually verified**, and it
> was wrong. The spike page rendered "error: …" into the DOM and nobody read it.
> That cost real time later — see the bindings bug under Post-V1 below. Lesson: a
> spike that only *renders* its result has not proven anything.

## Phase 1 — Data layer + ingestion API — ✅ DONE

The spine of the product. No UI polish yet.

- ✅ SQLite schema + migrations (posts, post_tags, views, sources, FTS5) — `server/db.ts`.
- ✅ `POST /api/posts` (single, bare array, or `{posts:[…]}`), `GET /api/posts`
  with keyset pagination and `source`/`project`/`repo`/`kind`/`tag`/`q`/`since`/`until`.
- ✅ `GET /api/events` (SSE) broadcasting new posts, with heartbeats.
- ✅ Bearer-token auth; token (0600) + actual port written to `~/.dev-stream/`.
  Bound to `127.0.0.1` only.
- ✅ Dedupe-key upsert; spool drain on startup.
- ✅ Single-instance guard — second launch focuses the running window and exits.

**Exit met**, verified against the compiled `.app` and a headless server: curl
posts and queries, SSE tails new posts live, data survives restart. 38 tests.

Decisions worth carrying forward:

- **Post IDs are `monotonicUlid()`, not `ulid()`.** The feed orders by `(ts, id)`,
  so the id breaks ties whenever two posts share a millisecond — routine for a
  burst of hook events. Plain ULID randomizes its suffix within a millisecond and
  would order those posts arbitrarily.
- **Pagination is keyset, not OFFSET**, because the feed has a live head: OFFSET
  duplicates or skips rows as new posts push everything down mid-scroll.
- **Batch writes are atomic**; the spool drain deliberately is not (one bad line
  must not strand the good lines behind it — it quarantines them to `*.rejected`).
- **Tags are lowercased and `#`-stripped** on the way in, so `#Deploy` and
  `deploy` are one tag.
- **FTS5 `MATCH` takes a query language, not a literal**: user input is tokenized
  and re-emitted as quoted phrases, with a prefix `*` on the last token so search
  behaves like type-ahead.
- **`ApiConfig` is a `type`, not an `interface`** — `win.bind()` returns
  `{readonly [key: string]: unknown}`, and TS withholds an implicit index
  signature from interfaces. An interface here silently fails to compile.
- **`main.ts` loads `.deno-deploy/` through a computed specifier** so the
  generated bundle's broken JSDoc `import()` types stay out of the type graph
  (otherwise `deno desktop` refuses to launch on 13 TS2307s in code we don't own).
  The cost: the app must be built with `--include .deno-deploy`, and compiled
  permissions must be passed at build time. Both live in `deno task build:app`.
- The UI is a cross-origin client of the API like any other; it gets the token
  from the `getApiConfig` binding, since a sandboxed page cannot read
  `~/.dev-stream/token`.

## Phase 2 — Timeline UI — ✅ DONE

- ✅ Infinite-scroll feed, newest-first, live arrivals held behind an "N new
  posts" pill rather than shifting the page under the reader.
- ✅ Post card: source colour, kind badge, title, relative time, sanitized
  markdown body, tag/project/repo chips (click to filter), expandable raw meta,
  links out.
- ✅ Filter bar: source / project / repo / kind / tag pickers + debounced search,
  all mapped 1:1 onto the Phase 1 query params.
- ✅ Settings page: port, token reveal/regenerate, DB path + reveal in Finder,
  post count, retention.

**Exit met:** posting via curl appears live in a scrollable, filterable feed.

New backend surface this needed: `GET /api/facets`, `GET|PUT /api/settings`,
`POST /api/token/regenerate`, and a `settings` table (migration 2).

Decisions worth carrying forward:

- **Links must never be plain anchors.** In a webview an `<a href>` navigates the
  *app window* to the target site — the timeline becomes GitHub with no way back.
  Every outbound link (card chips and links inside rendered markdown) is
  intercepted and handed to the OS via the `openExternal` binding, which accepts
  http(s) only. `revealInFinder` is similarly restricted to `~/.dev-stream`.
- **Post bodies are untrusted input.** Anything on the machine can POST, so a body
  could carry a `<script>`; it renders inside a webview holding the API token and
  OS bindings. Bodies go through DOMPurify with an allow-list before `{@html}`.
- **Facet counts exclude their own dimension.** Counting `source` with
  `source=ci` applied would zero every other source and make the picker a dead
  end — you could only ever narrow, never widen. Each dimension is counted with
  the *other* filters applied but its own omitted.
- **SSR is off app-wide** (`+layout.ts`): every page needs the `bindings` global,
  the token it returns, and `EventSource`, none of which exist server-side.
- **Live arrivals are queued, not prepended**, and while a search is active they
  are dropped rather than guessed at — FTS5 semantics don't exist client-side, and
  announcing a post the server wouldn't return is worse than staying quiet.
- **Scroll is infinite, not virtualized.** Cards are cheap and pages are 50 posts;
  windowing is deferred until the Phase 7 10k-post smoke test says it's needed.

## Phase 3 — CLI + Claude Code hooks — ✅ DONE

- ✅ `dev-stream` CLI, its own `deno compile` binary (`deno task build:cli`):
  `post`, `tail`, `hook`, `init claude`, `status`.
- ✅ stdin piping, `--json`, `--meta k=v`, `--dedupe-key`, project/repo/branch
  inferred from cwd + git.
- ✅ Auto-discovers port/token; spools when the app is down.
- ✅ `dev-stream init claude [--global]` merges hooks into `.claude/settings.json`.

**Exit met:** hooks fired against a running app produce live cards; fired against
a closed app they spool and drain on next launch. 12 CLI tests.

Decisions worth carrying forward:

- **The hook adapter is a subcommand (`dev-stream hook`), not a shell one-liner.**
  Claude delivers hook events as JSON on stdin; doing the translation in the
  binary means the recipe needs no `jq` and the settings.json line stays readable.
- **`dev-stream hook` always exits 0.** A non-zero exit from a hook surfaces as an
  error *inside the user's Claude session*. A timeline that can't post is never
  worth interrupting someone's work over.
- **Hooks are curated, not exhaustive.** `Read`/`Grep`/`Glob` fire constantly and
  say nothing about what changed; a feed of them is a feed nobody reads. Default
  recipes: `PostToolUse` (edits, writes, Bash, Task), `Stop`, `Notification`,
  `SessionStart`. Failed tool calls become `kind: alert`.
- **Notifications carry a dedupe key** (`session_id` + `notification_type`):
  Claude re-notifies while waiting on the same permission prompt, and without it
  the feed fills with identical cards.
- **The spool writes one file per invocation**, not appends to a shared one: hooks
  fire concurrently and two processes appending large JSON lines to one file can
  interleave mid-line and corrupt both.
- **A 4xx is never spooled.** A malformed post will be just as malformed when the
  app drains it — spooling it would turn a visible error into a silent one.
  Everything else (refused, timeout, 5xx) spools.
- **`init` rewrites its own entry rather than appending**, so re-running after the
  binary moves updates the command instead of stacking a second hook — and it
  never touches the user's own hooks or settings.

## Phase 4 — Views (the "make it a product" phase) — ✅ DONE

- ✅ Saved views: name + persisted filter, full CRUD via API + a sidebar.
- ✅ Pinned views sort first; per-view unread counts since last visit.
- ✅ Facet counts in the filter bar (landed early, in Phase 2).
- ✅ Keyboard nav (`j`/`k`, `g` to top, `.` to take new posts), mute a
  source/tag from a card, retention sweep.

**Exit met:** "Claude activity on repo X" and friends are one-click views.

Decisions worth carrying forward:

- **A view is a serialized `PostFilter`, nothing more** — the same object the
  filter bar produces and `GET /api/posts` consumes. That is what stops "what I
  see when I fiddle with filters" and "what I see when I click a view" from ever
  drifting apart. A view is not allowed to persist a `cursor`, which would pin it
  to a page that scrolls away.
- **The unread mark is an exclusive bound (`after`), not `since`.** Caught in
  testing: `since` is inclusive, so a post written in the same millisecond as the
  view's creation was "unread from birth".
- **A new view starts caught up.** Calling an entire pre-existing backlog "unread"
  the moment you name a filter is noise, not information.
- **Muting hides; it never deletes.** A muted source keeps posting and unmuting
  brings its history back — deleting data because something is noisy today is the
  wrong trade. Mutes are applied server-side so `dev-stream tail` and curl honour
  them too, and there's a persistent banner because an invisible filter you forgot
  you set is a bug report waiting to happen.
- **Muting a value you have explicitly selected does not hide it.** "Keep this out
  of my way by default" ≠ "refuse to show it even when I ask". But muted values
  *are* dropped from the facet pickers — offering to filter by something you muted
  is nonsense. (These two pull in opposite directions; both are deliberate.)
- **Unread counts are computed, never cached.** A cached count is a count that can
  be wrong, and a badge that lies is worse than no badge.
- **Retention sweeps by event time (`ts`), not ingest time**, so a post backfilled
  today about last year is a year old — which is what "keep 30 days" means to a
  human. Off by default; swept at startup and daily, because a desktop app that
  runs 20 minutes a day would never reach a pure interval timer.

## Phase 5 — MCP server — ✅ DONE

- ✅ `dev-stream mcp` — stdio MCP server (official TS SDK, running on Deno),
  bridging to the local HTTP API. Tools: `post_to_timeline`, `search_timeline`,
  `list_views`, `get_view_posts`.
- ✅ Install: `claude mcp add dev-stream -- dev-stream mcp`.

**Exit met:** driven over real stdio — an agent can search, list views, and its
posts land in the timeline like any other client's.

Decisions worth carrying forward:

- **The MCP server is a client of the HTTP API, not a second door into SQLite.**
  An agent's post gets the same validation, dedupe and SSE broadcast as one from
  curl, and the app never has to learn what MCP is.
- **Posts spool; reads don't.** `post_to_timeline` works with the app closed
  (the CLI's spool path), so an agent is never blocked by whether a window is
  open. Searching genuinely needs the server, and says so.
- **Tool results are prose, not JSON.** An agent asking "what did I ship this
  week?" wants to read the answer; dumping post objects with ULIDs and every meta
  key burns context for nothing.
- **The SDK import needs both a `.js` suffix and a `@deno-types` directive.** SDK
  1.29 replaced the explicit `./server/mcp.js` export with a `./*` wildcard: the
  suffixed form resolves at runtime but not for types, and the bare form
  type-checks and then fails at runtime. Only doing both works — and `deno check`
  alone would not have caught it.
- **The MCP SDK is imported lazily** in the CLI: `dev-stream hook` runs on every
  tool call in a Claude session and must not pay to load a server it never starts.

## Phase 6 — Integrations: GitHub & Linear — ✅ DONE

- ✅ Source framework (`server/sources/`): a worker declares its config fields and
  a `poll()`; the settings UI, the routes and the scheduler are generic. Adding an
  integration needs no schema change and no UI work.
- ✅ Enable/disable + credentials in settings, poll loop with cursor persistence,
  dedupe keys so re-polls don't duplicate. "Poll now" button.
- ✅ **GitHub**: PAT → notifications (PRs, reviews, issues, check suites), with
  state/author pulled through per item.
- ✅ **Linear**: API key → issues by `updatedAt`, filtered by team.
- ✅ Rich `pr`/`issue` cards: state badges (merged/closed/open/draft), assignee,
  links out.

**Exit met:** driven against a fake GitHub — PR and check activity interleaves
with local events, and re-polling updates cards instead of duplicating them.
17 tests.

Decisions worth carrying forward:

- **Pollers are ordinary clients.** They call the same `insertPosts` the HTTP API
  calls, so their posts are validated, deduped, broadcast and filterable
  identically. The only privilege they have is skipping the HTTP hop.
- **`dedupe_key` is identity + version** (`github:<thread>:<updated_at>`). GitHub's
  `since` is *inclusive*, so the newest item of one poll always reappears in the
  next; the key makes that an update rather than a duplicate, while a genuinely new
  change carries a new `updated_at` and so becomes a new card.
- **A first poll looks back 24h, not forever.** Otherwise enabling an integration
  dumps a year of backlog into the middle of the timeline.
- **A failed poll records the error and keeps the source enabled**, and never
  advances the cursor. A transient 502 must not require the user to go switch the
  integration back on, and must not silently skip the items it failed to fetch.
  The error is shown in settings — a token that expired weeks ago and a feed that
  just went quiet is the most likely way this feature fails.
- **Secrets are write-only.** They are never returned to the client; the UI learns
  only `configured: true`. A blank secret on save *preserves* the stored one,
  because the page cannot re-submit a value it was never given. (They are stored in
  plaintext SQLite — noted in the UI, and the obvious V1.1 improvement is Keychain.)
- **Linear's state `type` is the stable enum; its `name` is whatever the team
  renamed the column to.** Reason about the type, display the name.
- Two bugs the fake-server tests caught: reading an error body as JSON *and then*
  cancelling it ("Cannot cancel a locked ReadableStream"), and a failed per-item
  detail fetch rejecting out of the whole poll and losing the rest of the batch.

## Phase 7 — Packaging & V1 release — ✅ DONE

- ✅ App icon (`assets/icon.icns`, generated); full `desktop` config in `deno.json`
  (name, identifier, icons, per-platform outputs).
- ✅ Cross-compile matrix for the CLI (mac arm64/x64, linux x64/arm64, windows).
- ✅ macOS codesigning (ad-hoc, one identity swap away from Developer ID).
- ✅ `Taskfile.yml` — `task dev` / `build` / `run` / `check` / `test` / `release`.
- ✅ README: API reference, CLI, hook recipes, MCP setup, smoke-test checklist.
- ✅ 10k-post performance measured.

**Exit met:** `task build` produces a signed `.app` and a CLI binary a stranger
could set up from the README. 88 tests.

Findings worth carrying forward:

- **`deno desktop` copies the app icon in AFTER it codesigns**, which invalidates
  the signature ("a sealed resource is missing or invalid"). The release task
  re-runs `codesign` to seal it; without that, a distributed build would be
  rejected by Gatekeeper.
- **`--compress` is unusable on Deno 2.9.2.** It breaks codesign outright, and even
  after a manual `codesign --deep`, the self-extracting stub unpacks to
  `~/Library/Application Support` and then can't find its own inner binary. It
  would take the app from 156MB → 32MB, so it is worth revisiting.
- **The app needs unscoped `--allow-net`** now that pollers exist: their API host is
  user-configurable (GitHub Enterprise, self-hosted Linear). `--allow-run` stays
  scoped to `open`.
- **Performance is not a concern at this scale.** Over 10k posts: first page 0.4 ms,
  filters 0.5 ms, full-text 1.9 ms, facets 6.5 ms, and a keyset page 2000 posts deep
  is *still* 0.6 ms — which is the payoff for not using OFFSET. Virtualized scrolling
  remains unnecessary.
- **`task dev` has no webview, so no `bindings` global**, and the page cannot obtain
  the API token the normal way. It starts the backend, waits for it, and injects
  port/token via `.env.local`; `src/lib/api.ts` has a dev-only fallback that
  `import.meta.env.DEV` strips from the production bundle, so no token path can ever
  reach a shipped build.

---

## Post-V1 — bugs found by actually launching the app

The app was verified by running the *binary*, from a terminal, in the repo
directory. A user double-clicking the `.app` hits a different world: a different
working directory, a real Finder launch. Three bugs lived in that gap.

### 1. Blank window when launched via `open` / Finder

`main.ts` passed `Deno.cwd()` to SvelteKit as the root it resolves static assets
against. Launch Services gives the process a cwd of `/`, so every CSS and JS asset
404'd at `/.deno-deploy/static/...`. The HTML still returned 200 — it is embedded
in the server bundle rather than read from disk — so the page "loaded" and painted
nothing. Fixed by deriving the root from `import.meta.url`, which is correct both
from source and inside the compiled app's VFS.

### 2. `win.bind()` silently registers nothing (the big one)

Every binding call from the page rejected with `No callback bound for: <name>`.
The binding *was* registered, on the *right* window (`executeJs` reached the very
page that was failing). Bisected against the real app:

| entrypoint contains…                          | bindings |
| --------------------------------------------- | -------- |
| window + `bind` + `Deno.serve`, nothing else   | ✅ work  |
| `import "node:sqlite"` — **even unused**       | ❌ break |
| any `jsr:` import — **even unused**            | ❌ break |
| an `npm:` import                               | ✅ work  |
| the SvelteKit handler (`.deno-deploy`)         | ✅ work  |
| **bind first, then load the backend lazily**   | ✅ work  |

So: `win.bind()` fails if certain modules have already been **evaluated** in the
isolate. (Related: denoland/deno#35647. Its fix, #35654, is listed in the 2.9.2
changelog but is *not* effective — the upstream repro still fails on 2.9.2, and
`"vendor": true` doesn't help.)

The fix is a startup order plus two constraints:

1. **Bind before anything touches SQLite.** `main.ts` now goes
   window → `bind` → SvelteKit → `serve` → backend.
2. **The backend is a *literal* dynamic import.** A literal specifier is still
   statically analyzable, so `deno compile` embeds the module, but evaluation is
   deferred until awaited. (A *computed* specifier would also defer it — and would
   not be embedded, so the compiled app would die with a missing module.)
3. **`main.ts` and its static imports must avoid `jsr:`** — hence
   `server/vendored.ts`, local stand-ins for the six `@std` helpers the early graph
   needed (`join`, `dirname`, `resolve`, `fromFileUrl`, `encodeHex`,
   `monotonicUlid`). The CLI and MCP server are separate binaries, not desktop
   apps, and keep using `@std` normally.

`server/vendored.ts` exists **only** for this bug and should be deleted the day
`deno desktop` fixes it.

### 3. A relocated `DEV_STREAM_HOME` squatted port 4517

A test/dev instance still grabbed the well-known port. It answers `/api/health` as
a perfectly valid dev-stream, so the CLI believes it — and then every post 401s
against a token from a different timeline, with no way to explain why. Now only the
*real* home may take 4517; a relocated one always gets an OS-assigned port. The CLI
also turns a 401 into an explanation instead of an uncaught stack trace.

---

## V1 is complete

All seven phases are done. What deliberately did **not** ship, and why:

- **Webhooks** for GitHub/Linear — needs a public URL; polling is correct for localhost.
- **Keychain for integration credentials** — they sit in plaintext SQLite today. The
  most obvious V1.1 item.
- **`Deno.autoUpdate()`** — the plan already flagged it as optional.
- **Virtualized scrolling** — measured as unnecessary (see above).
- **A headless daemon** — the spool covers "app is closed" for V1, and the API
  contract makes the split cheap later if always-on capture is ever wanted.

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
