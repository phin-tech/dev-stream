# Hookbridge implementation plan

## Status

This document records the agreed design for a separate `hookbridge` project and
its integration with dev-stream. No hookbridge implementation exists in this
repository.

The hookbridge repository must be created in its own writable workspace before
its RED phase can begin. It must not be silently nested inside dev-stream.

## Goal

Build a small Rust executable that installs observer hooks across coding agents,
normalizes their incompatible JSON payloads, and forwards a canonical event to
arbitrary local programs. A TypeScript or Python hook is just an executable that
reads canonical JSON from stdin.

Hookbridge owns transport compatibility. Consumers own presentation and policy.
For the first consumer, dev-stream decides which normalized activities become
visible timeline cards.

The first release is deliberately observation-only. It cannot allow, deny,
rewrite, or inject context into an agent. Handler failures must never interrupt
the agent.

## Existing work to reuse

### `coding-agent-hooks`

- Rust crate, version 0.7.2 when evaluated.
- Apache-2.0 licensed.
- Provides `AgentKind`, `HookProtocol`, normalized tool/session types, tool-name
  aliases, and agent-specific input/output adapters.
- Protocol adapters exist for Claude, Gemini, Codex, Amazon Q, OpenCode, and
  Copilot.
- Claude is the mature integration. Other adapters must not be advertised as
  equivalent without captured-payload verification.
- Its model is security-oriented and does not cover every observability event or
  field dev-stream needs. Hookbridge must retain the untouched native payload.

### `agent-hooks`

- Rust crate, version 0.1.0 when evaluated.
- MIT licensed.
- Provides additive registration adapters for Claude, Codex, Cursor, Gemini,
  Windsurf, Kiro, and OpenCode.
- Its supported-agent set does not match `coding-agent-hooks`.
- It is immature and only partially documented. Wrap it behind a project-owned
  trait and test every config mutation against temporary real files.

### Reuse decision

Depend on both crates rather than copying them. Hide them behind hookbridge-owned
interfaces so either dependency can be patched or replaced without changing the
public JSON protocol.

“Supported” has two independent meanings and must be reported separately:

1. Hookbridge can install a dispatcher for the agent.
2. Hookbridge can fully normalize that agent/event from verified payloads.

For an installed but unverified protocol, emit a valid pass-through event with
common fields and the complete raw payload. Never fabricate parity.

## Architecture

```text
Native coding-agent hook
          |
          v
hookbridge dispatch --agent <name>
          |
          +-- parse native JSON from stdin
          +-- normalize known fields
          +-- preserve complete native payload
          +-- execute matching handlers concurrently
          |
          +--> dev-stream hook-event
          +--> node custom-hook.mjs
          +--> uv run python custom_hook.py
```

The functional core contains payload normalization, event categorization, and
manifest selection. The imperative shell contains stdin/stdout, config-file
mutation, child processes, timeouts, filesystem discovery, and agent detection.

## Canonical protocol v1

Every handler receives one JSON object:

```json
{
  "schema_version": 1,
  "id": "019...",
  "captured_at": "2026-07-15T12:34:56.789Z",
  "agent": "claude",
  "normalization": "full",
  "event": {
    "canonical_name": "tool.completed",
    "native_name": "PostToolUse"
  },
  "session": {
    "id": "session-id"
  },
  "cwd": "/absolute/project/path",
  "tool": {
    "canonical_name": "shell",
    "native_name": "Bash",
    "input": { "command": "npm test" },
    "output": {},
    "failed": false
  },
  "raw": {}
}
```

Rules:

- `schema_version`, `id`, `captured_at`, `agent`, `normalization`, `event`, and
  `raw` are always present.
- `normalization` is `full`, `partial`, or `passthrough`.
- Optional structures such as `session` and `tool` are omitted when unavailable.
- Unknown fields and event types are preserved in `raw`; unknown data is not an
  error.
