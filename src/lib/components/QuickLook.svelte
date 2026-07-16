<script lang="ts">
	import { onMount } from 'svelte';
	import type { Post } from '../../shared/types';
	import { openExternal } from '../api';
	import { absoluteTime, relativeTime, sourceColor } from '../format';
	import { renderMarkdown } from '../markdown';
	import { postLinks } from '../timeline';

	interface Props {
		post: Post;
		onClose: () => void;
	}

	let { post, onClose }: Props = $props();
	let closeButton = $state<HTMLButtonElement | null>(null);
	const body = $derived(post.body ? renderMarkdown(post.body) : null);
	const links = $derived(postLinks(post.meta));

	onMount(() => closeButton?.focus());

	function interceptLinks(event: MouseEvent) {
		const anchor = (event.target as HTMLElement).closest('a');
		if (!anchor) return;
		event.preventDefault();
		const href = anchor.getAttribute('href');
		if (href) void openExternal(href);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" role="presentation" onclick={onClose}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="quick-look"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label="Quick Look: {post.title}"
		onclick={(event) => event.stopPropagation()}
	>
		<header>
			<div class="identity">
				<span class="source" style="--source-color: {sourceColor(post.source)}">{post.source}</span>
				<span class="quick-label">Quick Look</span>
			</div>
			<button bind:this={closeButton} class="close" onclick={onClose} aria-label="Close Quick Look">×</button>
		</header>

		<div class="content">
			<div class="timestamp">
				<time datetime={post.ts} title={absoluteTime(post.ts)}>{relativeTime(post.ts)}</time>
				{#if post.kind}<span>{post.kind}</span>{/if}
			</div>
			<h2>{post.title}</h2>
			{#if body}
				<!-- Sanitized by renderMarkdown. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="body" onclick={interceptLinks}>{@html body}</div>
			{:else if post.summary}
				<p class="summary">{post.summary}</p>
			{:else}
				<p class="summary empty">No additional details.</p>
			{/if}
		</div>

		<footer>
			<div class="metadata">
				{#if post.meta.project}<span>{post.meta.project}</span>{/if}
				{#if post.meta.repo}<span>{post.meta.repo}</span>{/if}
				{#each post.tags as tag}<span>#{tag}</span>{/each}
			</div>
			<div class="actions">
				{#each links as link (link.url)}
					<button onclick={() => openExternal(link.url)}>{link.label} ↗</button>
				{/each}
				<span class="hint"><kbd>Space</kbd> or <kbd>Esc</kbd> to close</span>
			</div>
		</footer>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: grid;
		place-items: center;
		padding: 2rem;
		background: oklch(0.06 0.025 255 / 0.66);
		animation: backdrop-in 140ms var(--ease-out);
	}

	.quick-look {
		display: flex;
		flex-direction: column;
		width: min(46rem, 100%);
		max-height: min(44rem, calc(100vh - 4rem));
		border: 1px solid var(--rail);
		border-radius: var(--radius-lg);
		background: var(--surface-raised);
		color: var(--fg);
		box-shadow: 0 8px 8px oklch(0.04 0.02 255 / 0.36);
		overflow: hidden;
		animation: quick-look-in 180ms var(--ease-out);
	}

	header, footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-lg);
	}

	header { border-bottom: 1px solid var(--rail-soft); }
	footer { border-top: 1px solid var(--rail-soft); }

	.identity, .metadata, .actions, .timestamp {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-width: 0;
	}

	.source {
		padding: 0.24rem 0.55rem;
		border-radius: var(--radius-sm);
		background: var(--source-color);
		color: var(--ink);
		font-size: 0.78rem;
		font-weight: 750;
	}

	.quick-label, .timestamp, .metadata, .hint {
		color: var(--fg-dim);
		font-family: var(--mono);
		font-size: 0.72rem;
	}

	.close {
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--inset);
		color: var(--fg-soft);
		font-size: 1.2rem;
		line-height: 1;
	}

	.close:hover { background: var(--rail); color: var(--fg); }

	.content {
		padding: var(--space-lg);
		overflow-y: auto;
	}

	h2 {
		margin: var(--space-sm) 0 var(--space-md);
		font-size: clamp(1.25rem, 2.6vw, 1.8rem);
		line-height: 1.2;
		letter-spacing: -0.02em;
		text-wrap: balance;
	}

	.body, .summary {
		max-width: 72ch;
		margin: 0;
		color: var(--fg-soft);
		line-height: 1.62;
		text-wrap: pretty;
	}

	.empty { font-style: italic; color: var(--fg-dim); }

	.actions { margin-left: auto; }
	.actions button {
		border: 0;
		border-radius: 999px;
		padding: 0.3rem 0.65rem;
		background: var(--inset);
		color: var(--live-soft);
		font-weight: 650;
	}

	kbd {
		padding: 0.1rem 0.3rem;
		border-radius: 4px;
		background: var(--inset);
		color: var(--fg-soft);
		font: inherit;
	}

	@keyframes backdrop-in { from { opacity: 0; } }
	@keyframes quick-look-in { from { opacity: 0; transform: scale(0.985) translateY(5px); } }

	@media (prefers-reduced-motion: reduce) {
		.backdrop, .quick-look { animation: none; }
	}
</style>
