/**
 * The poll loop.
 *
 * Runs each enabled worker on its own interval, writes what it returns through the
 * normal ingestion path, and persists the watermark. The only thing it does that a
 * curl cannot is skip the HTTP hop — the posts still go through `insertPosts`, so
 * they are validated, deduped and broadcast identically.
 */

import type { Db } from '../db.ts';
import type { Broadcaster } from '../events.ts';
import { insertPosts, ValidationError } from '../posts.ts';
import { WORKERS, findWorker } from './registry.ts';
import { getSourceState, recordPoll } from './store.ts';
import type { SourceWorker } from './types.ts';

export interface Runner {
	/** Polls one source immediately. Used by the settings page's "Poll now". */
	pollNow(slug: string): Promise<{ posts: number; error?: string }>;
	/** Re-reads enablement and reschedules. Called after settings change. */
	sync(): void;
	stop(): void;
}

export function startSourceRunner(db: Db, broadcaster: Broadcaster): Runner {
	const timers = new Map<string, ReturnType<typeof setInterval>>();
	/** Stops a slow poll from overlapping itself on a short interval. */
	const inFlight = new Set<string>();

	async function poll(worker: SourceWorker): Promise<{ posts: number; error?: string }> {
		if (inFlight.has(worker.slug)) return { posts: 0 };
		inFlight.add(worker.slug);

		try {
			const state = getSourceState(db, worker.slug);
			const result = await worker.poll({ config: state.config, cursor: state.cursor });

			let written = 0;
			if (result.posts.length > 0) {
				try {
					const posts = insertPosts(db, result.posts);
					written = posts.length;
					for (const item of posts) {
						broadcaster.publish({ type: 'post', post: item.post, deduped: item.deduped });
					}
				} catch (err) {
					// A worker producing a malformed post is OUR bug, not the user's, and
					// it must not advance the cursor -- doing so would silently skip the
					// items we failed to write.
					if (err instanceof ValidationError) {
						const message = `${worker.label} produced an invalid post: ${err.message}`;
						console.error(`[sources] ${message}`);
						recordPoll(db, worker.slug, state.cursor, message);
						return { posts: 0, error: message };
					}
					throw err;
				}
			}

			// Advanced only once the posts are committed.
			recordPoll(db, worker.slug, result.cursor, null);
			return { posts: written };
		} catch (err) {
			// A bad token, a rate limit, an outage. Record it and try again next
			// tick: the source stays enabled, because a transient 502 shouldn't make
			// the user go and switch it back on. The cursor is untouched, so nothing
			// is skipped.
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[sources] ${worker.slug} poll failed: ${message}`);
			recordPoll(db, worker.slug, getSourceState(db, worker.slug).cursor, message);
			return { posts: 0, error: message };
		} finally {
			inFlight.delete(worker.slug);
		}
	}

	function sync(): void {
		for (const worker of WORKERS) {
			const { enabled } = getSourceState(db, worker.slug);
			const running = timers.has(worker.slug);

			if (enabled && !running) {
				// Poll straight away, so enabling an integration does something visible
				// rather than leaving the user staring at an empty feed for a minute.
				void poll(worker);

				const timer = setInterval(() => void poll(worker), worker.defaultIntervalMs);
				// Never hold the process open just to poll GitHub.
				Deno.unrefTimer(timer);
				timers.set(worker.slug, timer);
			}

			if (!enabled && running) {
				clearInterval(timers.get(worker.slug)!);
				timers.delete(worker.slug);
			}
		}
	}

	sync();

	return {
		sync,
		async pollNow(slug: string) {
			const worker = findWorker(slug);
			if (!worker) return { posts: 0, error: `unknown source: ${slug}` };
			return await poll(worker);
		},
		stop() {
			for (const timer of timers.values()) clearInterval(timer);
			timers.clear();
		}
	};
}
