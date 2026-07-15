<script lang="ts">
	import { onMount, tick } from 'svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import PostCard from '$lib/components/PostCard.svelte';
	import ViewSidebar from '$lib/components/ViewSidebar.svelte';
	import { Feed } from '$lib/feed.svelte';
	import { createView, deleteView, updateView } from '$lib/api';
	import { dayKey, dayLabel } from '$lib/format';
	import type { PostFilter, ViewWithUnread } from '../shared/types';

	const feed = new Feed();

	let scroller = $state<HTMLElement | null>(null);
	let sentinel = $state<HTMLElement | null>(null);

	const mutedCount = $derived(
		feed.muted.muted_sources.length + feed.muted.muted_tags.length
	);

	onMount(() => {
		void feed.start();
		return () => feed.stop();
	});

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

	// --- keyboard nav --------------------------------------------------------

	async function onKeydown(event: KeyboardEvent) {
		// Never steal a keystroke from a text field: `j` belongs to whoever is
		// typing in the search box.
		const target = event.target as HTMLElement | null;
		if (target?.matches('input, textarea, select') || event.metaKey || event.ctrlKey) return;

		if (event.key === 'j' || event.key === 'k') {
			event.preventDefault();
			const index = feed.moveSelection(event.key === 'j' ? 1 : -1);
			if (index < 0) return;

			// The card may not exist yet if selection pulled in a new page.
			await tick();
			scroller
				?.querySelectorAll('article')
				[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}

		if (event.key === 'g') {
			feed.selected = -1;
			scroller?.scrollTo({ top: 0, behavior: 'smooth' });
		}

		// `.` is the conventional "show me what arrived" key in a live feed.
		if (event.key === '.' && feed.pending.length > 0) showNew();
	}

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

	async function togglePin(view: ViewWithUnread) {
		try {
			await updateView(view.id, { pinned: !view.pinned });
			await feed.refreshViews();
		} catch (err) {
			feed.error = String(err);
		}
	}

	function openTimeline() {
		feed.setFilter({});
		scroller?.scrollTo({ top: 0 });
	}

	async function openView(view: ViewWithUnread) {
		await feed.openView(view);
		scroller?.scrollTo({ top: 0 });
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="layout">
	<ViewSidebar
		views={feed.views}
		activeViewId={feed.activeViewId}
		filter={feed.filter}
		onOpen={openView}
		onOpenTimeline={openTimeline}
		onSave={saveView}
		onDelete={removeView}
		onTogglePin={togglePin}
	/>

	<section class="feed">
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

		<main bind:this={scroller}>
			{#if feed.pending.length > 0}
				<button class="pill" onclick={showNew}>
					{feed.pending.length}
					new {feed.pending.length === 1 ? 'post' : 'posts'}
				</button>
			{/if}

			{#if feed.error}
				<p class="notice error">{feed.error}</p>
			{/if}

			{#if feed.loading}
				<p class="notice">Loading…</p>
			{:else if feed.posts.length === 0}
				<p class="notice">
					{#if Object.keys(feed.filter).length > 0}
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

	main {
		flex: 1;
		overflow-y: auto;
		position: relative;
		padding: 0 1rem 2rem;
	}

	/* The time-rail: one continuous hairline spine the whole feed hangs from. It
	   runs through the centre of every post's node (gutter width + half a node). */
	.stream {
		position: relative;
	}
	.stream::before {
		content: '';
		position: absolute;
		top: 6px;
		bottom: 0;
		left: calc(var(--gutter) + (var(--node) / 2) - 0.5px);
		width: 1px;
		background: var(--rail);
	}

	/* A day heading that punctuates the rail; shares the post grid so its label
	   lands in the timestamp gutter. */
	.daymark {
		display: grid;
		grid-template-columns: var(--gutter) 1fr;
		column-gap: 18px;
		align-items: center;
		padding: 0.95rem 0 0.35rem;
	}
	.daymark .lbl {
		font-family: var(--mono);
		font-size: 0.64rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--fg-dim);
		text-align: right;
		padding-right: 8px;
	}
	.daymark .rule {
		height: 1px;
		background: linear-gradient(90deg, var(--rail), transparent);
	}

	/* Floats over the feed rather than pushing it down: announcing new posts must
	   not itself shift what the reader is looking at. */
	.pill {
		position: sticky;
		top: 0.7rem;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: max-content;
		margin: 0.7rem auto 0;
		padding: 0.3rem 0.8rem 0.3rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--live);
		background: var(--surface);
		color: var(--live);
		font-family: var(--mono);
		font-size: 0.74rem;
		font-weight: 600;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.5);
	}
	.pill::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--live);
		animation: pill-pulse 2.4s ease-out infinite;
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
		border-bottom: 1px solid var(--rail);
	}
	.muted-bar button {
		border: none;
		background: transparent;
		color: var(--live-soft);
		font-family: var(--mono);
		font-size: 0.72rem;
		padding: 0;
	}

	.notice {
		color: var(--fg-dim);
		font-size: 0.85rem;
		padding: 1rem;
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
</style>
