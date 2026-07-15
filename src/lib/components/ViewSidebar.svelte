<script lang="ts">
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
</script>

<aside>
	<button class="view" class:current={activeViewId === null} onclick={onOpenTimeline}>
		<span class="name">Timeline</span>
	</button>

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
		width: 13.4rem;
		flex-shrink: 0;
		border-right: 1px solid var(--rail);
		padding: 0.7rem 0.55rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	h2 {
		font-family: var(--mono);
		font-size: 0.64rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--fg-dim);
		margin: 1rem 0 0.3rem 0.5rem;
	}

	.row {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: 7px;
	}
	.row:hover,
	.row.current,
	.view.current {
		background: var(--rail-soft);
	}
	/* Active view gets an amber tick on the rail edge — the same signal colour as
	   "live" and "unread", so "where am I" reads at a glance. */
	.row.current::before,
	.view.current::before {
		content: '';
		position: absolute;
		left: 0;
		top: 6px;
		bottom: 6px;
		width: 2px;
		border-radius: 2px;
		background: var(--live);
	}

	.view {
		position: relative;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.12rem;
		padding: 0.4rem 0.5rem;
		border: none;
		border-radius: 7px;
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
		font-size: 0.83rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.pin {
		font-size: 0.5rem;
		vertical-align: middle;
		color: var(--live);
	}

	.filter {
		font-family: var(--mono);
		font-size: 0.68rem;
		color: var(--fg-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.unread {
		font-family: var(--mono);
		font-size: 0.64rem;
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
		padding: 0.1rem 0.2rem;
		line-height: 1;
	}
	.actions button:hover {
		color: var(--fg);
	}

	.save {
		margin-top: 0.6rem;
		padding: 0.42rem 0.5rem;
		border: 1px dashed var(--rail);
		border-radius: 7px;
		background: transparent;
		color: var(--fg-dim);
		font-family: var(--mono);
		font-size: 0.72rem;
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
		font-size: 0.75rem;
		color: var(--fg-dim);
		padding: 0 0.5rem;
		line-height: 1.5;
	}
</style>
