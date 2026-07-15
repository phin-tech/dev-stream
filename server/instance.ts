/**
 * Single-instance guard.
 *
 * A PID file would be the obvious approach and the wrong one: it goes stale on a
 * crash and then wrongly blocks every future launch. Instead we ask the port
 * recorded in `~/.dev-stream/port` whether a dev-stream is *actually answering*
 * on it. A dead instance can't reply, so a stale file self-heals; a live one
 * identifies itself and gets told to come to the front.
 */

import type { ServerInfo } from '../src/shared/types.ts';
import { readPort } from './config.ts';

/** Long enough for a busy local process, short enough not to stall startup. */
const PROBE_TIMEOUT_MS = 1000;

/** The already-running app, or null if the port is dead, stale, or someone else's. */
export async function findRunningInstance(): Promise<{ port: number; info: ServerInfo } | null> {
	const port = await readPort();
	if (port === null) return null;

	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		if (!res.ok) return null;

		const info = (await res.json()) as ServerInfo;
		// Something else may well have taken the port since we last wrote it, so
		// the reply has to actually claim to be us.
		return info?.app === 'dev-stream' ? { port, info } : null;
	} catch {
		// Connection refused / timeout / not JSON: nobody home.
		return null;
	}
}

/** Asks the running instance to raise its window. Best-effort. */
export async function focusRunningInstance(port: number, token: string): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/window/focus`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		return res.ok;
	} catch {
		return false;
	}
}
