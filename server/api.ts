/**
 * The ingestion API: the one surface everything writes through.
 *
 * The CLI, Claude hooks, the MCP server, source plugins and the UI are all
 * just HTTP clients of this. That is the point -- it's what lets anything post to
 * the timeline without a plugin, and it means there is exactly one place where
 * posts get validated, deduped and broadcast.
 */

import type { Db } from './db.ts';
import type { PostQuery, ServerInfo, SettingsInfo, SourceStatus, StreamEvent } from '../src/shared/types.ts';
import { countPosts, getPost, insertPosts, queryFacets, queryPosts, ValidationError } from './posts.ts';
import { markAllSeen, markSeen, markUnseen } from './seen.ts';
import { getSettings, updateSettings } from './settings.ts';
import { createView, deleteView, listViews, markViewSeen, updateView } from './views.ts';
import { listSources, saveSourceConfig, setSourceTrust } from './sources/store.ts';
import { Broadcaster } from './events.ts';
import { regenerateToken, tokenMatches } from './config.ts';
import { diag } from './diag.ts';

diag('EVAL server/api.ts body');

export interface ApiOptions {
	db: Db;
	broadcaster: Broadcaster;
	token: string;
	info: ServerInfo;
	/** Shown on the settings page; the UI can't read the filesystem itself. */
	dbPath: string;
	/** Called when a second launch asks the running instance to come forward. */
	onFocusRequest?: () => void;
	/** Opens a validated external URL using the desktop shell. */
	openExternal?: (url: string) => Promise<void>;
	/** The integration poll loop, so settings changes take effect immediately. */
	sources?: {
		sync(): void;
		pollNow(slug: string): Promise<{ posts: number; error?: string }>;
	};
	plugins?: {
		install(url: string): Promise<SourceStatus>;
	};
}

/**
 * `*` is safe here only because the bearer token is the actual guard.
 *
 * The webview page is served from the framework's own random port, so every call
 * it makes to this server is cross-origin and WKWebView enforces CORS exactly
 * like Safari (a missing header surfaces as the opaque "TypeError: Load failed",
 * which cost us a day in Phase 0). We can't enumerate the allowed origin ahead of
 * time because that port changes per launch. `*` also forbids credentialed
 * requests by spec, so no browser will ever attach cookies here -- a hostile web
 * page can reach the port but cannot read a response without the token.
 */
const CORS_HEADERS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
	'access-control-allow-headers': 'content-type, authorization',
	'access-control-max-age': '86400'
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: CORS_HEADERS });
}

function error(status: number, message: string): Response {
	return json({ error: message }, status);
}

