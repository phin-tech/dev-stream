<script lang="ts">
	import { onMount } from 'svelte';
	import { escapeIntent } from '../interaction-policy';
	import { resolveSidebarCollapsed, type SidebarOverride } from '../timeline';
	import type { PostFilter, ViewWithUnread } from '../../shared/types';

	interface Props {
		views: ViewWithUnread[];
		activeViewId: string | null;
		/** The filter currently in the bar — what "Save this view" would capture. */
		filter: PostFilter;
		onOpen: (view: ViewWithUnread) => void;
		onOpenTimeline: () => void;
		onSave: (name: string) => void;
		onDelete: (view: ViewWithUnread) => void;
		onTogglePin: (view: ViewWithUnread) => void;
	}

	let { views, activeViewId, filter, onOpen, onOpenTimeline, onSave, onDelete, onTogglePin }: Props =
		$props();

	let naming = $state(false);
	let name = $state('');
	let narrow = $state(false);
	let override = $state<SidebarOverride>(null);
	const collapsed = $derived(resolveSidebarCollapsed({ narrow, override }));

	onMount(() => {
		const media = window.matchMedia('(max-width: 46rem)');
		const sync = () => (narrow = media.matches);
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	});

	// Nothing selected in the filter bar means there is nothing to save; a view
	// that matches everything is just the timeline.
	const hasFilter = $derived(Object.values(filter).some((v) => (Array.isArray(v) ? v.length : v)));

	/** A readable summary of what a view actually filters on. */
	function describe(f: PostFilter): string {
		const parts = [
			...(f.source ?? []),
			...(f.project ?? []),
			...(f.repo ?? []),
			...(f.kind ?? []),
			...(f.tag ?? []).map((t) => `#${t}`)
		];
		if (f.q) parts.push(`"${f.q}"`);
		return parts.join(' · ') || 'everything';
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		onSave(name.trim());
		name = '';
		naming = false;
	}

	function handleNameKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (escapeIntent({ menuOpen: false, namingView: naming, hasFilter }) !== 'cancel-view-naming') return;
		event.preventDefault();
		event.stopPropagation();
		name = '';
		naming = false;
	}
</script>

