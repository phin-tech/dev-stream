import { assertEquals, assertThrows } from '@std/assert';
import { openDb } from './db.ts';
import { getPost, insertPost, queryPosts, sweepRetention, ValidationError } from './posts.ts';
import { markAllSeen, markSeen, markUnseen } from './seen.ts';
import { getSettings, updateSettings } from './settings.ts';

// --- per-post read state ---------------------------------------------------

Deno.test('a post is unseen until it is marked, and marking is reflected on read', () => {
	const db = openDb(':memory:');
	const { post } = insertPost(db, { source: 'ci', title: 'a build ran' });

	// A freshly written post comes back unseen...
	assertEquals(post.seen, false);
	assertEquals(queryPosts(db, {}).posts[0].seen, false);

	// ...and marking it seen shows up on the next read.
	markSeen(db, post.id);
	assertEquals(queryPosts(db, {}).posts[0].seen, true);
	assertEquals(getPost(db, post.id)?.seen, true);
});

Deno.test('marking seen is idempotent, and marking unseen reverses it', () => {
	const db = openDb(':memory:');
	const { post } = insertPost(db, { source: 'ci', title: 'toggle me' });

	markSeen(db, post.id);
	markSeen(db, post.id); // no crash, no duplicate row
	assertEquals(queryPosts(db, {}).posts[0].seen, true);

	markUnseen(db, post.id);
	assertEquals(queryPosts(db, {}).posts[0].seen, false);
});

Deno.test('marking an unknown id is a no-op rather than leaving a dangling marker', () => {
	const db = openDb(':memory:');
	markSeen(db, 'no-such-post'); // the FK to posts(id) makes this a silent no-op
	const rows = db.prepare('SELECT COUNT(*) AS n FROM seen_posts').get() as unknown as { n: number };
	assertEquals(Number(rows.n), 0);
});

Deno.test('mark-all-seen clears the whole filtered set and reports how many were new', () => {
	const db = openDb(':memory:');
	for (let i = 0; i < 3; i++) insertPost(db, { source: 'ci', title: `ci ${i}` });
	insertPost(db, { source: 'linear', title: 'unrelated' });

	// The active filter scopes it: only the CI posts are marked.
	assertEquals(markAllSeen(db, { source: ['ci'] }), 3);
	assertEquals(queryPosts(db, { source: ['ci'] }).posts.every((p) => p.seen), true);
	assertEquals(queryPosts(db, { source: ['linear'] }).posts[0].seen, false);

	// Running it again marks nothing new -- the count excludes already-seen posts.
	assertEquals(markAllSeen(db, { source: ['ci'] }), 0);
});

Deno.test('mark-all-seen does not touch muted posts', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'noisy', title: 'hidden' });
	insertPost(db, { source: 'ci', title: 'shown' });

	// A muted post is one the reader can't see, so there is nothing to mark.
	assertEquals(markAllSeen(db, { exclude_source: ['noisy'] }), 1);

	const noisy = queryPosts(db, { source: ['noisy'], exclude_source: ['noisy'] }).posts[0];
	assertEquals(noisy.seen, false);
});

Deno.test('a swept post takes its read marker with it', () => {
	const db = openDb(':memory:');
	const { post } = insertPost(db, { source: 'a', title: 'ancient', ts: '2020-01-01T00:00:00Z' });
	markSeen(db, post.id);

	sweepRetention(db, 30);

	// ON DELETE CASCADE: no orphaned row survives to mark a post that no longer exists.
	const rows = db.prepare('SELECT COUNT(*) AS n FROM seen_posts').get() as unknown as { n: number };
	assertEquals(Number(rows.n), 0);
});

// --- settings toggle -------------------------------------------------------

Deno.test('mark_seen_on_scroll defaults off and only accepts a boolean', () => {
	const db = openDb(':memory:');
	assertEquals(getSettings(db).mark_seen_on_scroll, false);

	assertEquals(updateSettings(db, { mark_seen_on_scroll: true }).mark_seen_on_scroll, true);

	assertThrows(
		() => updateSettings(db, { mark_seen_on_scroll: 'yes' }),
		ValidationError,
		'must be a boolean'
	);
});