export function createApiHandler(opts: ApiOptions): (req: Request) => Promise<Response> {
	const { db, broadcaster, info } = opts;

	// Mutable: POST /api/token/regenerate rotates it in place, so the running
	// server starts honouring the new token without a restart.
	let token = opts.token;

	/**
	 * The query param is not laziness: `EventSource` cannot set request headers,
	 * so an in-page SSE subscription has no way to send `Authorization`. Scoped
	 * to GET /api/events for exactly that reason; everything else is header-only,
	 * which keeps the token out of shell history and process listings.
	 */
	const authorize = (req: Request, url: URL, allowQueryToken = false): boolean => {
		const header = req.headers.get('authorization');
		if (header?.startsWith('Bearer ')) {
			return tokenMatches(token, header.slice('Bearer '.length).trim());
		}
		if (allowQueryToken) {
			const given = url.searchParams.get('token');
			if (given) return tokenMatches(token, given);
		}
		return false;
	};

	/** Repeatable params: `?tag=a&tag=b`, plus `?tag=a,b` for shell ergonomics. */
	const list = (url: URL, key: string): string[] | undefined => {
		const values = url.searchParams
			.getAll(key)
			.flatMap((v) => v.split(','))
			.map((v) => v.trim())
			.filter(Boolean);
		return values.length ? values : undefined;
	};

	/**
	 * The single mapping from query params to a filter, shared by /api/posts and
	 * /api/facets. Keeping it in one place is what makes a saved view a literal
	 * serialized query: the same params mean the same thing everywhere.
	 *
	 * Mutes are layered on here rather than sent by the client, because muting is a
	 * property of the timeline, not of a request -- the CLI's `tail` and a curl
	 * should honour it too, without knowing it exists.
	 */
	const filterFromUrl = (url: URL): PostQuery => {
		const settings = getSettings(db);
		return {
			source: list(url, 'source'),
			project: list(url, 'project'),
			repo: list(url, 'repo'),
			kind: list(url, 'kind'),
			tag: list(url, 'tag'),
			q: url.searchParams.get('q') ?? undefined,
			since: url.searchParams.get('since') ?? undefined,
			until: url.searchParams.get('until') ?? undefined,
			cursor: url.searchParams.get('cursor') ?? undefined,
			exclude_source: settings.muted_sources,
			exclude_tag: settings.muted_tags
		};
	};

	return async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;

		if (req.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// Unauthenticated by design: this is the discovery + liveness probe that
		// the CLI and the single-instance guard use to answer "is dev-stream
		// already on this port?" before they hold a token. It exposes nothing
		// the caller couldn't learn from the process list.
		if (path === '/api/health' && req.method === 'GET') {
			return json({ status: 'ok', ...info } satisfies { status: string } & ServerInfo);
		}

		if (path === '/api/events' && req.method === 'GET') {
			if (!authorize(req, url, true)) return error(401, 'unauthorized');
			const hello: StreamEvent = { type: 'hello', server: info };
			return broadcaster.subscribe(hello, req.signal);
		}

		if (!authorize(req, url)) return error(401, 'unauthorized');

		if (path === '/api/posts' && req.method === 'POST') {
			return handlePost(req);
		}

		if (path === '/api/posts' && req.method === 'GET') {
			const query = filterFromUrl(url);
			const rawLimit = url.searchParams.get('limit');
			if (rawLimit !== null) {
				const limit = Number.parseInt(rawLimit, 10);
				if (!Number.isInteger(limit) || limit < 1) return error(400, 'limit must be a positive integer');
				query.limit = limit;
			}

			try {
				return json(queryPosts(db, query));
			} catch (err) {
				if (err instanceof ValidationError) return error(400, err.message);
				throw err;
			}
		}

		const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
		if (postMatch && req.method === 'GET') {
			const post = getPost(db, decodeURIComponent(postMatch[1]));
			return post ? json(post) : error(404, 'post not found');
		}

		// Mark every post matching the given filter as seen ("mark all as read").
		// The filter arrives as a PostFilter body -- the timeline's active filter --
		// so clearing while a view is open clears only that view. Mutes are layered
		// on here, never trusted from the client, exactly as GET /api/posts does.
		if (path === '/api/seen' && req.method === 'POST') {
			const settings = getSettings(db);
			let body: unknown = {};
			if (req.headers.get('content-type')?.includes('application/json')) {
				try {
					body = await req.json();
				} catch {
					return error(400, 'body must be valid JSON');
				}
			}
			if (typeof body !== 'object' || body === null || Array.isArray(body)) {
				return error(400, 'filter must be a JSON object');
			}
			const query: PostQuery = {
				...(body as PostQuery),
				exclude_source: settings.muted_sources,
				exclude_tag: settings.muted_tags
			};
			try {
				return json({ marked: markAllSeen(db, query) });
			} catch (err) {
				if (err instanceof ValidationError) return error(400, err.message);
				throw err;
			}
		}

		// Toggle one post's read state. Returns the post so the client can sync,
		// and 404s an id that isn't in the timeline rather than leaving a marker.
		const seenPostMatch = path.match(/^\/api\/posts\/([^/]+)\/(seen|unseen)$/);
		if (seenPostMatch && req.method === 'POST') {
			const id = decodeURIComponent(seenPostMatch[1]);
			if (!getPost(db, id)) return error(404, 'post not found');
			if (seenPostMatch[2] === 'seen') markSeen(db, id);
			else markUnseen(db, id);
			return json(getPost(db, id));
		}

		// Populates the filter bar. Takes the same query params as GET /api/posts,
		// so the UI can ask "given what I've already picked, what's left?"
		if (path === '/api/facets' && req.method === 'GET') {
			try {
				return json(queryFacets(db, filterFromUrl(url)));
			} catch (err) {
				if (err instanceof ValidationError) return error(400, err.message);
				throw err;
			}
		}

		if (path === '/api/settings' && req.method === 'GET') {
			return json({
				...getSettings(db),
				db_path: opts.dbPath,
				port: info.port,
				post_count: countPosts(db)
			} satisfies SettingsInfo);
		}

		if (path === '/api/settings' && req.method === 'PUT') {
			let patch: unknown;
			try {
				patch = await req.json();
			} catch {
				return error(400, 'body must be valid JSON');
			}
			try {
				return json(updateSettings(db, patch));
			} catch (err) {
				if (err instanceof ValidationError) return error(400, err.message);
				throw err;
			}
		}

		// Returns the new token, because the caller (the settings page) is about to
		// need it: its own next request must already carry the rotated value.
		if (path === '/api/token/regenerate' && req.method === 'POST') {
			token = await regenerateToken();
			return json({ token });
		}

		// --- saved views ------------------------------------------------------
		if (path === '/api/views' && req.method === 'GET') {
			const settings = getSettings(db);
			// Unread counts must respect mutes, or a muted source would keep
			// bumping a badge for posts the user has said they don't want to see.
			return json({
				views: listViews(db, {
					exclude_source: settings.muted_sources,
					exclude_tag: settings.muted_tags
				})
			});
		}

		if (path === '/api/views' && req.method === 'POST') {
			return await withJsonBody(req, (body) => json(createView(db, body), 201));
		}

		const viewMatch = path.match(/^\/api\/views\/([^/]+)$/);
		if (viewMatch) {
			const id = decodeURIComponent(viewMatch[1]);

			if (req.method === 'PATCH') {
				return await withJsonBody(req, (body) => json(updateView(db, id, body)));
			}
			if (req.method === 'DELETE') {
				return deleteView(db, id) ? json({ deleted: true }) : error(404, 'view not found');
			}
		}

		// --- integrations -----------------------------------------------------
		if (path === '/api/sources' && req.method === 'GET') {
			return json({ sources: listSources(db) });
		}

		if (path === '/api/plugins/install' && req.method === 'POST') {
			if (!opts.plugins) return error(503, 'plugin installation is not available');
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return error(400, 'body must be valid JSON');
			}
			const url = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : undefined;
			if (typeof url !== 'string' || !url.trim()) return error(400, 'url is required');
			try {
				return json(await opts.plugins.install(url.trim()), 201);
			} catch (err) {
				return error(400, err instanceof Error ? err.message : String(err));
			}
		}

		if (path === '/api/open-external' && req.method === 'POST') {
			if (!opts.openExternal) return error(503, 'external URL opening is not available');
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return error(400, 'body must be valid JSON');
			}
			const raw = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : undefined;
			if (typeof raw !== 'string') return error(400, 'url is required');
			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				return error(400, 'url must be valid');
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return error(400, 'only http and https URLs can be opened');
			}
			try {
				await opts.openExternal(url.href);
				return json({ opened: true });
			} catch (err) {
				return error(500, err instanceof Error ? err.message : String(err));
			}
		}

		const sourceMatch = path.match(/^\/api\/sources\/([^/]+)$/);
		if (sourceMatch && req.method === 'PUT') {
			const slug = decodeURIComponent(sourceMatch[1]);
			return await withJsonBody(req, (body) => {
				const status = saveSourceConfig(db, slug, body);
				// Enabling a source should start polling now, not after a restart.
				opts.sources?.sync();
				return json(status);
			});
		}

		// Grants or revokes a plugin's trust. Separate from PUT /api/sources/:slug
		// because trusting is a different decision from configuring: it is the one
		// place the user accepts a permission list, and it must not be reachable as
		// a side effect of saving a token.
		const trustMatch = path.match(/^\/api\/sources\/([^/]+)\/trust$/);
		if (trustMatch && req.method === 'POST') {
			const slug = decodeURIComponent(trustMatch[1]);
			return await withJsonBody(req, (body) => {
				const status = setSourceTrust(db, slug, body);
				// Revoking trust disables the source; make the runner notice now.
				opts.sources?.sync();
				return json(status);
			});
		}

		const pollMatch = path.match(/^\/api\/sources\/([^/]+)\/poll$/);
		if (pollMatch && req.method === 'POST') {
			const slug = decodeURIComponent(pollMatch[1]);
			if (!opts.sources) return error(503, 'the poll runner is not available');
			const result = await opts.sources.pollNow(slug);
			// A failed poll is a 200 carrying the error: the request itself worked,
			// and the settings page wants to render what went wrong.
			return json(result);
		}

		// Advances the view's read marker. Called when the user opens it.
		const seenMatch = path.match(/^\/api\/views\/([^/]+)\/seen$/);
		if (seenMatch && req.method === 'POST') {
			const view = markViewSeen(db, decodeURIComponent(seenMatch[1]));
			return view ? json(view) : error(404, 'view not found');
		}

		// A second launch of the app hits this on the instance that already owns
		// the port, rather than opening a duplicate window.
		if (path === '/api/window/focus' && req.method === 'POST') {
			opts.onFocusRequest?.();
			return json({ focused: Boolean(opts.onFocusRequest) });
		}

		return error(404, `no route for ${req.method} ${path}`);
	};

	/** Parses a JSON body and turns a ValidationError into a 400 rather than a 500. */
	async function withJsonBody(
		req: Request,
		handle: (body: unknown) => Response
	): Promise<Response> {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return error(400, 'body must be valid JSON');
		}
		try {
			return handle(body);
		} catch (err) {
			if (err instanceof ValidationError) {
				// "not found" is a 404 even though it arrives as a ValidationError.
				return error(err.message.includes('not found') ? 404 : 400, err.message);
			}
			throw err;
		}
	}

	async function handlePost(req: Request): Promise<Response> {
		let payload: unknown;
		try {
			payload = await req.json();
		} catch {
			return error(400, 'body must be valid JSON');
		}

		// Single, bare array, or {posts:[...]}: hooks and shell one-liners send a
		// single object; pollers and the spool drain send batches. Accepting all
		// three costs three lines and saves every client a decision.
		const batch: unknown[] = Array.isArray(payload)
			? payload
			: typeof payload === 'object' && payload !== null && Array.isArray((payload as { posts?: unknown }).posts)
				? ((payload as { posts: unknown[] }).posts)
				: [payload];

		if (batch.length === 0) return error(400, 'no posts in request');
		if (batch.length > 1000) return error(413, 'too many posts in one batch (max 1000)');

		// Atomic: one bad post rejects the whole batch, so a client that fixes it
		// and resends cannot end up with the good ones written twice.
		let written;
		try {
			written = insertPosts(db, batch);
		} catch (err) {
			if (err instanceof ValidationError) return error(400, err.message);
			throw err;
		}

		// Broadcast only after every post is committed, so an SSE subscriber can
		// never see a post that a later validation failure rolled back.
		for (const result of written) {
			broadcaster.publish({ type: 'post', post: result.post, deduped: result.deduped });
		}

		// The `deduped` flag is an internal detail of the write; clients get the
		// resulting posts. (Subscribers who care -- the UI deciding whether to
		// prepend a card or update one in place -- learn it from the SSE event.)
		const posts = written.map((result) => result.post);

		// Mirror the request's shape: one post in, one post out.
		const single = !Array.isArray(payload) && !(payload as { posts?: unknown })?.posts;
		return json(single ? posts[0] : { posts }, 201);
	}
}