<aside class:collapsed>
	<div class="sidebar-head">
		<button class="view" class:current={activeViewId === null} onclick={onOpenTimeline}>
			<span class="timeline-dot" aria-hidden="true"></span>
			<span class="name">Timeline</span>
		</button>
		<button
			class="sidebar-toggle"
			aria-expanded={!collapsed}
			aria-label={collapsed ? 'Expand views sidebar' : 'Collapse views sidebar'}
			title={collapsed ? 'Expand views sidebar' : 'Collapse views sidebar'}
			onclick={() => (override = collapsed ? 'expanded' : 'collapsed')}
		>
			<span class:forward={collapsed} aria-hidden="true"></span>
		</button>
	</div>

	<h2>Views</h2>

	{#each views as view (view.id)}
		<div class="row" class:current={activeViewId === view.id}>
			<button class="view" onclick={() => onOpen(view)}>
				<span class="name">
					{#if view.pinned}<span class="pin" title="Pinned">●</span>{/if}
					{view.name}
				</span>
				<span class="filter">{describe(view.filter)}</span>
			</button>

			{#if view.unread > 0}
				<span class="unread" title="{view.unread} new since you last opened this">
					{view.unread > 99 ? '99+' : view.unread}
				</span>
			{/if}

			<div class="actions">
				<button title={view.pinned ? 'Unpin' : 'Pin'} onclick={() => onTogglePin(view)}>
					{view.pinned ? '○' : '●'}
				</button>
				<button title="Delete this view" onclick={() => onDelete(view)}>×</button>
			</div>
		</div>
	{/each}

	{#if views.length === 0 && !naming}
		<p class="empty">Filter the timeline, then save it as a view.</p>
	{/if}

	{#if naming}
		<form onsubmit={submit}>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:value={name}
				placeholder="View name"
				autofocus
				onkeydown={handleNameKeydown}
				onblur={() => !name.trim() && (naming = false)}
			/>
		</form>
	{:else}
		<button class="save" disabled={!hasFilter} onclick={() => (naming = true)}>
			{hasFilter ? '+ Save this filter' : '+ Save a view'}
		</button>
	{/if}
</aside>

<style>
	aside {
		width: 14.5rem;
		flex-shrink: 0;
		border-right: 1px solid var(--rail);
		padding: var(--space-lg) var(--space-md);
		background: color-mix(in oklch, var(--surface) 70%, var(--ink));
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	aside.collapsed {
		width: 3.25rem;
		padding-inline: var(--space-sm);
		align-items: center;
	}
	aside.collapsed > :not(.sidebar-head) { display: none; }
	.sidebar-head {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		width: 100%;
		min-height: 2.75rem;
	}
	.sidebar-head .view {
		flex: 1;
		flex-direction: row;
		align-items: center;
		min-height: 2.5rem;
		box-sizing: border-box;
	}
	.timeline-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--live);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--live) 16%, transparent);
		flex: none;
	}
	.sidebar-toggle {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		flex: none;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--fg-soft);
	}
	.sidebar-toggle span {
		width: 0.45rem;
		height: 0.45rem;
		border-left: 2px solid currentColor;
		border-bottom: 2px solid currentColor;
		transform: rotate(45deg);
	}
	.sidebar-toggle span.forward { transform: rotate(225deg); }
	.sidebar-toggle:hover { border-color: var(--rail); background: var(--surface-raised); color: var(--fg); }
	aside.collapsed .sidebar-head { justify-content: center; }
	aside.collapsed .sidebar-head .view { display: none; }

	h2 {
		font-size: 0.78rem;
		font-weight: 750;
		color: var(--fg-soft);
		margin: var(--space-lg) var(--space-sm) var(--space-xs);
	}

	.row {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius-sm);
	}
	.row:hover,
	.row.current,
	.view.current {
		background: var(--rail-soft);
	}
	/* Active view gets an amber tick on the rail edge — the same signal colour as
	   "live" and "unread", so "where am I" reads at a glance. */
	.row.current,
	.view.current { background: color-mix(in oklch, var(--live) 12%, var(--surface)); }

	.view {
		position: relative;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xs);
		padding: var(--space-sm) var(--space-md);
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--fg-soft);
		text-align: left;
	}
	/* Only a view *inside a row* fills the width beside its unread badge; the
	   standalone Timeline button must size to its content, not grow to fill the
	   whole sidebar column. */
	.row .view {
		flex: 1;
	}
	.view.current .name,
	.row.current .name {
		color: var(--fg);
	}

	.name {
		font-size: 0.88rem;
		font-weight: 650;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.pin {
		font-size: 0.75rem;
		vertical-align: middle;
		color: var(--live);
	}

	.filter {
		font-size: 0.75rem;
		color: var(--fg-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.unread {
		font-size: 0.75rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		padding: 0.05rem 0.32rem;
		border-radius: 999px;
		background: var(--live);
		color: #1a1206;
		flex-shrink: 0;
		margin-right: 0.2rem;
	}

	/* Revealed on hover: destructive and fiddly controls shouldn't compete with
	   the view names for attention. */
	.actions {
		display: none;
		gap: 0.1rem;
		padding-right: 0.2rem;
	}
	.row:hover .actions {
		display: flex;
	}
	.actions button {
		border: none;
		background: transparent;
		color: var(--fg-dim);
		font-size: 0.75rem;
		min-width: 2.25rem;
		min-height: 2.25rem;
		line-height: 1;
	}
	.actions button:hover {
		color: var(--fg);
	}

	.save {
		margin-top: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		border: 1px dashed var(--rail);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--fg-dim);
		font-size: 0.78rem;
		text-align: left;
	}
	.save:hover:not(:disabled) {
		border-color: var(--live);
		color: var(--live-soft);
	}
	.save:disabled {
		opacity: 0.45;
		cursor: default;
	}

	input {
		width: 100%;
		box-sizing: border-box;
		margin-top: 0.6rem;
		padding: 0.42rem 0.5rem;
		border-radius: 7px;
		border: 1px solid var(--live);
		background: var(--inset);
		color: var(--fg);
		font-family: var(--mono);
		font-size: 0.78rem;
	}

	.empty {
		font-size: 0.8rem;
		color: var(--fg-soft);
		padding: 0 0.5rem;
		line-height: 1.5;
	}
	@media (max-width: 46rem) {
		aside:not(.collapsed) { width: 14.5rem; padding-inline: var(--space-sm); }
		.filter { display: none; }
	}
</style>
