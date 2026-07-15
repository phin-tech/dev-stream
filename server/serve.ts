/**
 * Boots the whole backend: database, ingestion API, live event stream, spool drain.
 *
 * Deliberately knows nothing about `deno desktop`. The desktop entrypoint
 * (`main.ts`) and the headless one (`server/headless.ts`) both just call
 * `startBackend()`, which is what lets the API be developed and curl-tested
 * without ever opening a window.
 */

import type { ApiConfig, ServerInfo } from '../src/shared/types.ts';
import { createApiHandler } from './api.ts';
import { readOrCreateToken, writePort, clearPort } from './config.ts';
import { type Db, openDb } from './db.ts';
import { Broadcaster } from './events.ts';
import { APP_VERSION, DEFAULT_PORT, dbPath, ensureHome, isDefaultHome } from './paths.ts';
import { drainSpool } from './spool.ts';
import { startRetentionSweep } from './retention.ts';
import { startSourceRunner } from './sources/runner.ts';
import { diag } from './diag.ts';

diag('EVAL server/serve.ts body (backend module graph now evaluated)');

export interface Backend {
	db: Db;
	broadcaster: Broadcaster;
	config: ApiConfig;
	info: ServerInfo;
	shutdown(): Promise<void>;
}

export interface StartOptions {
	/** Overridable for tests. Defaults to `~/.dev-stream/stream.db`. */
	dbFile?: string;
	/** Invoked when a second launch asks us to raise the window. */
	onFocusRequest?: () => void;
}

export async function startBackend(opts: StartOptions = {}): Promise<Backend> {
	await ensureHome();

	const token = await readOrCreateToken();
	const dbFile = opts.dbFile ?? dbPath();
	const db = openDb(dbFile);
	const broadcaster = new Broadcaster();

	// Mutable because the real port isn't known until the listener binds, and the
	// handler closes over this object to serve /api/health.
	const info: ServerInfo = {
		app: 'dev-stream',
		version: APP_VERSION,
		pid: Deno.pid,
		port: DEFAULT_PORT,
		started_at: new Date().toISOString()
	};

	// Built-in integrations (GitHub, Linear). Privileged only in that they skip the
	// HTTP hop -- their posts still go through insertPosts like everyone else's.
	const sources = startSourceRunner(db, broadcaster);

	const handler = createApiHandler({
		db,
		broadcaster,
		token,
		info,
		dbPath: dbFile,
		onFocusRequest: opts.onFocusRequest,
		sources
	});

	const server = listen(handler);
	const port = server.addr.port;
	info.port = port;

	// Written only once we're actually bound, so no client is ever pointed at a
	// port we failed to take.
	await writePort(port);

	console.log(`[api] listening on http://127.0.0.1:${port}`);

	// Honour retention before anything else reads the DB, so a swept post never
	// briefly appears in the feed on startup.
	const sweeper = startRetentionSweep(db);

	// Catch up on everything that happened while the app was closed. Posts land
	// with their original timestamps, so they slot into the timeline where they
	// belong rather than piling up at the head. Broadcast them anyway: a UI that
	// connected during startup should see them appear.
	await drainSpool(db, (result) => {
		broadcaster.publish({ type: 'post', post: result.post, deduped: result.deduped });
	});

	return {
		db,
		broadcaster,
		config: { port, token },
		info,
		async shutdown() {
			sources.stop();
			sweeper.stop();
			await server.shutdown();
			await clearPort();
			db.close();
		}
	};
}

/**
 * Binds the API.
 *
 * The real timeline *prefers* 4517, so a human debugging with curl can guess the
 * URL — but it refuses to die on a collision, since some other tool may own that
 * port. Falling back to an OS-assigned port is safe precisely because clients read
 * `~/.dev-stream/port` rather than hardcoding one.
 *
 * A RELOCATED home (a test, `task dev`) never even asks for 4517. It is a separate
 * timeline with its own token, and squatting the well-known port would make it
 * impersonate the user's real app: the CLI probes 4517, gets a valid-looking
 * dev-stream health response, sends the real token, and gets a 401 it cannot
 * explain.
 *
 * Note for the desktop build: inside `deno desktop` the *first* Deno.serve() in
 * the process is hijacked to the webview's own port (via DENO_SERVE_ADDRESS) and
 * ignores whatever you pass. main.ts therefore starts SvelteKit first and this
 * second, at which point the requested port is honoured normally.
 */
function listen(handler: (req: Request) => Promise<Response>): Deno.HttpServer<Deno.NetAddr> {
	const onError = (err: unknown) => {
		console.error('[api] unhandled error while serving:', err);
		return Response.json({ error: 'internal error' }, { status: 500 });
	};

	// port 0 => let the kernel pick a free one.
	const preferred = isDefaultHome() ? DEFAULT_PORT : 0;

	try {
		return Deno.serve({ port: preferred, hostname: '127.0.0.1', onError }, handler);
	} catch (err) {
		if (!(err instanceof Deno.errors.AddrInUse)) throw err;
		console.warn(`[api] port ${preferred} is taken; falling back to an OS-assigned port`);
		return Deno.serve({ port: 0, hostname: '127.0.0.1', onError }, handler);
	}
}
