/**
 * Feed state: the loaded page(s), the active filter, live arrivals, facets.
 *
 * Kept out of the component so the scroll/pagination/SSE interplay is testable
 * and readable on its own -- it is the only genuinely stateful part of the UI.
 */

import type { Facets, Post, PostFilter, Settings, StreamEvent, ViewWithUnread } from '../shared/types';
import { fetchFacets, fetchPosts, fetchSettings, fetchViews, markViewSeen, saveSettings, subscribe } from './api';

const PAGE_SIZE = 50;

const EMPTY_FACETS: Facets = { source: [], project: [], repo: [], kind: [], tag: [] };

/**
 * Does a post belong in the current view?
 *
 * Used only to decide whether a *live* arrival should be announced. Note it
 * deliberately does not try to evaluate `q`: full-text matching lives in SQLite's
 * FTS5 tokenizer, and reimplementing it here would be both a lot of code and
 * subtly wrong. While a search is active, `Feed` refuses to guess (see `#onPost`).
 */
export function matchesFilter(post: Post, filter: PostFilter): boolean {
	const inList = (values: string[] | undefined, actual: string | undefined) =>
		!values?.length || (actual !== undefined && values.includes(actual));

	if (!inList(filter.source, post.source)) return false;
	if (!inList(filter.kind, post.kind)) return false;
	if (!inList(filter.project, post.meta.project)) return false;
	if (!inList(filter.repo, post.meta.repo)) return false;

	// AND, matching the server: a post must carry every selected tag.
	if (filter.tag?.length && !filter.tag.every((tag) => post.tags.includes(tag))) return false;

	if (filter.since && post.ts < filter.since) return false;
	if (filter.until && post.ts > filter.until) return false;

	return true;
}

export class Feed {
	posts = $state<Post[]>([]);
	/**
	 * Live posts that have arrived but are NOT on screen yet.
	 *
	 * They are held back rather than prepended because prepending shifts every
	 * card down under the reader's cursor. The UI surfaces them as an "N new"
	 * pill; the reader decides when to take them.
	 */
	pending = $state<Post[]>([]);
	filter = $state<PostFilter>({});
	facets = $state<Facets>(EMPTY_FACETS);

	views = $state<ViewWithUnread[]>([]);
	/** The saved view currently open, if any. Null means the raw timeline. */
	activeViewId = $state<string | null>(null);
	muted = $state<Pick<Settings, 'muted_sources' | 'muted_tags'>>({
		muted_sources: [],
		muted_tags: []
	});

	/** Index of the keyboard-selected card. -1 when nothing is selected. */
	selected = $state(-1);

	/**
	 * Ids of posts that arrived live and were just taken into the feed. Their node
	 * on the time-rail pulses briefly, then settles -- a "this just landed" cue
	 * that doesn't linger. Cleared on a timer; see `applyPending`.
	 */
	arrivedIds = $state<string[]>([]);
	#arrivedTimer: ReturnType<typeof setTimeout> | undefined;

	loading = $state(false);
	loadingMore = $state(false);
	error = $state<string | null>(null);
	/** False once the server stops handing back a cursor. */
	hasMore = $state(false);
	connected = $state(false);

	#cursor: string | null = null;
	#unsubscribe: (() => void) | undefined;
	/** Guards against a filter change landing after a slower, older request. */
	#generation = 0;

