import { assert, assertEquals } from '@std/assert';
import { createApiHandler } from './api.ts';
import { openDb } from './db.ts';
import { Broadcaster } from './events.ts';
import type { Post, PostPage, ServerInfo, SourceStatus, StreamEvent } from '../src/shared/types.ts';

const TOKEN = 'test-token';

/**
 * Exercises the handler directly rather than over a socket: same code path a
 * real request takes, minus the port. Network-level behaviour is covered by the
 * end-to-end curl script.
 */
function harness(
	onFocusRequest?: () => void,
	install?: (url: string) => Promise<SourceStatus>,
	openExternal?: (url: string) => Promise<void>
) {
	const db = openDb(':memory:');
	const broadcaster = new Broadcaster();
	const info: ServerInfo = {
		app: 'dev-stream',
		version: 'test',
		pid: 1,
		port: 4517,
		started_at: new Date().toISOString()
	};
	const handle = createApiHandler({
		db, broadcaster, token: TOKEN, info, dbPath: ':memory:', onFocusRequest,
		plugins: install ? {
			install,
			listRegistry: () => Promise.resolve([]),
			installRegistry: () => Promise.reject(new Error('not configured'))
		} : undefined,
		openExternal
	});

	const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
		handle(
			new Request(`http://127.0.0.1:4517${path}`, {
				method,
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(body ? { 'content-type': 'application/json' } : {})
				},
				body: body === undefined ? undefined : JSON.stringify(body)
			})
		);

	return { db, broadcaster, call };
}

Deno.test('external links are validated and delegated to the desktop shell', async () => {
	const opened: string[] = [];
	const { call } = harness(undefined, undefined, (url) => {
		opened.push(url);
		return Promise.resolve();
	});

	const response = await call('POST', '/api/open-external', { url: 'https://example.com/story?q=1' });
	assertEquals(response.status, 200);
	assertEquals(opened, ['https://example.com/story?q=1']);
	assertEquals((await call('POST', '/api/open-external', { url: 'javascript:alert(1)' })).status, 400);
	assertEquals(opened.length, 1);
});

Deno.test('installing a GitHub plugin delegates to the installer and returns the source', async () => {
	const urls: string[] = [];
	const installed = {
		slug: 'github', label: 'GitHub', origin: 'plugin' as const, trusted: false,
		enabled: false, configured: false, fields: [], config: {}, cursor: null,
		last_error: null, last_polled_at: null
	};
	const { call } = harness(undefined, (url) => {
		urls.push(url);
		return Promise.resolve(installed);
	});

	const response = await call('POST', '/api/plugins/install', {
		url: 'https://github.com/phin-tech/dev-stream-plugins/tree/main/github'
	});
	assertEquals(response.status, 201);
	assertEquals(await response.json(), installed);
	assertEquals(urls, ['https://github.com/phin-tech/dev-stream-plugins/tree/main/github']);
});

Deno.test('health is unauthenticated and identifies the app', async () => {
	const { call } = harness();
	// The single-instance guard and the CLI both probe this before they hold a
	// token, so requiring auth here would break discovery.
	const res = await call('GET', '/api/health', undefined, null);

	assertEquals(res.status, 200);
	const body = await res.json();
	assertEquals(body.status, 'ok');
	assertEquals(body.app, 'dev-stream');
});

Deno.test('every other route requires the bearer token', async () => {
	const { call } = harness();

	assertEquals((await call('GET', '/api/posts', undefined, null)).status, 401);
	assertEquals((await call('GET', '/api/posts', undefined, 'wrong-token')).status, 401);
	assertEquals((await call('POST', '/api/posts', { source: 'a', title: 'x' }, null)).status, 401);
	assertEquals((await call('GET', '/api/events', undefined, null)).status, 401);

	// A rejected write must not have landed.
	const page = (await (await call('GET', '/api/posts')).json()) as PostPage;
	assertEquals(page.posts.length, 0);
});

Deno.test('posting a single object returns the created post', async () => {
	const { call } = harness();
	const res = await call('POST', '/api/posts', {
		source: 'claude-code',
		title: 'Edited +page.svelte',
		tags: ['hooks'],
		meta: { project: 'dev-stream' }
	});

	assertEquals(res.status, 201);
	const post = (await res.json()) as Post;
	assertEquals(post.source, 'claude-code');
	assertEquals(post.tags, ['hooks']);
	assert(post.id);
});

