<script lang="ts">
	import type { Post } from '../../shared/types';
	import { openExternal } from '../api';
	import { absoluteTime, KIND_TONE, relativeTime, sourceColor } from '../format';
	import { renderMarkdown } from '../markdown';

	interface Props {
		post: Post;
		/** Clicking a chip narrows the feed by that value. */
		onFilter: (dimension: 'source' | 'project' | 'repo' | 'kind' | 'tag', value: string) => void;
		/** Hides this source/tag from the timeline for good (until unmuted). */
		onMute: (dimension: 'source' | 'tag', value: string) => void;
		/** Keyboard selection (j/k). */
		selected?: boolean;
		/** Just arrived live -- its node on the rail pulses briefly. */
		fresh?: boolean;
	}

	let { post, onFilter, onMute, selected = false, fresh = false }: Props = $props();

	let menuOpen = $state(false);

	// Recomputed only when the body changes -- sanitizing markdown on every
	// re-render of a 50-card feed would be wasteful.
	const body = $derived(post.body ? renderMarkdown(post.body) : null);
	const tone = $derived(KIND_TONE[post.kind] ?? null);
	// `meta` minus the keys already surfaced as chips or badges, so the raw view
	// adds information instead of repeating it.
	const SHOWN = ['project', 'repo', 'url', 'state', 'author'];
	const extraMeta = $derived(
		Object.fromEntries(Object.entries(post.meta).filter(([key]) => !SHOWN.includes(key)))
	);

	// NB: not called `state` -- a local by that name makes Svelte parse the
	// `$state(...)` rune above as a store subscription of it, which is a baffling
	// error to debug.
	/** Integrations post a state ("merged", "open", "In Progress"); badge it. */
	const itemState = $derived(typeof post.meta.state === 'string' ? post.meta.state : null);
	const author = $derived(typeof post.meta.author === 'string' ? post.meta.author : null);

	/**
	 * Colour by meaning, not by literal string: GitHub says "merged"/"closed",
	 * Linear says whatever the team renamed its columns to. Fall back to neutral
	 * rather than guessing wrong.
	 */
	const stateTone = $derived.by(() => {
		const value = (itemState ?? '').toLowerCase();
		const type = String(post.meta.state_type ?? '').toLowerCase();
		if (value === 'merged' || type === 'completed') return 'done';
		if (value === 'closed' || type === 'canceled') return 'closed';
		if (value === 'open' || type === 'started') return 'live';
		if (value === 'draft') return 'muted';
		return 'neutral';
	});

	/**
	 * Anchors inside rendered markdown would navigate the *app window* to the
	 * target site, replacing the timeline with no way back. Intercept every link
	 * click in the body and hand the URL to the OS instead.
	 */
	function interceptLinks(event: MouseEvent) {
		const anchor = (event.target as HTMLElement).closest('a');
		if (!anchor) return;
		event.preventDefault();
		const href = anchor.getAttribute('href');
		if (href) void openExternal(href);
	}
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<article
	class="post"
	class:alert={tone === 'alert'}
	class:selected
	class:fresh
