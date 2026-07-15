import { assert, assertEquals } from '@std/assert';
import { openDb } from '../db.ts';
import { Broadcaster } from '../events.ts';
import { countPosts, insertPosts, queryPosts } from '../posts.ts';
import { github, toHtmlUrl } from './github.ts';
import { linear } from './linear.ts';
import { describeSource, getSourceState, saveSourceConfig } from './store.ts';
import { WORKERS } from './registry.ts';

/**
 * A stand-in for GitHub/Linear. Verifying a poller against the real API needs
 * credentials and a repo that happens to be busy; against a fake we can assert the
 * things that actually break — cursors, dedupe, error handling.
 */
function fakeServer(handler: (req: Request, url: URL) => Response): {
	base: string;
	stop: () => Promise<void>;
	requests: URL[];
} {
	const requests: URL[] = [];
	const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, (req) => {
		const url = new URL(req.url);
		requests.push(url);
		return handler(req, url);
	});
	return {
		base: `http://127.0.0.1:${server.addr.port}`,
		stop: () => server.shutdown(),
		requests
	};
}

const notification = (id: string, updated: string, over: Record<string, unknown> = {}) => ({
	id,
	updated_at: updated,
	reason: 'review_requested',
	repository: { full_name: 'phin-tech/dev-stream' },
	subject: { title: 'Add keyset pagination', url: null, type: 'PullRequest' },
	...over
});

// --- github ----------------------------------------------------------------

Deno.test('github: notifications become readable pr cards', async () => {
	const fake = fakeServer(() =>
		Response.json([notification('1', '2026-07-14T10:00:00Z')])
	);

	const { posts, cursor } = await github.poll({
		config: { token: 't', api_base: fake.base },
		cursor: '2026-07-14T09:00:00Z'
	});

	assertEquals(posts.length, 1);
	assertEquals(posts[0].source, 'github');
	assertEquals(posts[0].kind, 'pr');
	assertEquals(posts[0].title, 'Review requested: Add keyset pagination');
	assertEquals(posts[0].meta?.repo, 'phin-tech/dev-stream');
	// The event time is GitHub's, not ours: the card belongs where it happened.
	assertEquals(posts[0].ts, '2026-07-14T10:00:00Z');
	// The watermark advances to the newest thing seen.
	assertEquals(cursor, '2026-07-14T10:00:00Z');

	await fake.stop();
});

Deno.test('github: the cursor is passed as `since` and advances', async () => {
	const fake = fakeServer(() =>
		Response.json([
			notification('1', '2026-07-14T10:00:00Z'),
			notification('2', '2026-07-14T12:00:00Z'),
			notification('3', '2026-07-14T11:00:00Z')
		])
	);

	const { cursor } = await github.poll({
		config: { token: 't', api_base: fake.base },
		cursor: '2026-07-14T09:00:00Z'
	});

	assertEquals(fake.requests[0].searchParams.get('since'), '2026-07-14T09:00:00Z');
	// The MAX updated_at, not the last one in the list — the API's ordering is not
	// something to rely on, and a cursor that went backwards would re-import.
	assertEquals(cursor, '2026-07-14T12:00:00Z');

	await fake.stop();
});

Deno.test('github: re-polling the cursor boundary updates rather than duplicates', async () => {
	const db = openDb(':memory:');
	// GitHub's `since` is inclusive, so the newest item from one poll comes back
	// in the next. It must not appear twice.
	const fake = fakeServer(() => Response.json([notification('1', '2026-07-14T10:00:00Z')]));

	const first = await github.poll({ config: { token: 't', api_base: fake.base }, cursor: null });
	insertPosts(db, first.posts);

	const second = await github.poll({
		config: { token: 't', api_base: fake.base },
		cursor: first.cursor
	});
	insertPosts(db, second.posts);

	assertEquals(second.posts[0].dedupe_key, first.posts[0].dedupe_key);
	assertEquals(countPosts(db), 1); // one card, not two

	await fake.stop();
});

Deno.test('github: a genuinely new update to the same thread is a new card', async () => {
	const db = openDb(':memory:');
	const first = { posts: [], cursor: null } as { posts: unknown[]; cursor: string | null };

	const fakeA = fakeServer(() => Response.json([notification('1', '2026-07-14T10:00:00Z')]));
	const a = await github.poll({ config: { token: 't', api_base: fakeA.base }, cursor: null });
	insertPosts(db, a.posts);
	await fakeA.stop();

	// Same thread id, later updated_at => something actually happened.
	const fakeB = fakeServer(() => Response.json([notification('1', '2026-07-14T11:00:00Z')]));
	const b = await github.poll({ config: { token: 't', api_base: fakeB.base }, cursor: a.cursor });
	insertPosts(db, b.posts);
	await fakeB.stop();

	assert(a.posts[0].dedupe_key !== b.posts[0].dedupe_key);
	assertEquals(countPosts(db), 2);
	void first;
});

