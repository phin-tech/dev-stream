<script lang="ts">
	import { escapeIntent } from '../interaction-policy';
	import type { Post } from '../../shared/types';
	import { openExternal } from '../api';
	import { absoluteTime, KIND_TONE, relativeTime, sourceColor } from '../format';
	import { renderMarkdown } from '../markdown';
	import { needsProgressiveDisclosure, postLinks, resolvePostPreview } from '../timeline';

	interface Props {
		post: Post;
		/** Clicking a chip narrows the feed by that value. */
		onFilter: (dimension: 'source' | 'project' | 'repo' | 'kind' | 'tag', value: string) => void;
		/** Hides this source/tag from the timeline for good (until unmuted). */
		onMute: (dimension: 'source' | 'tag', value: string) => void;
		/** Sets this post's read state: true when it's interacted with, false to mark unread. */
		onSeenChange: (seen: boolean) => void;
		onArchive: () => void;
		/** Keyboard selection (j/k). */
		selected?: boolean;
		/** Just arrived live -- its node on the rail pulses briefly. */
		fresh?: boolean;
	}

	let { post, onFilter, onMute, onSeenChange, onArchive, selected = false, fresh = false }: Props = $props();

	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>(null);

	function handleMenuKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (escapeIntent({ menuOpen, namingView: false, hasFilter: false }) !== 'close-menu') return;
		event.preventDefault();
		event.stopPropagation();
		menuOpen = false;
		menuButton?.focus();
	}
	let expanded = $state(false);

	// Recomputed only when the body changes -- sanitizing markdown on every
	// re-render of a 50-card feed would be wasteful.
	const body = $derived(post.body ? renderMarkdown(post.body) : null);
	const collapsible = $derived(Boolean(post.body && (post.summary?.trim() || needsProgressiveDisclosure(post.body))));
	const preview = $derived(resolvePostPreview(post));
	const tone = $derived(KIND_TONE[post.kind] ?? null);
	// `meta` minus the keys already surfaced as chips or badges, so the raw view
	// adds information instead of repeating it.
	const SHOWN = ['project', 'repo', 'url', 'links', 'state', 'author'];
	const extraMeta = $derived(
		Object.fromEntries(Object.entries(post.meta).filter(([key]) => !SHOWN.includes(key)))
	);

	const links = $derived(postLinks(post.meta));

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

<!-- The whole card is a "seen" target: clicking anywhere in it marks it read, the
     same as selecting it with j/k. data-post-id lets the page's scroll observer
     mark it seen once it leaves the viewport (when that setting is on). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
