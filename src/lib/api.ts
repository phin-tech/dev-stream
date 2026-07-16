/**
 * The webview's client for the local ingestion API.
 *
 * The page is a cross-origin caller like any other (it is served from the
 * framework's random port; the API is on 4517), so it authenticates with the same
 * bearer token the CLI uses. It gets that token from the `getApiConfig` binding,
 * since a sandboxed page cannot read `~/.dev-stream/token` from disk.
 */

import type {
	ApiConfig,
	Facets,
	Post,
	PostFilter,
	PostInput,
	PostPage,
	PostQuery,
	Settings,
	SettingsInfo,
	RegistryPluginStatus,
	SourceStatus,
	StreamEvent,
	View,
	ViewInput,
	ViewWithUnread
} from '../shared/types';
import { callBinding } from './bindings';
let configPromise: Promise<ApiConfig> | undefined;
/** Set when the token is rotated, so subsequent calls use the new one. */
let overrideToken: string | undefined;

/**
 * Where the API is, and how to authenticate to it.
 *
 * In the desktop app this comes from the local UI server, which can hand the
 * webview credentials without relying on the desktop binding dispatcher.
 *
 * In `task dev` there is no webview and therefore no `bindings` global at all, so
 * we fall back to values Vite injected at dev-server start (`task dev` writes them
 * into `.env.local` from `~/.dev-stream`). `import.meta.env.DEV` is compiled to a
 * literal `false` in the production build, so this whole branch — and any chance of
 * a token reaching a bundle — is dropped from the shipped app.
 *
 * Memoized: neither the port nor the token changes for the life of the window.
 */
export function apiConfig(): Promise<ApiConfig> {
	configPromise ??= (async () => {
		if (import.meta.env.DEV && typeof (globalThis as { bindings?: unknown }).bindings === 'undefined') {
			const port = Number(import.meta.env.VITE_DEV_STREAM_PORT);
			const token = import.meta.env.VITE_DEV_STREAM_TOKEN as string | undefined;
			if (!port || !token) {
				throw new Error(
					'Running in a browser with no dev credentials. Use `task dev`, which starts the ' +
						'backend and writes VITE_DEV_STREAM_PORT/TOKEN into .env.local.'
				);
			}
			return { port, token };
		}

		const response = await fetch('/api/desktop-config');
		if (!response.ok) {
			throw new Error(`GET /api/desktop-config failed with ${response.status}`);
		}
		return (await response.json()) as ApiConfig;
	})();

	return configPromise;
}

async function current(): Promise<ApiConfig> {
	const config = await apiConfig();
	return overrideToken ? { ...config, token: overrideToken } : config;
}

function toQueryString(query: PostQuery): string {
	const params = new URLSearchParams();
	for (const key of ['source', 'project', 'repo', 'kind', 'tag'] as const) {
		for (const value of query[key] ?? []) params.append(key, value);
	}
	for (const key of ['q', 'since', 'until', 'cursor'] as const) {
		if (query[key]) params.set(key, String(query[key]));
	}
	if (query.archived) params.set('archived', 'true');
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	return qs ? `?${qs}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const { port, token } = await current();
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		...init,
		headers: { ...init.headers, authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		// The API answers errors as {error: "..."}; surface that rather than a
		// bare status code, which tells the user nothing.
		const detail = await res
			.json()
			.then((body: { error?: string }) => body.error)
			.catch(() => '');
		throw new Error(detail || `${init.method ?? 'GET'} ${path} failed with ${res.status}`);
	}
	return (await res.json()) as T;
}

export function fetchPosts(query: PostQuery = {}): Promise<PostPage> {
	return request<PostPage>(`/api/posts${toQueryString(query)}`);
}

/** The values the filter bar can offer, counted against the current filter. */
export function fetchFacets(query: PostQuery = {}): Promise<Facets> {
	return request<Facets>(`/api/facets${toQueryString({ ...query, cursor: undefined })}`);
}

export function createPost(post: PostInput): Promise<Post> {
	return request<Post>('/api/posts', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(post)
	});
}

/** Marks a single post seen (clicked or keyboard-selected). Returns the synced post. */
export function markPostSeen(id: string): Promise<Post> {
	return request<Post>(`/api/posts/${encodeURIComponent(id)}/seen`, { method: 'POST' });
}

/** Clears a post's read marker, so it counts as unread again. */
export function markPostUnseen(id: string): Promise<Post> {
	return request<Post>(`/api/posts/${encodeURIComponent(id)}/unseen`, { method: 'POST' });
}

export function archivePost(id: string): Promise<Post> {
	return request<Post>(`/api/posts/${encodeURIComponent(id)}/archive`, { method: 'POST' });
}

export function restorePost(id: string): Promise<Post> {
	return request<Post>(`/api/posts/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}