Deno.test('posting accepts a bare array and a {posts:[...]} envelope', async () => {
	const { call } = harness();

	const arrayRes = await call('POST', '/api/posts', [
		{ source: 'a', title: 'one' },
		{ source: 'a', title: 'two' }
	]);
	assertEquals(arrayRes.status, 201);
	assertEquals((await arrayRes.json()).posts.length, 2);

	const envelopeRes = await call('POST', '/api/posts', { posts: [{ source: 'a', title: 'three' }] });
	assertEquals(envelopeRes.status, 201);
	assertEquals((await envelopeRes.json()).posts.length, 1);

	const page = (await (await call('GET', '/api/posts')).json()) as PostPage;
	assertEquals(page.posts.length, 3);
});

Deno.test('a malformed post is a 400 and writes nothing', async () => {
	const { call } = harness();

	assertEquals((await call('POST', '/api/posts', { title: 'no source' })).status, 400);
	assertEquals((await call('POST', '/api/posts', { source: 'a' })).status, 400);

	// A batch is all-or-nothing: the valid post ahead of the bad one must not
	// survive, or a client retrying the batch would duplicate it.
	const res = await call('POST', '/api/posts', [{ source: 'a', title: 'good' }, { source: 'a' }]);
	assertEquals(res.status, 400);

	const page = (await (await call('GET', '/api/posts')).json()) as PostPage;
	assertEquals(page.posts.length, 0);
});

Deno.test('invalid JSON is a 400, not a 500', async () => {
	const { db, broadcaster } = harness();
	const info: ServerInfo = {
		app: 'dev-stream',
		version: 'test',
		pid: 1,
		port: 4517,
		started_at: new Date().toISOString()
	};
	const handle = createApiHandler({ db, broadcaster, token: TOKEN, info, dbPath: ':memory:' });

	const res = await handle(
		new Request('http://127.0.0.1:4517/api/posts', {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
			body: '{ not json'
		})
	);
	assertEquals(res.status, 400);
});

Deno.test('query params map onto filters', async () => {
	const { call } = harness();
	await call('POST', '/api/posts', [
		{ source: 'ci', kind: 'alert', title: 'deploy failed', tags: ['deploy', 'failed'] },
		{ source: 'github', kind: 'pr', title: 'opened a PR', meta: { repo: 'phin-tech/dev-stream' } }
	]);

	const get = async (qs: string) =>
		((await (await call('GET', `/api/posts?${qs}`)).json()) as PostPage).posts;

	assertEquals((await get('source=ci')).length, 1);
	assertEquals((await get('kind=pr')).length, 1);
	assertEquals((await get('repo=phin-tech/dev-stream')).length, 1);
	assertEquals((await get('q=deploy')).length, 1);
	// Repeated params and comma lists are both accepted (curl ergonomics).
	assertEquals((await get('source=ci&source=github')).length, 2);
	assertEquals((await get('source=ci,github')).length, 2);
	// Multiple tags are AND-ed.
	assertEquals((await get('tag=deploy&tag=failed')).length, 1);
	assertEquals((await get('tag=deploy&tag=missing')).length, 0);
});

Deno.test('a bad limit is rejected', async () => {
	const { call } = harness();
	assertEquals((await call('GET', '/api/posts?limit=0')).status, 400);
	assertEquals((await call('GET', '/api/posts?limit=abc')).status, 400);
});

Deno.test('an unknown post id is a 404', async () => {
	const { call } = harness();
	assertEquals((await call('GET', '/api/posts/nope')).status, 404);
});