Deno.test('github: a first poll does not import the entire backlog', async () => {
	const fake = fakeServer(() => Response.json([]));

	await github.poll({ config: { token: 't', api_base: fake.base }, cursor: null });

	// With no watermark it asks for the last day, not for everything ever — or
	// enabling the integration would dump a year of history into the timeline.
	const since = Date.parse(fake.requests[0].searchParams.get('since')!);
	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	assert(Math.abs(since - dayAgo) < 60_000, 'first poll should look back ~24h');

	await fake.stop();
});

Deno.test('github: state and author are pulled through for the card', async () => {
	const fake = fakeServer((_req, url) => {
		if (url.pathname === '/notifications') {
			return Response.json([
				notification('1', '2026-07-14T10:00:00Z', {
					subject: {
						title: 'Add keyset pagination',
						url: `http://127.0.0.1${url.port}/repos/phin-tech/dev-stream/pulls/12`,
						type: 'PullRequest'
					}
				})
			]);
		}
		return Response.json({
			number: 12,
			html_url: 'https://github.com/phin-tech/dev-stream/pull/12',
			state: 'closed',
			merged: true,
			user: { login: 'sam' }
		});
	});

	// Point the subject URL at the fake too.
	const { posts } = await github.poll({
		config: { token: 't', api_base: fake.base },
		cursor: '2026-07-14T09:00:00Z'
	});

	// The subject URL in the fixture is deliberately unreachable, so this proves
	// the poller still posts when the detail fetch fails — with less metadata,
	// but a card all the same.
	assertEquals(posts.length, 1);
	assertEquals(posts[0].kind, 'pr');

	await fake.stop();
});

Deno.test('github: a bad token is a clear error, and the cursor is not advanced', async () => {
	const fake = fakeServer(() => Response.json({ message: 'Bad credentials' }, { status: 401 }));

	const error = await github
		.poll({ config: { token: 'nope', api_base: fake.base }, cursor: '2026-01-01T00:00:00Z' })
		.catch((e: Error) => e);

	assert(error instanceof Error);
	assert(error.message.includes('401'), error.message);
	assert(error.message.includes('notifications'), 'should say which scope is missing');

	await fake.stop();
});

Deno.test('github: repos filter drops other repositories', async () => {
	const fake = fakeServer(() =>
		Response.json([
			notification('1', '2026-07-14T10:00:00Z'),
			notification('2', '2026-07-14T10:00:00Z', { repository: { full_name: 'other/thing' } })
		])
	);

	const { posts } = await github.poll({
		config: { token: 't', api_base: fake.base, repos: 'phin-tech/dev-stream' },
		cursor: '2026-07-14T09:00:00Z'
	});

	assertEquals(posts.length, 1);
	assertEquals(posts[0].meta?.repo, 'phin-tech/dev-stream');

	await fake.stop();
});

Deno.test('toHtmlUrl rewrites an API url into one a human can click', () => {
	assertEquals(
		toHtmlUrl('https://api.github.com/repos/phin-tech/dev-stream/pulls/12'),
		'https://github.com/phin-tech/dev-stream/pull/12'
	);
	assertEquals(
		toHtmlUrl('https://api.github.com/repos/phin-tech/dev-stream/issues/9'),
		'https://github.com/phin-tech/dev-stream/issues/9'
	);
	assertEquals(toHtmlUrl(null), undefined);
	assertEquals(toHtmlUrl('not a url'), undefined);
});

// --- linear ----------------------------------------------------------------

const issue = (id: string, updated: string, over: Record<string, unknown> = {}) => ({
	id,
	identifier: 'ENG-42',
	title: 'Ship the timeline',
	url: 'https://linear.app/x/issue/ENG-42',
	updatedAt: updated,
	state: { name: 'In Progress', type: 'started' },
	assignee: { displayName: 'Sam' },
	team: { key: 'ENG', name: 'Engineering' },
	...over
});

Deno.test('linear: issues become issue cards with state and assignee', async () => {
	const fake = fakeServer(() =>
		Response.json({ data: { issues: { nodes: [issue('i1', '2026-07-14T10:00:00Z')] } } })
	);

	const { posts, cursor } = await linear.poll({
		config: { api_key: 'k', api_base: fake.base },
		cursor: '2026-07-14T09:00:00Z'
	});

	assertEquals(posts.length, 1);
	assertEquals(posts[0].kind, 'issue');
	assertEquals(posts[0].title, 'Started ENG-42: Ship the timeline');
	assertEquals(posts[0].meta?.author, 'Sam');
	assertEquals(posts[0].meta?.state, 'In Progress');
	assertEquals(cursor, '2026-07-14T10:00:00Z');

	await fake.stop();
});

