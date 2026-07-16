#!/usr/bin/env bash
#
# Boots an isolated backend + Vite dev server for Playwright. Mirrors the
# `task dev` flow in Taskfile.yml, with two differences:
#
#   - DEV_STREAM_HOME points at .dev-stream-e2e, never the developer's real
#     timeline (or task dev's .dev-stream-dev).
#   - The port/token handoff goes to Vite as process env vars instead of
#     .env.local. Vite gives process.env priority over .env files, so this
#     can run alongside an already-running `task dev` without clobbering its
#     live token.
#
# Vite is pinned to 5174 (--strictPort) so it can't silently fall back onto
# whatever port a concurrent `task dev` (5173) is already holding.
set -e

cd "$(dirname "$0")/.."

export DEV_STREAM_HOME="$(pwd)/.dev-stream-e2e"
rm -rf "$DEV_STREAM_HOME"

deno task api &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT

for _ in $(seq 1 60); do
	[ -f "$DEV_STREAM_HOME/port" ] && break
	sleep 0.25
done
if [ ! -f "$DEV_STREAM_HOME/port" ]; then
	echo "backend never came up" >&2
	exit 1
fi

export VITE_DEV_STREAM_PORT="$(cat "$DEV_STREAM_HOME/port")"
export VITE_DEV_STREAM_TOKEN="$(cat "$DEV_STREAM_HOME/token")"

npm run dev -- --port 5174 --strictPort