>
	<!-- Left gutter: the time, in the machine voice, sitting on the rail node. -->
	<div class="when">
		<time datetime={post.ts} title={absoluteTime(post.ts)}>{relativeTime(post.ts)}</time>
	</div>

	<div class="content">
		<header>
			<button
				class="source"
				style="--source-color: {sourceColor(post.source)}"
				onclick={() => onFilter('source', post.source)}
				title="Filter by {post.source}"
			>
				{post.source}
			</button>

			{#if tone}
				<button class="kind {tone}" onclick={() => onFilter('kind', post.kind)}>{post.kind}</button>
			{/if}

			<h2>{post.title}</h2>

			<div class="more">
				<button
					class="dots"
					title="Mute…"
					onclick={(e) => {
						e.stopPropagation();
						menuOpen = !menuOpen;
					}}
				>
					⋯
				</button>
				{#if menuOpen}
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div class="menu" onclick={(e) => e.stopPropagation()}>
						<button onclick={() => { onMute('source', post.source); menuOpen = false; }}>
							Mute source <code>{post.source}</code>
						</button>
						{#each post.tags as tag (tag)}
							<button onclick={() => { onMute('tag', tag); menuOpen = false; }}>
								Mute tag <code>#{tag}</code>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</header>

		{#if body}
			<!-- Sanitized in renderMarkdown(); see the note there on why this is safe. -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="body" onclick={interceptLinks}>{@html body}</div>
		{/if}

		<footer>
			{#if itemState}
				<span class="state {stateTone}">{itemState}</span>
			{/if}
			{#if author}
				<span class="author">{author}</span>
			{/if}

			{#if post.meta.project}
				<button class="chip" onclick={() => onFilter('project', post.meta.project!)}>
					{post.meta.project}
				</button>
			{/if}
			{#if post.meta.repo}
				<button class="chip" onclick={() => onFilter('repo', post.meta.repo!)}>
					{post.meta.repo}
				</button>
			{/if}
			{#each post.tags as tag (tag)}
				<button class="chip tag" onclick={() => onFilter('tag', tag)}>{tag}</button>
			{/each}

			{#if post.meta.url}
				<button class="chip link" onclick={() => openExternal(String(post.meta.url))}>open ↗</button>
			{/if}

			{#if Object.keys(extraMeta).length > 0}
				<details class="meta">
					<summary>meta</summary>
					<pre>{JSON.stringify(extraMeta, null, 2)}</pre>
				</details>
			{/if}
		</footer>
	</div>
</article>

<style>
	/* A post is one row of the time-rail: [ time gutter | content ], with a node
	   sitting on the spine that the feed draws behind the whole column. */
	.post {
		display: grid;
		grid-template-columns: var(--gutter) 1fr;
		column-gap: 18px;
		padding: 0.7rem 0 0.75rem;
		border-bottom: 1px solid var(--rail-soft);
	}
	.post:hover {
		background: color-mix(in srgb, var(--surface) 55%, transparent);
	}
	.post.selected {
		background: var(--inset);
	}

	/* --- the gutter + the node on the rail --- */
	.when {
		position: relative;
		text-align: right;
		padding-top: 0.1rem;
		padding-right: 8px;
	}
	.when time {
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--fg-dim);
		white-space: nowrap;
	}
	.post.selected .when time {
		color: var(--live-soft);
	}
	/* The node. Quiet by default; the rail is what carries the eye, not the dots. */
	.when::after {
		content: '';
		position: absolute;
		top: 0.32rem;
		right: calc(-9px - (var(--node) / 2) + 0.5px);
		width: var(--node);
		height: var(--node);
		border-radius: 50%;
		background: var(--ink);
		border: 1.5px solid var(--rail);
		box-shadow: 0 0 0 3px var(--ink); /* mask the spine behind the node */
	}
	.post:hover .when::after {
		border-color: var(--fg-dim);
	}
	.post.selected .when::after {
		border-color: var(--live);
	}
	.post.alert .when::after {
		border-color: var(--alert);
		background: color-mix(in srgb, var(--alert) 30%, var(--ink));
	}
	.post.fresh .when::after {
		border-color: var(--live);
		background: var(--live);
		animation: node-pulse 2.4s ease-out infinite;
	}
	@keyframes node-pulse {
		0% {
			box-shadow: 0 0 0 3px var(--ink), 0 0 0 3px rgb(246 169 53 / 0.5);
		}
		70% {
			box-shadow: 0 0 0 3px var(--ink), 0 0 0 9px rgb(246 169 53 / 0);
		}
		100% {
			box-shadow: 0 0 0 3px var(--ink), 0 0 0 9px rgb(246 169 53 / 0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.post.fresh .when::after {
			animation: none;
		}
	}

	.content {
		min-width: 0;
	}

	.more {
		position: relative;
		flex-shrink: 0;
		margin-left: auto;
	}
	.dots {
		border: none;
		background: transparent;
		color: var(--fg-dim);
		padding: 0 0.15rem;
		line-height: 1;
		opacity: 0;
	}
	/* Hidden until the card is under the cursor: a mute button on every row would
	   be visual noise on a feed you mostly just read. */
	.post:hover .dots,
	.post.selected .dots {
		opacity: 1;
	}
	.dots:hover {
		color: var(--fg);
	}

	.menu {
		position: absolute;
		top: 100%;
		right: 0;
		z-index: 10;
		min-width: 12rem;
		padding: 0.25rem;
		border-radius: 8px;
		border: 1px solid var(--rail);
		background: var(--surface);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.5);
		display: flex;
		flex-direction: column;
	}
	.menu button {
		border: none;
		background: transparent;
		color: var(--fg-soft);
		font-size: 0.78rem;
		text-align: left;
		padding: 0.3rem 0.4rem;
		border-radius: 4px;
		white-space: nowrap;
	}
	.menu button:hover {
		background: var(--inset);
		color: var(--fg);
	}
	.menu code {
		font-family: var(--mono);
		color: var(--fg-dim);
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	/* Human voice: the headline is the one thing a person reads on each row. */
	h2 {
		font-family: var(--sans);
		font-size: 0.93rem;
		font-weight: 500;
		margin: 0;
		flex: 1;
		min-width: 0;
		line-height: 1.35;
		word-break: break-word;
	}
	.post.alert h2 {
		color: #ffd9d2;
	}

	/* Machine voice: source, kind, and everything below is mono and quiet. */
	.source {
		font-family: var(--mono);
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		padding: 0.08rem 0.4rem;
		border-radius: 5px;
		border: none;
		color: var(--source-color);
		background: color-mix(in srgb, var(--source-color) 14%, transparent);
		white-space: nowrap;
	}

	.kind {
		font-family: var(--mono);
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 0.1rem 0.36rem;
		border-radius: 5px;
		color: var(--fg-dim);
		border: 1px solid var(--rail);
		background: transparent;
	}
	.kind.alert {
		background: color-mix(in srgb, var(--alert) 12%, transparent);
		color: var(--alert);
		border-color: color-mix(in srgb, var(--alert) 40%, transparent);
	}
	.kind.accent {
		color: var(--live-soft);
		border-color: color-mix(in srgb, var(--live) 35%, transparent);
	}
	.kind.muted {
		color: var(--fg-dim);
	}

	.body {
		font-family: var(--sans);
		margin: 0.35rem 0 0 0;
		font-size: 0.86rem;
		color: var(--fg-soft);
		line-height: 1.5;
		overflow-wrap: break-word;
	}
	.body :global(p) {
		margin: 0 0 0.4rem;
	}
	.body :global(pre) {
		font-family: var(--mono);
		background: var(--inset);
		border: 1px solid var(--rail-soft);
		border-left: 2px solid var(--rail);
		padding: 0.55rem 0.7rem;
		border-radius: 7px;
		overflow-x: auto;
		font-size: 0.78rem;
		color: var(--fg-soft);
	}
	.body :global(code) {
		font-family: var(--mono);
		font-size: 0.85em;
	}
	.body :global(:not(pre) > code) {
		background: var(--inset);
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
	}
	.body :global(a) {
		color: var(--live-soft);
	}
	.body :global(img) {
		max-width: 100%;
	}

	footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.34rem;
		margin-top: 0.5rem;
	}
	footer:empty {
		display: none;
	}

	.chip {
		font-family: var(--mono);
		font-size: 0.7rem;
		padding: 0.07rem 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--rail);
		color: var(--fg-dim);
		background: transparent;
	}
	.chip:hover {
		border-color: var(--live);
		color: var(--live-soft);
	}
	.chip.tag {
		color: var(--fg-soft);
	}
	.chip.tag::before {
		content: '#';
		color: var(--fg-dim);
	}
	.chip.tag:hover::before {
		color: var(--live);
	}

	/* PR/issue state. Not a filter chip — it's a fact about the item, not
	   something you'd want to narrow the feed by. */
	.state {
		font-family: var(--mono);
		font-size: 0.66rem;
		padding: 0.07rem 0.42rem;
		border-radius: 999px;
		border: 1px solid currentColor;
	}
	.state.done {
		color: #b794f6;
	}
	.state.closed {
		color: var(--alert);
	}
	.state.live {
		color: #63d6a0;
	}
	.state.muted,
	.state.neutral {
		color: var(--fg-dim);
	}

	.author {
		font-family: var(--mono);
		font-size: 0.7rem;
		color: var(--fg-dim);
	}

	.meta {
		font-family: var(--mono);
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	.meta summary {
		cursor: pointer;
		padding: 0.08rem 0.4rem;
	}
	.meta pre {
		margin: 0.3rem 0 0;
		padding: 0.5rem;
		background: var(--inset);
		border: 1px solid var(--rail-soft);
		border-radius: 7px;
		overflow-x: auto;
		font-size: 0.72rem;
	}

	button {
		cursor: pointer;
		font: inherit;
		font-size: inherit;
	}
</style>
