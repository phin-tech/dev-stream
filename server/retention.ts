/**
 * The retention sweep: the only thing in dev-stream that deletes user data.
 *
 * It is off by default (`retention_days: 0`) and runs only when the user has
 * asked for it. It sweeps once at startup and then daily, rather than on a timer
 * that assumes the app stays open — a desktop app that runs for twenty minutes a
 * day would otherwise never sweep at all.
 */

import type { Db } from './db.ts';
import { sweepRetention } from './posts.ts';
import { getSettings } from './settings.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Sweeper {
	stop(): void;
}

export function startRetentionSweep(db: Db): Sweeper {
	const run = () => {
		try {
			const { retention_days } = getSettings(db);
			sweepRetention(db, retention_days);
		} catch (err) {
			// A failed sweep must never take the app down: the worst case is that
			// some old posts stick around, which is the safe direction to fail in.
			console.error('[retention] sweep failed:', err);
		}
	};

	run();

	// Re-reads the setting each time, so changing it in the UI takes effect on the
	// next sweep without a restart.
	const timer = setInterval(run, DAY_MS);
	// Don't hold the process open just to wait for a sweep.
	Deno.unrefTimer(timer);

	return { stop: () => clearInterval(timer) };
}
