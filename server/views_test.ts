import { assert, assertEquals, assertThrows } from '@std/assert';
import { openDb } from './db.ts';
import { countPosts, insertPost, queryFacets, queryPosts, sweepRetention, ValidationError } from './posts.ts';
import { createView, deleteView, listViews, markViewSeen, updateView } from './views.ts';

// --- saved views -----------------------------------------------------------

Deno.test('a view is just a named filter', () => {
	const db = openDb(':memory:');
	const view = createView(db, {
		name: 'Claude on dev-stream',
		filter: { source: ['claude-code'], repo: ['phin-tech/dev-stream'] }
	});

	assertEquals(view.name, 'Claude on dev-stream');
	assertEquals(view.filter.source, ['claude-code']);
	assertEquals(view.pinned, false);

	// ...and running it means running exactly the same query the filter bar runs.
	insertPost(db, { source: 'claude-code', title: 'in', meta: { repo: 'phin-tech/dev-stream' } });
	insertPost(db, { source: 'ci', title: 'out', meta: { repo: 'phin-tech/dev-stream' } });

	assertEquals(queryPosts(db, view.filter).posts.map((p) => p.title), ['in']);
});

Deno.test('view names are unique, and the clash is a user error not a crash', () => {
	const db = openDb(':memory:');
	createView(db, { name: 'Deploys', filter: { tag: ['deploy'] } });

	assertThrows(
		() => createView(db, { name: 'Deploys', filter: {} }),
		ValidationError,
		'already exists'
	);
	assertThrows(() => createView(db, { name: '  ', filter: {} }), ValidationError, 'name is required');
});

Deno.test('a view cannot smuggle in a cursor or unknown keys', () => {
	const db = openDb(':memory:');
	// A persisted cursor would pin the view to a page that scrolls away.
	const view = createView(db, {
		name: 'Clean',
		filter: { source: ['ci'], cursor: 'abc', limit: 9999, nonsense: true }
	});

	assertEquals(view.filter, { source: ['ci'] });
});

Deno.test('a new view starts caught up rather than claiming the whole backlog is unread', () => {
	const db = openDb(':memory:');
	for (let i = 0; i < 5; i++) insertPost(db, { source: 'ci', title: `old ${i}` });

	createView(db, { name: 'CI', filter: { source: ['ci'] } });

	// Five posts already existed; none of them are "new since you made this view".
	assertEquals(listViews(db)[0].unread, 0);
});

Deno.test('unread counts only what has arrived since the view was last opened', async () => {
	const db = openDb(':memory:');
	const view = createView(db, { name: 'CI', filter: { source: ['ci'] } });

	// last_seen_ts has millisecond resolution, so make sure the new posts really
	// do land after it rather than inside the same tick.
	await new Promise((r) => setTimeout(r, 5));

	insertPost(db, { source: 'ci', title: 'new one' });
	insertPost(db, { source: 'ci', title: 'new two' });
	insertPost(db, { source: 'other', title: 'not in this view' }); // must not count

	assertEquals(listViews(db)[0].unread, 2);

	// Opening the view clears the badge...
	markViewSeen(db, view.id);
	assertEquals(listViews(db)[0].unread, 0);

	// ...and it starts counting again from there.
	await new Promise((r) => setTimeout(r, 5));
	insertPost(db, { source: 'ci', title: 'newer' });
	assertEquals(listViews(db)[0].unread, 1);
});

Deno.test('pinned views sort first', () => {
	const db = openDb(':memory:');
	createView(db, { name: 'B', filter: {}, position: 1 });
	createView(db, { name: 'A', filter: {}, position: 2, pinned: true });

	assertEquals(listViews(db).map((v) => v.name), ['A', 'B']);
});