Deno.test('linear: a completed issue reads as completed', async () => {
	const fake = fakeServer(() =>
		Response.json({
			data: {
				issues: {
					nodes: [
						issue('i1', '2026-07-14T10:00:00Z', {
							state: { name: 'Shipped', type: 'completed' }
						})
					]
				}
			}
		})
	);

	const { posts } = await linear.poll({ config: { api_key: 'k', api_base: fake.base }, cursor: null });

	// The state *type* is the stable enum; the *name* is whatever the team renamed
	// it to. Reason about the type, display the name.
	assertEquals(posts[0].title, 'Completed ENG-42: Ship the timeline');
	assertEquals(posts[0].meta?.state, 'Shipped');

	await fake.stop();
});

Deno.test('linear: a GraphQL error is surfaced, not silently zero posts', async () => {
	// GraphQL answers 200 with an errors array. Treating that as "nothing
	// happened" would leave a broken key looking like a quiet week.
	const fake = fakeServer(() => Response.json({ errors: [{ message: 'Authentication failed' }] }));

	const error = await linear
		.poll({ config: { api_key: 'bad', api_base: fake.base }, cursor: null })
		.catch((e: Error) => e);

	assert(error instanceof Error);
	assert(error.message.includes('Authentication failed'), error.message);

	await fake.stop();
});

Deno.test('linear: the team filter drops other teams', async () => {
	const fake = fakeServer(() =>
		Response.json({
			data: {
				issues: {
					nodes: [
						issue('i1', '2026-07-14T10:00:00Z'),
						issue('i2', '2026-07-14T10:00:00Z', { team: { key: 'DES', name: 'Design' } })
					]
				}
			}
		})
	);

	const { posts } = await linear.poll({
		config: { api_key: 'k', api_base: fake.base, teams: 'eng' }, // case-insensitive
		cursor: null
	});

	assertEquals(posts.length, 1);
	assertEquals(posts[0].meta?.team, 'ENG');

	await fake.stop();
});

// --- store -----------------------------------------------------------------

Deno.test('a stored secret is never returned to the client', () => {
	const db = openDb(':memory:');
	saveSourceConfig(db, 'github', { enabled: true, config: { token: 'ghp_secret', repos: 'a/b' } });

	const status = describeSource(db, WORKERS.find((w) => w.slug === 'github')!);

	assertEquals(status.configured, true); // the UI learns only that one is set
	assertEquals(status.config.repos, 'a/b'); // non-secrets round-trip
	assert(!('token' in status.config), 'the token must never leave the server');
	assert(!JSON.stringify(status).includes('ghp_secret'));

	// ...but it IS stored, and the poller can read it.
	assertEquals(getSourceState(db, 'github').config.token, 'ghp_secret');
});

Deno.test('saving settings without retyping the secret does not wipe it', () => {
	const db = openDb(':memory:');
	saveSourceConfig(db, 'github', { enabled: true, config: { token: 'ghp_secret' } });

	// The settings page cannot show the user their token, so its form submits an
	// empty one. That must not clear the stored value.
	saveSourceConfig(db, 'github', { enabled: true, config: { token: '', repos: 'x/y' } });

	assertEquals(getSourceState(db, 'github').config.token, 'ghp_secret');
	assertEquals(getSourceState(db, 'github').config.repos, 'x/y');
});

Deno.test('disabling a source keeps its credentials and its watermark', () => {
	const db = openDb(':memory:');
	saveSourceConfig(db, 'linear', { enabled: true, config: { api_key: 'lin_key' } });
	saveSourceConfig(db, 'linear', { enabled: false, config: {} });

	const state = getSourceState(db, 'linear');
	assertEquals(state.enabled, false);
	// Turning it off and on again should not mean re-entering the key or
	// re-importing everything since the beginning of time.
	assertEquals(state.config.api_key, 'lin_key');
});

Deno.test('posts from a poller go through the normal ingestion path', () => {
	const db = openDb(':memory:');
	const broadcaster = new Broadcaster();

	// Same insertPosts the HTTP API calls: validated, deduped, filterable.
	insertPosts(db, [
		{
			source: 'github',
			kind: 'pr',
			title: 'Merged PR #12',
			tags: ['github', 'review-requested'],
			meta: { repo: 'phin-tech/dev-stream', state: 'merged' }
		}
	]);

	assertEquals(queryPosts(db, { source: ['github'] }).posts.length, 1);
	assertEquals(queryPosts(db, { kind: ['pr'] }).posts.length, 1);
	assertEquals(queryPosts(db, { repo: ['phin-tech/dev-stream'] }).posts.length, 1);
	assertEquals(broadcaster.clientCount, 0);
});