/**
 * Marks every post matching `filter` as seen ("mark all as read"). Passing the
 * timeline's active filter scopes it: clearing while a view is open clears only
 * that view. Returns how many were newly marked.
 */
export function markAllSeen(filter: PostFilter = {}): Promise<{ marked: number }> {
	return request(`/api/seen`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(filter)
	});
}

export async function fetchViews(): Promise<ViewWithUnread[]> {
	const { views } = await request<{ views: ViewWithUnread[] }>('/api/views');
	return views;
}

export function createView(input: ViewInput): Promise<View> {
	return request<View>('/api/views', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	});
}

export function updateView(id: string, patch: Partial<ViewInput>): Promise<View> {
	return request<View>(`/api/views/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch)
	});
}

export function deleteView(id: string): Promise<{ deleted: boolean }> {
	return request(`/api/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Advances the view's read marker. Called when the user opens it. */
export function markViewSeen(id: string): Promise<View> {
	return request<View>(`/api/views/${encodeURIComponent(id)}/seen`, { method: 'POST' });
}

export async function fetchSources(): Promise<SourceStatus[]> {
	const { sources } = await request<{ sources: SourceStatus[] }>('/api/sources');
	return sources;
}

export function installPlugin(url: string): Promise<SourceStatus> {
	return request<SourceStatus>('/api/plugins/install', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ url })
	});
}

export async function fetchPluginRegistry(): Promise<RegistryPluginStatus[]> {
	const { plugins } = await request<{ plugins: RegistryPluginStatus[] }>('/api/plugins/registry');
	return plugins;
}

export function installRegistryPlugin(slug: string): Promise<SourceStatus> {
	return request<SourceStatus>(`/api/plugins/registry/${encodeURIComponent(slug)}/install`, { method: 'POST' });
}

/**
 * Saves an integration's enablement and config.
 *
 * A secret left blank is preserved server-side rather than cleared — the page
 * never receives the stored token, so it cannot re-submit it.
 */
export function saveSource(
	slug: string,
	body: { enabled: boolean; config: Record<string, string> }
): Promise<SourceStatus> {
	return request<SourceStatus>(`/api/sources/${encodeURIComponent(slug)}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

export function pollSource(slug: string): Promise<{ posts: number; error?: string }> {
	return request(`/api/sources/${encodeURIComponent(slug)}/poll`, { method: 'POST' });
}

/**
 * Grants or revokes a plugin's trust. Granting binds to the manifest the user
 * just read; revoking also disables the source server-side.
 */
export function trustSource(slug: string, trusted: boolean): Promise<SourceStatus> {
	return request<SourceStatus>(`/api/sources/${encodeURIComponent(slug)}/trust`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trusted })
	});
}

export function fetchSettings(): Promise<SettingsInfo> {
	return request<SettingsInfo>('/api/settings');
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
	return request<Settings>('/api/settings', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch)
	});
}

/**
 * Rotates the API token.
 *
 * The new token is remembered in-process immediately: our very next request must
 * already carry it, since the server stopped accepting the old one the moment it
 * answered. Other clients (CLI, hooks) re-read `~/.dev-stream/token` per run and
 * pick it up on their own.
 */
export async function regenerateToken(): Promise<string> {
	const { token } = await request<{ token: string }>('/api/token/regenerate', { method: 'POST' });
	overrideToken = token;
	return token;
}

/**
 * Opens a URL in the real browser.
 *
 * Never let an anchor navigate normally: in a webview that replaces the app's own
 * page with the target site, and there is no back button to return from it.
 */
export async function openExternal(url: string): Promise<void> {
	await request('/api/open-external', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ url })
	});
}

export async function revealInFinder(path: string): Promise<void> {
	await callBinding('revealInFinder', [path]);
}

/**
 * Subscribes to live posts.
 *
 * Uses `EventSource`, which cannot set an `Authorization` header -- hence the
 * token rides the query string, which the API allows for this route alone.
 * `EventSource` also reconnects on its own, which is what we want when the
 * backend restarts underneath a still-open window.
 *
 * @returns an unsubscribe function.
 */
export async function subscribe(onEvent: (event: StreamEvent) => void): Promise<() => void> {
	const { port, token } = await current();
	const source = new EventSource(
		`http://127.0.0.1:${port}/api/events?token=${encodeURIComponent(token)}`
	);

	// Named events ('post', 'hello') do not fire the default `message` handler.
	const handler = (event: MessageEvent) => onEvent(JSON.parse(event.data) as StreamEvent);
	source.addEventListener('post', handler);
	source.addEventListener('hello', handler);

	return () => source.close();
}
