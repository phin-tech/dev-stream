// Shared typing + helpers for `deno desktop` win.bind() calls, per the
// documented pattern (https://docs.deno.com/runtime/desktop/bindings/): the
// Deno side registers handlers with `win.bind(name, handler)`, and the webview
// calls them as `bindings.<name>()`. This module is the single source of truth
// for the binding surface so both sides are type-checked against one interface.
//
// Bindings are kept deliberately thin: they are request/response only (no
// streaming) and JSON-serializable only, so the timeline's data path is HTTP+SSE
// against the local API and bindings are reserved for things only the OS side can
// do -- like handing the page a token it has no other way to read.
//
// Future OS-y bindings (reveal in Finder, notifications, settings) get added here.

import type { ApiConfig } from '../shared/types';

export interface Bindings {
	/**
	 * Where the ingestion API is, and the bearer token for it.
	 *
	 * The page is served from the framework's own random port and is sandboxed
	 * from the filesystem, so it cannot read `~/.dev-stream/{port,token}` the way
	 * the CLI does. This binding is the webview's equivalent of that discovery
	 * step. It resolves only once the backend has actually bound its port.
	 */
	getApiConfig(): Promise<ApiConfig>;

	/**
	 * Opens a URL in the real browser.
	 *
	 * Required, not optional: a plain `<a href>` in a webview navigates the app
	 * window itself, so an unguarded link to a PR replaces the timeline with
	 * GitHub and there is no way back. Only http(s) is accepted.
	 */
	openExternal(url: string): Promise<{ ok: boolean; error?: string }>;

	/** Selects a path in Finder. Refuses anything outside `~/.dev-stream`. */
	revealInFinder(path: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
	// The webview global injected by `deno desktop`. Note it is a Proxy that
	// creates methods on demand, so `typeof bindings !== 'undefined'` is true
	// from the very first page script -- existence checks tell you nothing
	// about whether a given handler is registered yet.
	const bindings: Bindings;
}

/**
 * Call a binding, retrying transient startup errors.
 *
 * Sharp edges this absorbs (Phase 0 findings):
 * - `bindings` is an on-demand Proxy, so the failure mode for "backend hasn't
 *   registered this handler yet" is NOT a missing global -- it's the call
 *   rejecting with "No callback bound for: <name>". If the page's first call
 *   races the backend's win.bind() registration, retrying shortly succeeds.
 * - During SSR there is no `bindings` global at all (ReferenceError); callers
 *   must gate on `browser` / onMount -- this helper is webview-only.
 */
export async function callBinding<K extends keyof Bindings>(
	name: K,
	args: Parameters<Bindings[K]> = [] as unknown as Parameters<Bindings[K]>,
	opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ result: Awaited<ReturnType<Bindings[K]>>; attempts: number }> {
	const { timeoutMs = 5000, intervalMs = 100 } = opts;
	const start = Date.now();
	let attempts = 0;
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		attempts++;
		try {
			const fn = bindings[name] as (...a: unknown[]) => Promise<unknown>;
			const result = (await fn(...args)) as Awaited<ReturnType<Bindings[K]>>;
			return { result, attempts };
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}
	throw new Error(
		`binding ${String(name)} failed after ${attempts} attempts over ${timeoutMs}ms; last error: ${lastError}`
	);
}