<article
	class="post"
	class:alert={tone === 'alert'}
	class:selected
	class:fresh
	class:seen={post.seen}
	class:collapsible
	class:expanded
	data-post-id={post.id}
	onclick={() => onSeenChange(true)}
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

			<div class="more" onkeydown={handleMenuKeydown}>
				<button
					bind:this={menuButton}
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
						<button onclick={() => { onArchive(); menuOpen = false; }}>
							{post.archived ? 'Restore' : 'Archive'}
						</button>
						{#if post.seen}
							<button onclick={() => { onSeenChange(false); menuOpen = false; }}>
								Mark as unread
							</button>
						{/if}
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

		{#if preview || body}
			{#if collapsible && !expanded}
				<p class="preview">{preview}</p>
			{:else if body}
				<!-- Sanitized in renderMarkdown(); see the note there on why this is safe. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="body" onclick={interceptLinks}>{@html body}</div>
			{:else}
				<p class="preview">{preview}</p>
			{/if}
			{#if collapsible}
				<button
					class="disclosure"
					data-disclosure-toggle
					aria-expanded={expanded}
					aria-label={expanded ? 'Collapse post details' : 'Expand post details'}
					title={expanded ? 'Show less' : 'Show details'}
					onclick={(event) => {
						event.stopPropagation();
						expanded = !expanded;
						if (expanded) onSeenChange(true);
					}}
				>
					<span aria-hidden="true">{expanded ? '↑' : '↓'}</span>
				</button>
			{/if}
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

			{#each links as link (link.url)}
				<button class="chip link" onclick={() => openExternal(link.url)}>{link.label} ↗</button>
			{/each}

			{#if Object.keys(extraMeta).length > 0}
				<details class="meta">
					<summary>Details</summary>
					<dl>
						{#each Object.entries(extraMeta) as [key, value] (key)}
							<dt>{key}</dt>
							<dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
						{/each}
					</dl>
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
		grid-template-columns: 3.5rem 1fr;
		gap: var(--space-md);
		padding: 0.375rem var(--space-md);
		margin-block: 0;
		border: 0;
		border-bottom: 1px solid var(--rail-soft);
		border-radius: 0;
		background: transparent;
		transition: transform 180ms var(--ease-out), border-color 180ms var(--ease-out), background 180ms var(--ease-out);
	}
	.post:hover {
		border-radius: 0.625rem;
		border-bottom-color: transparent;
		background: color-mix(in oklch, var(--surface-raised) 55%, transparent);
	}
	.post.selected {
		border-bottom-color: transparent;
		box-shadow: inset 0 0 0 1px var(--live);
		background: color-mix(in oklch, var(--surface-raised) 88%, var(--live));
	}

	/* --- the gutter + the node on the rail --- */
	.when {
		text-align: left;
		padding-top: 0.15rem;
	}
	.when time {
		font-size: 0.75rem;
		font-weight: 650;
		color: var(--fg-soft);
		white-space: nowrap;
	}
	.post.selected .when time {
		color: var(--live-soft);
	}
	/* The node. Quiet by default; the rail is what carries the eye, not the dots. */
	.post:not(.seen) .when::before {
		content: '';
		display: inline-block;
		width: 0.4rem;
		height: 0.4rem;
		margin-right: var(--space-sm);
		border-radius: 50%;
		background: var(--live);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--live) 14%, transparent);
	}
	.post.alert { border-color: color-mix(in oklch, var(--alert) 65%, var(--rail)); }
	.post.fresh { animation: card-arrival 200ms var(--ease-out); }
	@keyframes card-arrival { from { transform: translateY(-0.4rem); filter: brightness(1.25); } }
	@media (prefers-reduced-motion: reduce) {
		.post.fresh { animation: none; }
	}

	.content {
		min-width: 0;
		position: relative;
	}
	.post.collapsible .content { padding-right: 2rem; }

	.more {
		position: relative;
		flex-shrink: 0;
		margin-left: auto;
	}
	.dots {
		border: none;
		background: transparent;
		color: var(--fg-dim);
		min-width: 1.75rem;
		min-height: 1.75rem;
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
		z-index: var(--z-dropdown);
		min-width: 12rem;
		padding: 0.25rem;
		border-radius: 8px;
		border: 1px solid var(--rail);
		background: var(--surface);
		box-shadow: 0 6px 8px oklch(0.06 0.03 255 / 0.55);
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
		align-items: center;
		gap: var(--space-xs) var(--space-sm);
		flex-wrap: wrap;
	}

	/* Human voice: the headline is the one thing a person reads on each row. */
	h2 {
		font-family: var(--sans);
		font-size: 1rem;
		font-weight: 720;
		margin: 0;
		flex: 1;
		min-width: 0;
		line-height: 1.25;
		word-break: break-word;
	}
	.post.alert h2 {
		color: #ffd9d2;
	}
	/* Already read: let the headline recede so the eye skips to what's still unread. */
	.post.seen h2 {
		color: var(--fg-soft);
	}

	/* Machine voice: source, kind, and everything below is mono and quiet. */
	.source {
		font-size: 0.75rem;
		font-weight: 750;
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-sm);
		border: none;
		color: var(--ink);
		background: var(--source-color);
		white-space: nowrap;
	}

	.kind {
		font-size: 0.75rem;
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-sm);
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
		margin: var(--space-xs) 0 0;
		font-size: 0.86rem;
		color: var(--fg-soft);
		line-height: 1.42;
		overflow-wrap: break-word;
	}
	.preview {
		margin: var(--space-xs) 0 0;
		overflow: hidden;
		color: var(--fg-soft);
		font-size: 0.84rem;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.post.collapsible:not(.expanded) footer { display: none; }
	.disclosure {
		position: absolute;
		right: 0;
		top: 1.35rem;
		display: grid;
		place-items: center;
		width: 1.75rem;
		min-height: 1.75rem;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--live-soft);
		font-size: 0.9rem;
		font-weight: 750;
	}
	.disclosure:hover { color: var(--fg); }
	.body :global(p) {
		margin: 0 0 0.4rem;
	}
	.body :global(pre) {
		font-family: var(--mono);
		background: var(--inset);
		border: 1px solid var(--rail-soft);
		padding: var(--space-md);
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
		gap: var(--space-xs) var(--space-sm);
		margin-top: var(--space-xs);
	}
	footer:empty {
		display: none;
	}

	.chip {
		font-size: 0.75rem;
		padding: 0;
		border-radius: 0;
		border: 0;
		color: var(--fg-dim);
		background: transparent;
	}
	.chip:hover {
		color: var(--live-soft);
		text-decoration: underline;
		text-underline-offset: 0.18em;
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
	.chip.link {
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		border: 1px solid color-mix(in oklch, var(--live) 45%, var(--rail));
		color: var(--live-soft);
		font-weight: 650;
	}

	/* PR/issue state. Not a filter chip — it's a fact about the item, not
	   something you'd want to narrow the feed by. */
	.state {
		font-size: 0.75rem;
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
		font-size: 0.75rem;
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
	.meta dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.15rem var(--space-md);
		margin: 0.3rem 0 0;
		padding: 0.5rem 0.6rem;
		background: var(--inset);
		border: 1px solid var(--rail-soft);
		border-radius: 7px;
	}
	.meta dt {
		color: var(--fg-dim);
	}
	.meta dd {
		margin: 0;
		color: var(--fg-soft);
		word-break: break-word;
	}

	button {
		cursor: pointer;
		font: inherit;
		font-size: inherit;
	}
	@media (max-width: 40rem) {
		.post { grid-template-columns: 1fr; gap: var(--space-sm); }
		.when { order: 2; }
		header h2 { flex-basis: 100%; order: 2; }
		.more { margin-left: auto; }
	}
	/* On touch there is no hover, so the ⋯ menu and disclosure can't be
	   revealed by cursor — and their 28px default is below the 44px touch
	   target. Bring them into view and up to size. */
	@media (hover: none) and (pointer: coarse) {
		.dots,
		.disclosure {
			opacity: 1;
			min-width: var(--target);
			min-height: var(--target);
		}
		.dots { color: var(--fg-soft); }
		.chip {
			min-height: var(--target);
			padding: 0 var(--space-sm);
		}
	}
</style>
