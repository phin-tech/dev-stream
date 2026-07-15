/**
 * The backend with no window: `deno task api`.
 *
 * This exists so the ingestion API can be built, curl-tested and load-tested
 * without dragging a webview into the loop -- and it is the thing the Phase 1
 * exit criteria are checked against. It is also the seed of the V2 "background
 * daemon the app attaches to" option noted in PLAN.md: same backend, no UI.
 */

import { startBackend } from './serve.ts';

const backend = await startBackend();

console.log(`[headless] dev-stream backend ready
  port:  ${backend.config.port}
  token: ${backend.config.token}

  curl -s -H "Authorization: Bearer ${backend.config.token}" \\
    http://127.0.0.1:${backend.config.port}/api/posts | jq
`);

// Ctrl-C should close the database cleanly (WAL checkpoint) and remove the port
// file, so the next client doesn't chase a port nobody is listening on.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	Deno.addSignalListener(signal, async () => {
		console.log(`\n[headless] ${signal} -- shutting down`);
		await backend.shutdown();
		Deno.exit(0);
	});
}