Deno.test('views can be renamed, refiltered and deleted', () => {
	const db = openDb(':memory:');
	const view = createView(db, { name: 'Old', filter: { source: ['ci'] } });

	const updated = updateView(db, view.id, { name: 'New', filter: { tag: ['deploy'] } });
	assertEquals(updated.name, 'New');
	assertEquals(updated.filter, { tag: ['deploy'] });

	// A partial patch leaves the rest alone.
	assertEquals(updateView(db, view.id, { pinned: true }).name, 'New');

	assertEquals(deleteView(db, view.id), true);
	assertEquals(deleteView(db, view.id), false); // already gone
	assertEquals(listViews(db).length, 0);
});

// --- mutes -----------------------------------------------------------------

Deno.test('a muted source is hidden from the timeline', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'noisy', title: 'be quiet' });
	insertPost(db, { source: 'ci', title: 'keep me' });

	const page = queryPosts(db, { exclude_source: ['noisy'] });
	assertEquals(page.posts.map((p) => p.title), ['keep me']);

	// Muting hides; it does not delete. The post is still there.
	assertEquals(countPosts(db), 2);
});

Deno.test('explicitly asking for a muted source still shows it', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'noisy', title: 'shown on request' });

	// Muting means "keep this out of my way by default", not "refuse to show it
	// even when I ask". A filter that returned nothing because the thing you
	// picked was muted would be baffling.
	const page = queryPosts(db, { source: ['noisy'], exclude_source: ['noisy'] });
	assertEquals(page.posts.length, 1);
});

Deno.test('a muted tag is hidden, and the carve-out works there too', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'a', title: 'noisy one', tags: ['chatter'] });
	insertPost(db, { source: 'a', title: 'quiet one', tags: ['deploy'] });

	assertEquals(queryPosts(db, { exclude_tag: ['chatter'] }).posts.map((p) => p.title), ['quiet one']);
	assertEquals(queryPosts(db, { tag: ['chatter'], exclude_tag: ['chatter'] }).posts.length, 1);
});

Deno.test('facets do not offer muted values', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'noisy', title: 'a' });
	insertPost(db, { source: 'ci', title: 'b' });

	const facets = queryFacets(db, { exclude_source: ['noisy'] });
	// The picker shouldn't invite you to filter by something you've muted...
	assertEquals(facets.source.map((f) => f.value), ['ci']);
});

// --- retention -------------------------------------------------------------

Deno.test('retention deletes only posts older than the window', () => {
	const db = openDb(':memory:');
	const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

	insertPost(db, { source: 'a', title: 'ancient', ts: daysAgo(40) });
	insertPost(db, { source: 'a', title: 'recent', ts: daysAgo(3) });

	assertEquals(sweepRetention(db, 30), 1);
	assertEquals(queryPosts(db, {}).posts.map((p) => p.title), ['recent']);
});

Deno.test('retention of 0 keeps everything', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'a', title: 'ancient', ts: '2020-01-01T00:00:00Z' });

	// The default. Silently deleting a developer's history is not a default.
	assertEquals(sweepRetention(db, 0), 0);
	assertEquals(countPosts(db), 1);
});

Deno.test('a swept post leaves nothing behind in the search index', () => {
	const db = openDb(':memory:');
	insertPost(db, { source: 'a', title: 'ancient secret', ts: '2020-01-01T00:00:00Z' });
	insertPost(db, { source: 'a', title: 'recent', tags: ['keep'] });

	sweepRetention(db, 30);

	// A stale FTS row would keep matching a post that no longer exists.
	assertEquals(queryPosts(db, { q: 'ancient' }).posts.length, 0);
	// ...and its tags must cascade away too.
	const tags = db.prepare('SELECT COUNT(*) AS n FROM post_tags').get() as unknown as { n: number };
	assertEquals(Number(tags.n), 1); // only the surviving post's
});

Deno.test('retention uses the event time, not when we heard about it', () => {
	const db = openDb(':memory:');
	// A post backfilled today about something that happened a year ago is a year
	// old -- that's what "keep the last 30 days" means to a human.
	insertPost(db, { source: 'a', title: 'backfilled', ts: '2025-01-01T00:00:00Z' });

	assertEquals(sweepRetention(db, 30), 1);
	assert(countPosts(db) === 0);
});