	async start(): Promise<void> {
		await Promise.all([this.load(), this.refreshViews(), this.#loadMutes()]);
		this.#unsubscribe = await subscribe((event) => this.#onEvent(event));
	}

	async refreshViews(): Promise<void> {
		try {
			this.views = await fetchViews();
		} catch {
			// A missing sidebar is not worth an error banner over the feed.
		}
	}

	async #loadMutes(): Promise<void> {
		try {
			const settings = await fetchSettings();
			this.muted = {
				muted_sources: settings.muted_sources,
				muted_tags: settings.muted_tags
			};
		} catch {
			/* fall back to nothing muted */
		}
	}

	/** Opens a saved view: applies its filter and clears its unread badge. */
	async openView(view: ViewWithUnread): Promise<void> {
		this.activeViewId = view.id;
		this.filter = view.filter;
		await this.load();

		// Marked seen only after the posts are actually on screen -- marking on
		// click would clear the badge for posts the user never saw if the load
		// failed.
		try {
			await markViewSeen(view.id);
			await this.refreshViews();
		} catch {
			/* the badge will simply clear on the next visit */
		}
	}

	/**
	 * Mutes a source or tag.
	 *
	 * Server-side, because muting has to hold for every client: `dev-stream tail`
	 * and a plain curl should respect it too, without knowing it exists.
	 */
	async mute(dimension: 'source' | 'tag', value: string): Promise<void> {
		const key = dimension === 'source' ? 'muted_sources' : 'muted_tags';
		if (this.muted[key].includes(value)) return;

		const next = { ...this.muted, [key]: [...this.muted[key], value] };
		this.muted = next;
		try {
			await saveSettings({ [key]: next[key] });
			await this.load(); // the muted posts should disappear now
		} catch (err) {
			this.error = String(err);
		}
	}

	async unmuteAll(): Promise<void> {
		this.muted = { muted_sources: [], muted_tags: [] };
		try {
			await saveSettings({ muted_sources: [], muted_tags: [] });
			await this.load();
		} catch (err) {
			this.error = String(err);
		}
	}

	stop(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	/** Replaces the feed with the first page for the current filter. */
	async load(): Promise<void> {
		const generation = ++this.#generation;
		this.loading = true;
		this.error = null;

		try {
			const [page, facets] = await Promise.all([
				fetchPosts({ ...this.filter, limit: PAGE_SIZE }),
				fetchFacets(this.filter)
			]);

			// A newer filter was applied while this was in flight; its results win.
			if (generation !== this.#generation) return;

			this.posts = page.posts;
			this.facets = facets;
			this.#cursor = page.next_cursor;
			this.hasMore = page.next_cursor !== null;
			// Anything queued was for the previous filter, and the fresh page
			// already contains whatever still qualifies.
			this.pending = [];
		} catch (err) {
			if (generation === this.#generation) this.error = String(err);
		} finally {
			if (generation === this.#generation) this.loading = false;
		}
	}

	/** Appends the next page. Safe to call repeatedly from a scroll handler. */
	async loadMore(): Promise<void> {
		if (this.loadingMore || this.loading || !this.hasMore || this.#cursor === null) return;

		const generation = this.#generation;
		this.loadingMore = true;
		try {
			const page = await fetchPosts({ ...this.filter, limit: PAGE_SIZE, cursor: this.#cursor });
			if (generation !== this.#generation) return; // filter changed mid-flight

			// The keyset cursor guarantees these come strictly after what we hold,
			// so appending cannot duplicate -- even though the head is live.
			this.posts = [...this.posts, ...page.posts];
			this.#cursor = page.next_cursor;
			this.hasMore = page.next_cursor !== null;
		} catch (err) {
			if (generation === this.#generation) this.error = String(err);
		} finally {
			if (generation === this.#generation) this.loadingMore = false;
		}
	}

	/** Moves queued live posts into the feed. Wired to the "N new posts" pill. */
	applyPending(): void {
		if (this.pending.length === 0) return;
		const arrived = this.pending.map((p) => p.id);
		this.posts = [...this.pending, ...this.posts];
		this.pending = [];

		// Pulse the freshly-landed nodes, then let them settle back into the feed.
		this.arrivedIds = arrived;
		clearTimeout(this.#arrivedTimer);
		this.#arrivedTimer = setTimeout(() => {
			this.arrivedIds = [];
		}, 6000);

		// The new posts change the counts, but a facet refresh is not worth
		// blocking the click on -- let it settle in the background.
		void this.refreshFacets();
	}

	async refreshFacets(): Promise<void> {
		try {
			const facets = await fetchFacets(this.filter);
			this.facets = facets;
		} catch {
			// Stale counts are a cosmetic problem; don't surface an error banner.
		}
	}

	/**
	 * Applies a filter directly.
	 *
	 * Doing so leaves whatever saved view was open: the filter no longer matches
	 * the view, and pretending otherwise would let the user "edit" a view without
	 * saving it and then wonder why their changes vanished.
	 */
	setFilter(filter: PostFilter): void {
		this.filter = filter;
		this.activeViewId = null;
		this.selected = -1;
		void this.load();
	}

	/** j / k. Returns the newly selected index so the caller can scroll it in. */
	moveSelection(delta: number): number {
		if (this.posts.length === 0) return -1;
		const next = Math.min(Math.max(this.selected + delta, 0), this.posts.length - 1);
		this.selected = next;

		// Selecting near the bottom should pull the next page in, or j-ing to the
		// end would just stop.
		if (next >= this.posts.length - 5) void this.loadMore();
		return next;
	}

	#onEvent(event: StreamEvent): void {
		if (event.type === 'hello') {
			this.connected = true;
			return;
		}
		if (event.type === 'post') this.#onPost(event.post, event.deduped);
	}

	#onPost(post: Post, deduped: boolean): void {
		// A deduped write mutates a post that may already be on screen (a build
		// going from "running" to "passed"). Update it in place -- prepending a
		// second copy of the same id would be a visible bug.
		if (deduped) {
			const onScreen = this.posts.findIndex((p) => p.id === post.id);
			if (onScreen >= 0) {
				this.posts = this.posts.with(onScreen, post);
				return;
			}
			const queued = this.pending.findIndex((p) => p.id === post.id);
			if (queued >= 0) {
				this.pending = this.pending.with(queued, post);
				return;
			}
			// Otherwise it updated a post below the fold, or one outside the
			// filter. Falling through treats it as a new arrival, which is right:
			// if it now matches, it deserves to be announced.
		}

		// With a search active we cannot honestly say whether this post matches --
		// FTS5 semantics don't exist on this side. Announcing a post that the
		// server would not return is worse than staying quiet; the reader can
		// re-run the search.
		if (this.filter.q?.trim()) return;

		if (!matchesFilter(post, this.filter)) return;
		if (this.pending.some((p) => p.id === post.id)) return;

		this.pending = [post, ...this.pending];
	}
}
