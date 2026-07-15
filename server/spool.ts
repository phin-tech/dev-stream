/**
 * The spool: how posts survive the app being closed.
 *
 * A hook firing in a terminal must never block on -- or lose a post to -- a dead
 * server. So when the CLI can't reach the API it appends JSON lines to
 * `~/.dev-stream/spool/*.jsonl` and exits immediately. The app drains them on
 * startup, so the timeline fills in retroactively.
 *
 * Because each spooled post carries its own `ts` from when it happened, draining
 * late puts them at the right point in the timeline, not at the top.
 */

import { join } from './vendored.ts';
import type { Db } from './db.ts';
import type { PostWriteResult } from '../src/shared/types.ts';
import { insertPost, ValidationError } from './posts.ts';
import { spoolDir } from './paths.ts';

export interface DrainResult {
	files: number;
	posts: number;
	failed: number;
}

/**
 * Drains every spool file into the database.
 *
 * Each file is renamed to `*.draining` before being read, so a CLI process
 * appending concurrently keeps writing to a fresh file rather than to one we're
 * about to delete. (POSIX rename is atomic, and an open fd survives it -- worst
 * case a straggler line lands in a file we already moved and gets picked up on
 * the next drain.)
 */
export async function drainSpool(
	db: Db,
	onPost?: (result: PostWriteResult) => void
): Promise<DrainResult> {
	const dir = spoolDir();
	const result: DrainResult = { files: 0, posts: 0, failed: 0 };

	let entries: Deno.DirEntry[];
	try {
		entries = [...Deno.readDirSync(dir)];
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) return result;
		throw err;
	}

	for (const entry of entries) {
		if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;

		const source = join(dir, entry.name);
		const claimed = `${source}.draining`;
		try {
			await Deno.rename(source, claimed);
		} catch (err) {
			// Another drain (or a second app instance) got there first.
			if (err instanceof Deno.errors.NotFound) continue;
			throw err;
		}

		result.files++;
		let text: string;
		try {
			text = await Deno.readTextFile(claimed);
		} catch (err) {
			console.error(`[spool] cannot read ${claimed}:`, err);
			continue;
		}

		const rejects: string[] = [];
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const written = insertPost(db, JSON.parse(trimmed));
				result.posts++;
				onPost?.(written);
			} catch (err) {
				// A malformed line must not strand the whole file: quarantine it
				// and keep going, or one bad post blocks every good one behind it.
				result.failed++;
				const reason = err instanceof ValidationError ? err.message : String(err);
				console.error(`[spool] rejected a line from ${entry.name}: ${reason}`);
				rejects.push(trimmed);
			}
		}

		if (rejects.length > 0) {
			// Keep the evidence rather than silently dropping user data.
			await Deno.writeTextFile(join(dir, `${entry.name}.rejected`), rejects.join('\n') + '\n', {
				append: true
			});
		}
		await Deno.remove(claimed);
	}

	if (result.posts || result.failed) {
		console.log(
			`[spool] drained ${result.posts} post(s) from ${result.files} file(s), ${result.failed} rejected`
		);
	}
	return result;
}