- Canonical lifecycle names are `session.started`, `session.ended`,
  `prompt.submitted`, `permission.requested`, `notification`, `tool.requested`,
  `tool.completed`, `agent.stopped`, and `unknown`.
- Canonical tool categories initially include `shell`, `read`, `write`, `edit`,
  `search`, `web`, and `other`.
- Hookbridge assigns the event ID and capture timestamp when the native payload
  does not provide a stable equivalent.

The protocol must be published as JSON Schema. TypeScript and Python bindings are
out of scope for v1; both languages can consume JSON directly. Native bindings,
PyO3, napi-rs, and WASM are explicitly deferred.

## Local handler manifest

V1 uses one machine-local manifest and has no remote package registry:

```json
{
  "version": 1,
  "handlers": [
    {
      "name": "dev-stream",
      "command": ["dev-stream", "hook-event"],
      "events": ["*"],
      "timeout_ms": 2000
    }
  ]
}
```

Use the operating system's standard user-config directory with the relative path
`hookbridge/hooks.json`.

- Commands are arrays, not shell strings. Do not invoke a shell.
- Handlers run concurrently.
- Handler stdout and stderr are captured and discarded during normal dispatch.
- A timeout kills the child process.
- Spawn errors, non-zero exits, malformed handler output, and timeouts are logged
  diagnostically but never affect the agent.
- Dispatch exits zero and emits no decision payload because v1 is observation-only.
- Project-local manifests, npm/GitHub acquisition, lockfiles, updates, and a
  community registry are deferred.

## CLI

```text
hookbridge handler add <name> -- <command> [args...]
hookbridge handler remove <name>
hookbridge handler list [--json]

hookbridge install [--all | --agent <name>]
hookbridge uninstall [--all | --agent <name>]
hookbridge dispatch --agent <name>
hookbridge replay <fixture.json> [--agent <name>]
hookbridge doctor [--json]
```

Behavior:

- `handler add` updates only the named hookbridge entry and preserves all others.
- `install` registers the absolute hookbridge executable path with detected agents.
- Installation and removal are additive, idempotent, and preserve unrelated user
  configuration byte-for-byte where practical.
- `replay` uses the same normalization and handler execution path as live dispatch.
- `doctor` reports binary/config paths, handler health, detected agents,
  installation status, supported native events, and normalization confidence.
- Human output and `--json` output must distinguish installed, normalized,
  passthrough, unsupported, and unverified states.

## Distribution

- Repository and binary working name: `hookbridge`.
- License: dual Apache-2.0 OR MIT.
- Publish native binaries through GitHub Releases.
- Publish a thin npm launcher as `@phin-tech/hookbridge`; it selects/downloads
  the correct release binary and forwards arguments.
- The npm package contains no alternate normalization implementation.
- Cargo installation may be supported for contributors.
- A PyPI/`uvx` launcher is deferred. Python hook programs work immediately because
  handlers are language-neutral subprocesses.

## Dev-stream integration

### Ingestion

Add `dev-stream hook-event`. It reads one canonical schema-v1 event from stdin,
delivers it to the running application, or spools it unchanged when the app is
closed. It always exits zero.

Add `POST /api/agent-events`. The server validates the envelope, stores the full
canonical event, and projects it to a timeline post.

Keep `dev-stream hook` as the legacy direct-Claude adapter during migration.

### Offline spool

Version spool records so they can contain either a post or an agent event:

```json
{"version":1,"type":"post","payload":{}}
{"version":1,"type":"agent_event","payload":{}}
```

The drain must remain backward-compatible with existing bare `PostInput` JSONL
records. Invalid records continue moving to the existing rejected-file path.

### Storage and projection

Add an `agent_events` table containing at least:

- Canonical event ID as the unique key.
- Capture timestamp, agent, canonical event name, category, session ID, cwd.
- Full canonical JSON payload.
- Linked projected post ID.

