<script lang="ts">
	import { onMount } from 'svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import PostCard from '$lib/components/PostCard.svelte';
	import QuickLook from '$lib/components/QuickLook.svelte';
	import ViewSidebar from '$lib/components/ViewSidebar.svelte';
	import { Feed } from '$lib/feed.svelte';
	import { createView, deleteView, openExternal } from '$lib/api';
	import { dispatchKey, NAV_COMMANDS, viewCommands, type CommandContext } from '$lib/commands';
	import { dayKey, dayLabel } from '$lib/format';
	import { activityArrivalMode, postLinks } from '$lib/timeline';
	import { quickLookIntent } from '$lib/interaction-policy';
	import type { PostFilter, ViewWithUnread } from '../shared/types';

	const feed = new Feed();

	let scroller = $state<HTMLElement | null>(null);
	let sentinel = $state<HTMLElement | null>(null);
	let atTop = $state(true);
	let quickLookPostId = $state<string | null>(null);
	const arrivalMode = $derived(activityArrivalMode({ pendingCount: feed.pending.length, atTop }));

	const mutedCount = $derived(
		feed.muted.muted_sources.length + feed.muted.muted_tags.length
	);

	// Loaded unread posts. A lower bound -- there may be more below the fold -- so
	// the count is shown with a "+" whenever the timeline has another page.
	const unseenCount = $derived(feed.posts.filter((p) => !p.seen).length);
	const archiveActive = $derived(feed.activeViewId === null && feed.filter.archived === true);
	const quickLookPost = $derived(feed.posts.find((post) => post.id === quickLookPostId) ?? null);

	onMount(() => {
		void feed.start();
		window.addEventListener('dev-stream-command', handleAppCommand as EventListener);
		return () => {
			window.removeEventListener('dev-stream-command', handleAppCommand as EventListener);
			feed.stop();
		};
	});

	$effect(() => {
		if (arrivalMode === 'inline') feed.applyPending();
	});

	function trackScroll() {
		atTop = (scroller?.scrollTop ?? 0) < 24;
	}

	// Infinite scroll: when the sentinel below the last card comes into view, pull
	// the next page. An IntersectionObserver rather than a scroll handler — it
	// doesn't fire on every pixel, and it keeps working as the list grows.
	$effect(() => {
		if (!sentinel || !scroller) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) void feed.loadMore();
			},
			// Start fetching a screenful early, so scrolling doesn't visibly stall.
			{ root: scroller, rootMargin: '600px' }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	// Opt-in (Settings → Reading): mark a post seen once it has scrolled fully above
	// the top of the viewport. Re-created whenever the post list changes, so cards
	// pulled in by pagination or a live arrival get observed too. Reading
	// `feed.posts.length` is what makes the effect re-run on those changes; mutating
	// a post's own `seen` flag doesn't change the length, so marking doesn't churn it.
	$effect(() => {
		if (!scroller || !feed.markSeenOnScroll) return;
		void feed.posts.length;

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const scrolledAbove =
						!entry.isIntersecting &&
						entry.rootBounds !== null &&
						entry.boundingClientRect.bottom <= entry.rootBounds.top;
					if (!scrolledAbove) continue;
					const id = (entry.target as HTMLElement).dataset.postId;
					if (id) void feed.markSeen(id);
				}
			},
			{ root: scroller }
		);

		for (const el of scroller.querySelectorAll('article[data-post-id]')) observer.observe(el);
		return () => observer.disconnect();
	});

	function showNew() {
		feed.applyPending();
		scroller?.scrollTo({ top: 0, behavior: 'smooth' });
	}

	function addFilter(dimension: keyof PostFilter, value: string) {
		const current = (feed.filter[dimension] as string[] | undefined) ?? [];
		if (current.includes(value)) return;
		feed.setFilter({ ...feed.filter, [dimension]: [...current, value] });
		scroller?.scrollTo({ top: 0 });
	}

	function selectedDisclosure(): HTMLButtonElement | null {
		if (!scroller || feed.selected < 0) return null;
		const card = scroller.querySelectorAll<HTMLElement>('article[data-post-id]')[feed.selected];
		return card?.querySelector<HTMLButtonElement>('[data-disclosure-toggle]') ?? null;
	}

	function openSelectedDetails() {
		const post = feed.posts[feed.selected];
		if (!post) return;
		void feed.markSeen(post.id);
		const disclosure = selectedDisclosure();
		if (disclosure?.getAttribute('aria-expanded') === 'false') disclosure.click();
	}

	function closeSelectedDetails(): boolean {
		const disclosure = selectedDisclosure();
		if (disclosure?.getAttribute('aria-expanded') !== 'true') return false;
		disclosure.click();
		return true;
	}

	function toggleSelectedQuickLook() {
		const post = feed.posts[feed.selected];
		const intent = quickLookIntent({
			hasSelection: Boolean(post),
			quickLookOpen: Boolean(quickLookPost)
		});
		quickLookPostId = intent === 'open' && post ? post.id : null;
	}

	function handleTimelineKeydown(event: KeyboardEvent) {
		if (quickLookPost) {
			if (event.key === ' ' || event.key === 'Escape') {
				event.preventDefault();
				quickLookPostId = null;
			} else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
				event.preventDefault();
				quickLookPostId = null;
				openSelectedDetails();
			}
			return;
		}
		if (event.key === 'Escape' && closeSelectedDetails()) {
			event.preventDefault();
			return;
		}
		dispatchKey(commands, event, ctx);
	}

	function handleAppCommand(event: CustomEvent<string>) {
		const command = commands.find((candidate) => candidate.id === event.detail);
		if (command && (!command.enabled || command.enabled(ctx))) {
			void command.run(ctx, event as unknown as KeyboardEvent);
		}
	}

	function focusSearch() {
		document.querySelector<HTMLInputElement>("input[type='search']")?.focus();
	}

	function scrollToBottom() {
		if (!scroller) return;
		feed.selected = Math.max(0, feed.posts.length - 1);
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	function toggleSelectedRead() {
		const post = feed.posts[feed.selected];
		if (!post) return;
		void (post.seen ? feed.markUnseen(post.id) : feed.markSeen(post.id));
	}

	function toggleSidebar() {
		document.querySelector<HTMLButtonElement>('.sidebar-toggle')?.click();
	}

	function selectedLink(): string | null {
		const post = feed.posts[feed.selected];
		return post ? (postLinks(post.meta)[0]?.url ?? null) : null;
	}

	function openSelectedLink() {
		const post = feed.posts[feed.selected];
		const url = selectedLink();
		if (!post || !url) return;
		void feed.markSeen(post.id);
		void openExternal(url);
	}

	function toggleSelectedArchive() {
		const post = feed.posts[feed.selected];
		if (post) void feed.toggleArchived(post.id);
	}

	// --- commands ------------------------------------------------------------

	// What every command acts through. `scroller` is a getter so commands always
	// see the live element, not whatever it was when this object was built.
	const ctx: CommandContext = {
		feed,
		get scroller() {
			return scroller;
		},
		scrollToTop: (smooth = false) => {
			if (!scroller) return;
			scroller.scrollTop = 0;
			if (smooth) scroller.scrollTo({ top: 0, behavior: 'smooth' });
		},
		openTimeline: () => openTimeline(),
		openView: (view) => openView(view),
		showNew: () => showNew(),
		openSelectedDetails,
		toggleSelectedQuickLook,
		focusSearch,
		scrollToBottom,
		scrollPage: (direction) => scroller?.scrollBy({ top: direction * (scroller.clientHeight / 2), behavior: 'smooth' }),
		toggleSelectedRead,
		toggleSidebar,
		hasSelectedLink: () => selectedLink() !== null,
		openSelectedLink,
		toggleSelectedArchive
	};

	// Static timeline commands plus one per saved view (Cmd/Ctrl 1–9, 0), rebuilt
	// as the sidebar changes so the shortcuts always track the first ten views.
	const commands = $derived([...NAV_COMMANDS, ...viewCommands(feed.views)]);

	// --- views ---------------------------------------------------------------

	async function saveView(name: string) {
		try {
			await createView({ name, filter: feed.filter });
			await feed.refreshViews();
		} catch (err) {
			feed.error = String(err);
		}
	}

	async function removeView(view: ViewWithUnread) {
		try {
			await deleteView(view.id);
			if (feed.activeViewId === view.id) openTimeline();
			await feed.refreshViews();
		} catch (err) {
			feed.error = String(err);
		}
	}

	function openTimeline() {
		feed.setFilter({});
		scroller?.scrollTo({ top: 0 });
	}

	function openArchive() {
		feed.setFilter({ archived: true });
		scroller?.scrollTo({ top: 0 });
	}

	async function openView(view: ViewWithUnread) {
		await feed.openView(view);
		scroller?.scrollTo({ top: 0 });
	}
</script>

<svelte:window onkeydown={handleTimelineKeydown} />

<div class="layout">
	<ViewSidebar
		views={feed.views}
		activeViewId={feed.activeViewId}
		{archiveActive}
		filter={feed.filter}
		onOpen={openView}
		onOpenTimeline={openTimeline}
		onOpenArchive={openArchive}
		onSave={saveView}
		onDelete={removeView}
	/>

	<section class="feed">
		<div class="control-surface">
			<FilterBar
				filter={feed.filter}
				facets={feed.facets}
				onChange={(filter) => {
					feed.setFilter(filter);
					scroller?.scrollTo({ top: 0 });
				}}
			/>

			{#if mutedCount > 0}
				<!-- Muting is invisible by construction, which makes it easy to forget
				     you did it and then wonder where a source went. Say so. -->
				<div class="muted-bar">
					{mutedCount}
					{mutedCount === 1 ? 'source/tag is' : 'sources/tags are'} muted
					<button onclick={() => feed.unmuteAll()}>Unmute all</button>
				</div>
			{/if}

			{#if unseenCount > 0}
				<div class="read-bar">
					<span class="count">{unseenCount}{feed.hasMore ? '+' : ''}</span>
					unread
					<button onclick={() => feed.markAllSeen()}>Mark all as read</button>
				</div>
			{/if}
		</div>

		<main bind:this={scroller} onscroll={trackScroll}>
			{#if arrivalMode === 'indicator'}
				<button class="pill" onclick={showNew}>
					{feed.pending.length}
					{feed.pending.length === 1 ? 'newer item' : 'newer items'} ↑
				</button>
			{/if}

			{#if feed.error}
				<p class="notice error">{feed.error}</p>
			{/if}

			{#if feed.loading}
				<p class="notice">Loading…</p>
			{:else if feed.posts.length === 0}
				<p class="notice">
					{#if feed.filter.archived}
						Archive is empty.
					{:else if Object.keys(feed.filter).length > 0}
						Nothing matches this filter.
					{:else}
						Nothing here yet. Try
						<code>dev-stream post "hello"</code>
						or
						<code>dev-stream init claude</code>.
					{/if}
				</p>
			{/if}

			<!-- The stream draws the time-rail spine; posts and daymarks are its rows. -->
			<div class="stream">
				{#each feed.posts as post, index (post.id)}
					{#if index === 0 || dayKey(post.ts) !== dayKey(feed.posts[index - 1].ts)}
						<div class="daymark">
							<span class="lbl">{dayLabel(post.ts)}</span>
							<span class="rule"></span>
						</div>
					{/if}
					<PostCard
						{post}
						selected={feed.selected === index}
						fresh={feed.arrivedIds.includes(post.id)}
						onFilter={addFilter}
						onMute={(dimension, value) => feed.mute(dimension, value)}
						onSeenChange={(seen) => (seen ? feed.markSeen(post.id) : feed.markUnseen(post.id))}
						onArchive={() => feed.toggleArchived(post.id)}
					/>
				{/each}

				<div bind:this={sentinel} class="sentinel">
					{#if feed.loadingMore}
						<span class="notice">Loading more…</span>
					{:else if !feed.hasMore && feed.posts.length > 0}
						<span class="notice">End of the timeline.</span>
					{/if}
				</div>
			</div>
		</main>
	</section>
</div>

{#if quickLookPost}
	<QuickLook post={quickLookPost} onClose={() => (quickLookPostId = null)} />
{/if}

<style>
	.layout {
		flex: 1;
		display: flex;
		min-height: 0; /* lets the children scroll instead of the page */
	}

	.feed {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.control-surface {
		position: relative;
		z-index: var(--z-dropdown);
		margin: var(--space-md) var(--space-md) var(--space-sm);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--surface) 72%, var(--ink));
		overflow: visible;
	}

	main {
		flex: 1;
		overflow-y: auto;
		position: relative;
		margin: 0 var(--space-md) var(--space-md);
		padding: 0 0 2rem;
		border-radius: var(--space-lg);
		background: color-mix(in oklch, var(--surface) 42%, var(--ink));
	}

	.stream {
		width: min(100%, 64rem);
		margin: 0 auto;
		padding: var(--space-sm) var(--space-lg) var(--space-xl);
		box-sizing: border-box;
	}

	/* A day heading that punctuates the rail; shares the post grid so its label
	   lands in the timestamp gutter. */
	.daymark {
		display: flex;
		gap: var(--space-md);
		align-items: center;
		padding: var(--space-sm) 0 var(--space-xs);
	}
	.daymark .lbl {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--fg-soft);
		white-space: nowrap;
	}
	.daymark .rule {
		flex: 1;
		height: 1px;
		background: var(--rail-soft);
	}

	/* Floats over the feed rather than pushing it down: announcing new posts must
	   not itself shift what the reader is looking at. */
	.pill {
		position: sticky;
		top: 0.7rem;
		z-index: var(--z-sticky);
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: max-content;
		margin: 0.7rem auto 0;
		padding: 0.3rem 0.8rem 0.3rem 0.6rem;
		border-radius: 999px;
		border: none;
		background: var(--live);
		color: var(--ink);
		font-size: 0.8rem;
		font-weight: 750;
		box-shadow: 0 4px 8px oklch(0.06 0.03 255 / 0.45);
	}
	.pill::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ink);
	}
	@keyframes pill-pulse {
		0% {
			box-shadow: 0 0 0 0 rgb(246 169 53 / 0.55);
		}
		70% {
			box-shadow: 0 0 0 6px rgb(246 169 53 / 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgb(246 169 53 / 0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pill::before {
			animation: none;
		}
	}

	.muted-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 1rem;
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--fg-dim);
		background: var(--inset);
	}
	.muted-bar button {
		border: none;
		background: transparent;
		color: var(--live-soft);
		font-family: var(--mono);
		font-size: 0.72rem;
		padding: 0;
	}

	/* Same quiet register as the muted bar: a status line with one action, not a
	   toolbar. The count nods to the unread nodes lit down the rail. */
	.read-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 1rem;
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--fg-dim);
		background: var(--inset);
	}
	.read-bar .count {
		color: var(--live-soft);
		font-weight: 600;
	}
	.read-bar button {
		margin-left: auto;
		border: none;
		background: transparent;
		color: var(--live-soft);
		font-family: var(--mono);
		font-size: 0.72rem;
		padding: 0;
	}

	.notice {
		color: var(--fg-soft);
		font-size: 0.9rem;
		padding: var(--space-xl);
		text-align: center;
	}
	.notice.error {
		color: var(--alert);
	}

	code {
		font-family: var(--mono);
		font-size: 0.8rem;
		background: var(--inset);
		padding: 0.1rem 0.3rem;
		border-radius: 4px;
	}

	.sentinel {
		min-height: 1px;
	}
	@media (max-width: 46rem) {
		main { padding-inline: 0; }
		.stream { padding-inline: var(--space-md); }
	}
</style>
