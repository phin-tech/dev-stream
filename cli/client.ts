/**
 * The CLI's half of the ingestion contract: discover the server, post, and never
 * lose a post if it isn't there.
 *
 * This is the piece that makes hooks safe to install. A hook runs inside the
 * user's editing loop, so posting must be fast, must never block, and must never
 * fail loudly — if dev-stream isn't running, the post goes to the spool and the
 * app picks it up next launch.
 */

import { join } from '@std/path';
import type { PostInput } from '../src/shared/types.ts';
import { portPath, spoolDir, tokenPath } from '../server/paths.ts';

/**
 * Deliberately short. A hook is in the user's critical path: if the server is
 * wedged, spooling immediately is far better than making them wait.
 */
const POST_TIMEOUT_MS = 2000;

export interface Delivery {
	/** 'api' when the server took it; 'spool' when it was left on disk for later. */
	via: 'api' | 'spool';
	detail?: string;
}

async function readTrimmed(path: string): Promise<string | null> {
	try {
		const text = (await Deno.readTextFile(path)).trim();
		return text || null;
	} catch {
		return null;
	}
}

/** Reads the two files that constitute the whole discovery protocol. */
export async function discover(): Promise<{ port: number; token: string } | null> {
	const [rawPort, token] = await Promise.all([readTrimmed(portPath()), readTrimmed(tokenPath())]);
	if (!rawPort || !token) return null;

	const port = Number.parseInt(rawPort, 10);
	return Number.isInteger(port) && port > 0 ? { port, token } : null;
}

/**
 * Posts to the running app, falling back to the spool.
 *
 * "Failure" here means anything at all: no port file, connection refused, a
 * timeout, a 500. The only thing that is NOT retried through the spool is a 4xx,
 * because a malformed post will be just as malformed when the app drains it —
 * spooling it would turn a visible error into a silent one.
 */
export async function post(posts: PostInput[]): Promise<Delivery> {
	if (posts.length === 0) return { via: 'api' };

	const config = await discover();
	if (config) {
		try {
			const res = await fetch(`http://127.0.0.1:${config.port}/api/posts`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${config.token}`
				},
				body: JSON.stringify({ posts }),
				signal: AbortSignal.timeout(POST_TIMEOUT_MS)
			});

			if (res.ok) {
				await res.body?.cancel();
				return { via: 'api' };
			}

			if (res.status >= 400 && res.status < 500) {
				const detail = await res
					.json()
					.then((b: { error?: string }) => b.error)
					.catch(() => '');
				// The app would reject it too. Surface it now rather than spooling a
				// post that will only fail again, out of sight, on next launch.
				throw new Error(detail || `the server rejected this post (${res.status})`);
			}
			await res.body?.cancel();
		} catch (err) {
			// A 4xx is a real error and must propagate; everything else (refused,
			// timeout, 5xx) means "the app isn't usable right now" -> spool.
			if (err instanceof Error && !isTransport(err)) throw err;
		}
	}

	return await spool(posts);
}

/** Transport-ish failures are the ones worth spooling through. */
function isTransport(err: Error): boolean {
	return (
		err.name === 'TimeoutError' ||
		err.name === 'AbortError' ||
		err instanceof TypeError || // fetch's connection-refused
		err instanceof Deno.errors.ConnectionRefused ||
		err instanceof Deno.errors.NotFound
	);
}

/**
 * Appends posts to the spool for the app to drain on next launch.
 *
 * One file per invocation, rather than appending to a shared one: hooks fire
 * concurrently (several tool calls can finish at once), and two processes
 * appending large JSON lines to the same file can interleave mid-line and corrupt
 * both. A unique filename makes that impossible, and the drain doesn't care how
 * many files it finds.
 */
async function spool(posts: PostInput[]): Promise<Delivery> {
	const dir = spoolDir();
	await Deno.mkdir(dir, { recursive: true });

	const name = `${Date.now()}-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}.jsonl`;
	const path = join(dir, name);
	const lines = posts.map((p) => JSON.stringify(p)).join('\n') + '\n';

	await Deno.writeTextFile(path, lines);
	return { via: 'spool', detail: path };
}
