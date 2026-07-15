import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { openDb } from './db.ts';
import { countPosts, queryPosts } from './posts.ts';
import { drainSpool } from './spool.ts';
import { ensureHome, spoolDir } from './paths.ts';

/**
 * Runs `fn` against a throwaway DEV_STREAM_HOME. Without this the tests would
 * drain -- and delete -- the developer's real spool.
 */
async function withTempHome(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await Deno.makeTempDir({ prefix: 'dev-stream-test-' });
	const previous = Deno.env.get('DEV_STREAM_HOME');
	Deno.env.set('DEV_STREAM_HOME', dir);
	try {
		await ensureHome();
		await fn(dir);
	} finally {
		if (previous === undefined) Deno.env.delete('DEV_STREAM_HOME');
		else Deno.env.set('DEV_STREAM_HOME', previous);
		await Deno.remove(dir, { recursive: true });
	}
}

const write = (name: string, lines: unknown[]) =>
	Deno.writeTextFile(
		join(spoolDir(), name),
		lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
	);

Deno.test('drain writes spooled posts and removes the file', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		await write('hooks.jsonl', [
			{ source: 'claude-code', title: 'Edited a file', ts: '2026-07-13T10:00:00Z' },
			{ source: 'claude-code', title: 'Ran the tests', ts: '2026-07-13T10:01:00Z' }
		]);

		const result = await drainSpool(db);

		assertEquals(result, { files: 1, posts: 2, failed: 0 });
		assertEquals(countPosts(db), 2);
		// Drained files must not be replayed on the next launch.
		assertEquals([...Deno.readDirSync(spoolDir())].length, 0);
	});
});

Deno.test('spooled posts keep their original timestamps', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		// The whole point of the spool: this happened while the app was closed.
		// It must land at 10:00 in the timeline, not at the top of the feed.
		await write('old.jsonl', [{ source: 'ci', title: 'happened yesterday', ts: '2026-07-12T10:00:00Z' }]);
		await drainSpool(db);

		const [post] = queryPosts(db, {}).posts;
		assertEquals(post.ts, '2026-07-12T10:00:00.000Z');
	});
});

Deno.test('a malformed line is quarantined and the rest still land', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		await write('mixed.jsonl', [
			{ source: 'a', title: 'good one' },
			'{ not json at all',
			JSON.stringify({ title: 'no source' }), // valid JSON, invalid post
			{ source: 'a', title: 'good two' }
		]);

		const result = await drainSpool(db);

		// One bad line must never strand the good lines behind it.
		assertEquals(result.posts, 2);
		assertEquals(result.failed, 2);
		assertEquals(countPosts(db), 2);

		// The bad lines are kept as evidence rather than silently dropped.
		const rejected = await Deno.readTextFile(join(spoolDir(), 'mixed.jsonl.rejected'));
		assert(rejected.includes('not json at all'));
		assert(rejected.includes('no source'));
	});
});

Deno.test('drain broadcasts each post it recovers', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		await write('a.jsonl', [{ source: 'a', title: 'one' }, { source: 'a', title: 'two' }]);

		const seen: string[] = [];
		await drainSpool(db, (result) => seen.push(result.post.title));

		// A UI that connected during startup should watch them appear.
		assertEquals(seen.toSorted(), ['one', 'two']);
	});
});

Deno.test('draining an empty or absent spool is a no-op', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		assertEquals(await drainSpool(db), { files: 0, posts: 0, failed: 0 });

		// Not every launch has a spool directory yet.
		await Deno.remove(spoolDir(), { recursive: true });
		assertEquals(await drainSpool(db), { files: 0, posts: 0, failed: 0 });
	});
});

Deno.test('drain ignores files that are not .jsonl', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		await Deno.writeTextFile(join(spoolDir(), 'README.txt'), 'not a spool file');
		await Deno.writeTextFile(join(spoolDir(), 'stale.jsonl.rejected'), '{"junk":true}');

		assertEquals(await drainSpool(db), { files: 0, posts: 0, failed: 0 });
		assertEquals(countPosts(db), 0);
		// ...and a previous run's quarantine file is left alone, not re-eaten.
		assert([...Deno.readDirSync(spoolDir())].some((e) => e.name === 'stale.jsonl.rejected'));
	});
});

Deno.test('spooled posts honour dedupe keys', async () => {
	await withTempHome(async () => {
		const db = openDb(':memory:');
		// A hook that fired repeatedly about one build while the app was down.
		await write('ci.jsonl', [
			{ source: 'ci', title: 'build started', dedupe_key: 'build-9' },
			{ source: 'ci', title: 'build passed', dedupe_key: 'build-9' }
		]);

		await drainSpool(db);

		assertEquals(countPosts(db), 1);
		assertEquals(queryPosts(db, {}).posts[0].title, 'build passed');
	});
});
