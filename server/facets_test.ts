import { assertEquals } from '@std/assert';
import { openDb } from './db.ts';
import { insertPost, queryFacets } from './posts.ts';
import { getSettings, updateSettings } from './settings.ts';
import { ValidationError } from './posts.ts';
import { assertThrows } from '@std/assert';

function seeded() {
	const db = openDb(':memory:');
	insertPost(db, {
		source: 'ci',
		kind: 'alert',
		title: 'deploy failed',
		tags: ['deploy', 'failed'],
		meta: { project: 'dev-stream', repo: 'phin-tech/dev-stream' }
	});
	insertPost(db, {
		source: 'ci',
		kind: 'event',
		title: 'deploy ok',
		tags: ['deploy'],
		meta: { project: 'dev-stream', repo: 'phin-tech/dev-stream' }
	});
	insertPost(db, {
		source: 'github',
		kind: 'pr',
		title: 'opened a PR',
		tags: ['review'],
		meta: { project: 'other', repo: 'phin-tech/other' }
	});
	return db;
}

const values = (facets: { value: string; count: number }[]) =>
	Object.fromEntries(facets.map((f) => [f.value, f.count]));

Deno.test('facets count every dimension across the whole timeline', () => {
	const db = seeded();
	const facets = queryFacets(db, {});

	assertEquals(values(facets.source), { ci: 2, github: 1 });
	assertEquals(values(facets.kind), { alert: 1, event: 1, pr: 1 });
	assertEquals(values(facets.project), { 'dev-stream': 2, other: 1 });
	assertEquals(values(facets.repo), { 'phin-tech/dev-stream': 2, 'phin-tech/other': 1 });
	assertEquals(values(facets.tag), { deploy: 2, failed: 1, review: 1 });
});

Deno.test('a facet excludes its OWN dimension so the picker stays usable', () => {
	const db = seeded();
	// The user has picked source=ci.
	const facets = queryFacets(db, { source: ['ci'] });

	// Other sources must still be offered with their real counts -- otherwise you
	// could never widen the selection to also include github, only narrow it.
	assertEquals(values(facets.source), { ci: 2, github: 1 });

	// ...while every OTHER dimension is narrowed by the ci selection.
	assertEquals(values(facets.kind), { alert: 1, event: 1 }); // no 'pr': that's github's
	assertEquals(values(facets.tag), { deploy: 2, failed: 1 }); // no 'review'
	assertEquals(values(facets.project), { 'dev-stream': 2 });
});

Deno.test('facets respect the search box', () => {
	const db = seeded();
	const facets = queryFacets(db, { q: 'deploy' });

	assertEquals(values(facets.source), { ci: 2 });
	assertEquals(values(facets.tag), { deploy: 2, failed: 1 });
});

Deno.test('facets ignore the cursor: they describe the set, not the page', () => {
	const db = seeded();
	const unpaged = queryFacets(db, {});
	// A cursor deep into the feed must not shrink the filter bar's counts.
	const paged = queryFacets(db, { cursor: btoa('2026-01-01T00:00:00.000Z zzz') });

	assertEquals(values(paged.source), values(unpaged.source));
});

const DEFAULT_SETTINGS = { retention_days: 0, muted_sources: [], muted_tags: [] };

Deno.test('settings fall back to defaults on an empty database', () => {
	const db = openDb(':memory:');
	// Retention is opt-in: deleting a developer's history by default is hostile.
	assertEquals(getSettings(db), DEFAULT_SETTINGS);
});

Deno.test('settings round-trip and reject nonsense', () => {
	const db = openDb(':memory:');

	assertEquals(updateSettings(db, { retention_days: 30 }), { ...DEFAULT_SETTINGS, retention_days: 30 });
	// Persisted, and still typed as a number rather than the string it was stored as.
	assertEquals(getSettings(db).retention_days, 30);

	assertThrows(() => updateSettings(db, { retention_days: -1 }), ValidationError);
	assertThrows(() => updateSettings(db, { retention_days: 1.5 }), ValidationError);
	assertThrows(() => updateSettings(db, { retention_days: 'lots' }), ValidationError);
	assertThrows(() => updateSettings(db, { muted_sources: 'ci' }), ValidationError);
	assertThrows(() => updateSettings(db, { nonsense: true }), ValidationError, 'unknown setting');

	// A rejected update must not have partially applied.
	assertEquals(getSettings(db).retention_days, 30);

	// A partial patch leaves the other keys alone.
	assertEquals(updateSettings(db, { muted_sources: ['noisy'] }).retention_days, 30);
	assertEquals(getSettings(db).muted_sources, ['noisy']);
});
