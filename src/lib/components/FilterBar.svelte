<script lang="ts">
	import { untrack } from 'svelte';
	import type { Facets, PostFilter } from '../../shared/types';

	interface Props {
		filter: PostFilter;
		facets: Facets;
		onChange: (filter: PostFilter) => void;
	}

	let { filter, facets, onChange }: Props = $props();

	type Dimension = 'source' | 'project' | 'repo' | 'kind' | 'tag';

	const DIMENSIONS: { key: Dimension; label: string }[] = [
		{ key: 'source', label: 'Source' },
		{ key: 'project', label: 'Project' },
		{ key: 'repo', label: 'Repo' },
		{ key: 'kind', label: 'Kind' },
		{ key: 'tag', label: 'Tag' }
	];

	let open = $state<Dimension | null>(null);

	// The search box is debounced, so it owns its own text while the user types --
	// binding it straight to filter.q would fire a query per keystroke.
	let search = $state(untrack(() => filter.q ?? ''));
	let debounce: ReturnType<typeof setTimeout> | undefined;

	// ...but the filter can also change from *outside* the box: Clear, a chip on a
	// card, or a saved view (Phase 4). Adopt those, while ignoring the echo of our
	// own debounced push so we never overwrite what the user is mid-way through
	// typing.
	let lastPushed = $state<string | undefined>(untrack(() => filter.q));
	$effect(() => {
		if (filter.q !== lastPushed) {
			lastPushed = filter.q;
			search = filter.q ?? '';
		}
	});

	const activeCount = $derived(
		DIMENSIONS.reduce((n, d) => n + (filter[d.key]?.length ?? 0), 0) + (filter.q ? 1 : 0)
	);

	function toggle(dimension: Dimension, value: string) {
		const current = filter[dimension] ?? [];
		const next = current.includes(value)
			? current.filter((v) => v !== value)
			: [...current, value];

		// Drop the key entirely when empty so the query string stays clean and a
		// saved view (Phase 4) doesn't persist a meaningless `source: []`.
		const updated: PostFilter = { ...filter, [dimension]: next.length ? next : undefined };
		onChange(updated);
	}

	function onSearchInput() {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			const q = search.trim() || undefined;
			lastPushed = q; // our own change; the sync effect must not echo it back
			onChange({ ...filter, q });
		}, 200);
	}

	function clearAll() {
		clearTimeout(debounce);
		search = '';
		lastPushed = undefined;
		onChange({});
		open = null;
	}
</script>

<!-- Clicking anywhere else closes an open dropdown. -->
<svelte:window onclick={() => (open = null)} />

<div class="bar">
	<input
		type="search"
		placeholder="Search the timeline…"
		bind:value={search}
		oninput={onSearchInput}
	/>

	{#each DIMENSIONS as dimension (dimension.key)}
		{@const values = facets[dimension.key]}
		{@const selected = filter[dimension.key] ?? []}
		<div class="picker">
			<button
				class="trigger"
				class:active={selected.length > 0}
				disabled={values.length === 0}
				onclick={(e) => {
					e.stopPropagation();
					open = open === dimension.key ? null : dimension.key;
				}}
			>
				{dimension.label}{selected.length ? ` (${selected.length})` : ''}
			</button>

			{#if open === dimension.key}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="menu" onclick={(e) => e.stopPropagation()}>
					{#each values as facet (facet.value)}
						<label>
							<input
								type="checkbox"
								checked={selected.includes(facet.value)}
								onchange={() => toggle(dimension.key, facet.value)}
							/>
							<span class="value">{facet.value}</span>
							<!-- Counts come from the server with this dimension's own
							     selections excluded, so they answer "what would I get if
							     I also picked this?" -->
							<span class="count">{facet.count}</span>
						</label>
					{/each}
				</div>
			{/if}
		</div>
	{/each}

	{#if activeCount > 0}
		<button class="clear" onclick={clearAll}>Clear ({activeCount})</button>
	{/if}
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--rail);
		background: color-mix(in oklch, var(--surface) 65%, var(--ink));
		flex-wrap: wrap;
	}

	input[type='search'] {
		flex: 1;
		min-width: 12rem;
		min-height: 2.75rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg);
		font-size: 0.88rem;
	}
	input[type='search']::placeholder {
		color: var(--fg-soft);
	}
	input[type='search']:focus {
		outline: none;
		border-color: var(--live);
	}

	.picker {
		position: relative;
	}

	.trigger {
		font-size: 0.78rem;
		font-weight: 650;
		min-height: 2.75rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg-soft);
		cursor: pointer;
	}
	.trigger:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.trigger.active {
		border-color: var(--live);
		color: var(--live-soft);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: var(--z-dropdown);
		min-width: 12rem;
		max-height: 18rem;
		overflow-y: auto;
		padding: 0.3rem;
		border-radius: 8px;
		border: 1px solid var(--rail);
		background: var(--surface);
		box-shadow: 0 6px 8px oklch(0.06 0.03 255 / 0.55);
	}

	.menu label {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.28rem 0.4rem;
		border-radius: 4px;
		font-size: 0.82rem;
		cursor: pointer;
	}
	.menu label:hover {
		background: var(--inset);
	}
	.menu input[type='checkbox'] {
		accent-color: var(--live);
	}

	.value {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		color: var(--fg-dim);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}

	.clear {
		font-size: 0.78rem;
		font-weight: 650;
		min-height: 2.75rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		background: transparent;
		color: var(--fg-dim);
		cursor: pointer;
	}
	.clear:hover {
		color: var(--fg);
	}
	@media (max-width: 46rem) {
		.bar { padding-inline: var(--space-md); }
		input[type='search'] { flex-basis: 100%; }
	}
</style>