Every accepted event is stored before projection. Every recognized event receives
a stable projected post, even when its category is currently hidden. This keeps
visibility reversible and preserves seen/dedupe state.

Projection remains a pure function from canonical event plus repository context
to `PostInput`. Store the full raw payload only in `agent_events`; post metadata
contains the event ID and useful normalized fields.

### Timeline categories

Each projected post has exactly one internal activity category:

- `lifecycle`
- `prompt`
- `permission`
- `failure`
- `shell`
- `file-change`
- `read`
- `search`
- `other-tool`

Add `agent_activity_categories: string[]` to dev-stream settings. Default enabled
categories are:

```text
lifecycle, prompt, permission, failure, shell, file-change
```

Reads, searches, and other tools are stored but hidden by default. Apply category
visibility during timeline, facet, unread-count, mark-seen, and SSE queries.
Changing settings reveals or hides existing events immediately; it never deletes
raw events or projected posts.

Existing source/tag muting remains independent and takes precedence alongside
category visibility.

### Settings UI

Add an “Agent activity” section with one checkbox for each category. Saving a
toggle updates the existing settings API and displays a short status message.
Do not add a rule builder or per-agent matrix in v1.

### Installation migration

Add:

```text
dev-stream init agents
```

It must:

1. Find `hookbridge` on PATH and report a precise installation error if absent.
2. Register the absolute `dev-stream hook-event` command as the `dev-stream`
   handler.
3. Run hookbridge installation for detected agents.
4. Only after successful hookbridge registration, remove legacy direct dev-stream
   Claude hook entries to prevent duplicate activity.
5. Preserve every unrelated agent hook and setting.

## Strict TDD execution

Implementation follows the repository's mandatory three-phase protocol.

### RED

Before implementation, output a brief testing strategy separating functional
core tests from imperative-shell integration tests. Then write only failing tests
and halt for explicit approval.

Functional-core tests use state-based input/output and zero mocks:

- Native fixtures normalize to canonical events.
- Full, partial, and passthrough confidence is correct.
- Unknown agents/events preserve the complete raw payload.
- Tool failures and aliases categorize correctly.
- Canonical events project to stable posts and categories.
- Settings validation accepts known categories and rejects malformed values.
- Category filtering hides and reveals existing posts without mutation.

Imperative-shell tests use temporary real files, real child processes, in-memory
fakes, or true integration tests—never mocking frameworks:

- Agent configs are installed and removed additively and idempotently.
- Invalid existing configs are never overwritten.
- A real Node script and real Python script receive equivalent canonical JSON.
- Multiple handlers execute; crash and timeout paths remain fail-open.
- Replay and live dispatch use identical paths.
- Agent-event API storage and projection are atomic and deduplicated.
- Raw events spool while dev-stream is closed and drain after startup.
- Legacy post spool files remain readable.

### GREEN

After explicit approval, write only the minimum implementation required to make
the RED tests pass. Run the complete relevant suites, fix failures, rerun until
green, and halt.

### REFACTOR

Refactor only after an explicit command. Preserve behavior and rerun all suites.

## Acceptance criteria

- The same native fixture produces one schema-v1 canonical event for both a real
  Node handler and a real Python handler.
- Every claimed agent has explicit install and normalization capability status.
- Handler failures cannot block, deny, modify, or delay an agent beyond their
  configured timeout.
- Dev-stream's default timeline retains its current high-signal character.
- Enabling `read` or `search` reveals previously stored events without replay.
- Events captured while dev-stream is closed survive and appear after restart.
- Existing Claude users can migrate without duplicate posts or clobbered hooks.

## Explicitly deferred

- Blocking or mutating hooks.
- Policy evaluation and decision precedence.
- Remote package acquisition and a skills.sh-style registry.
- Dashboard, daemon, cloud service, or telemetry.
- TypeScript/Python native bindings or generated SDK packages.
- Per-agent notification matrices and arbitrary filter rules.
- Project-local hook manifests.