Deno.test('a post can be marked seen, unread again, and 404s an unknown id', async () => {
	const { call } = harness();
	const created = (await (await call('POST', '/api/posts', { source: 'ci', title: 'a build' })).json()) as Post;

	// Fresh out of the box, unseen...
	assertEquals(((await (await call('GET', '/api/posts')).json()) as PostPage).posts[0].seen, false);

	// ...marking it seen is reflected on the next read...
	const seen = (await (await call('POST', `/api/posts/${created.id}/seen`)).json()) as Post;
	assertEquals(seen.seen, true);
	assertEquals(((await (await call('GET', '/api/posts')).json()) as PostPage).posts[0].seen, true);

	// ...and marking it unread reverses it.
	const unseen = (await (await call('POST', `/api/posts/${created.id}/unseen`)).json()) as Post;
	assertEquals(unseen.seen, false);

	// An id that isn't in the timeline is a 404 rather than a stray marker.
	assertEquals((await call('POST', '/api/posts/nope/seen')).status, 404);
});

Deno.test('mark-all-seen clears the filtered set and reports the count', async () => {
	const { call } = harness();
	await call('POST', '/api/posts', [
		{ source: 'ci', title: 'ci one' },
		{ source: 'ci', title: 'ci two' },
		{ source: 'linear', title: 'unrelated' }
	]);

	// The body is the active filter, so only CI is cleared.
	const res = await call('POST', '/api/seen', { source: ['ci'] });
	assertEquals(res.status, 200);
	assertEquals((await res.json()).marked, 2);

	const ci = ((await (await call('GET', '/api/posts?source=ci')).json()) as PostPage).posts;
	assertEquals(ci.every((p) => p.seen), true);
	const linear = ((await (await call('GET', '/api/posts?source=linear')).json()) as PostPage).posts;
	assertEquals(linear[0].seen, false);

	// An empty body means "the whole timeline".
	assertEquals((await (await call('POST', '/api/seen', {})).json()).marked, 1);
});

Deno.test('CORS preflight is answered', async () => {
	const { call } = harness();
	// WKWebView sends this before the page's JSON POST; a 404 here surfaces in
	// the page as the opaque "TypeError: Load failed".
	const res = await call('OPTIONS', '/api/posts', undefined, null);

	assertEquals(res.status, 204);
	assertEquals(res.headers.get('access-control-allow-origin'), '*');
	assert(res.headers.get('access-control-allow-headers')?.includes('authorization'));
	assert(res.headers.get('access-control-allow-methods')?.includes('PUT'));
});

Deno.test('a second launch can ask the running instance to focus', async () => {
	let focused = false;
	const { call } = harness(() => {
		focused = true;
	});

	const res = await call('POST', '/api/window/focus');
	assertEquals(res.status, 200);
	assertEquals(focused, true);
});

Deno.test('SSE streams new posts to a subscriber', async () => {
	const { db, broadcaster, call } = harness();
	const info: ServerInfo = {
		app: 'dev-stream',
		version: 'test',
		pid: 1,
		port: 4517,
		started_at: new Date().toISOString()
	};
	const handle = createApiHandler({ db, broadcaster, token: TOKEN, info, dbPath: ':memory:' });

	const controller = new AbortController();
	const res = await handle(
		new Request('http://127.0.0.1:4517/api/events', {
			// Query-param token: EventSource cannot set an Authorization header,
			// so this is the only way the webview can subscribe.
			headers: {},
			signal: controller.signal
		}).clone()
	);
	assertEquals(res.status, 401); // ...but only with a token.

	const authed = await handle(
		new Request(`http://127.0.0.1:4517/api/events?token=${TOKEN}`, { signal: controller.signal })
	);
	assertEquals(authed.status, 200);
	assertEquals(authed.headers.get('content-type'), 'text/event-stream');

	const reader = authed.body!.getReader();
	const decoder = new TextDecoder();

	// The stream opens with a hello frame naming the server.
	const hello = decoder.decode((await reader.read()).value);
	assert(hello.startsWith('event: hello'), hello);

	await call('POST', '/api/posts', { source: 'ci', title: 'live post' });

	const frame = decoder.decode((await reader.read()).value);
	assert(frame.startsWith('event: post'), frame);
	const event = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as StreamEvent;
	assert(event.type === 'post');
	assertEquals(event.post.title, 'live post');
	assertEquals(event.deduped, false);

	controller.abort();
	await reader.cancel();
	// The subscriber is dropped on abort; a leak here would grow unboundedly as
	// the webview reloads.
	await new Promise((r) => setTimeout(r, 10));
	assertEquals(broadcaster.clientCount, 0);
});
