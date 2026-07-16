<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { globalShortcutDefinitions, shortcutTitles, timelineShortcutDefinitions } from '../shortcut-catalog';
	import { formatShortcut } from '../shortcut-engine';

	type Mode = 'palette' | 'help' | null;
	let mode = $state<Mode>(null);
	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);
	let selectedIndex = $state(0);

	const visibleDefinitions = $derived([
		...globalShortcutDefinitions,
		...(page.url.pathname === '/' ? timelineShortcutDefinitions : [])
	]);
	const paletteDefinitions = $derived(
		visibleDefinitions.filter((definition) =>
			(shortcutTitles[definition.id] ?? definition.id).toLowerCase().includes(query.trim().toLowerCase())
		)
	);
	$effect(() => {
		void query;
		selectedIndex = 0;
	});

	export async function open(next: Exclude<Mode, null>) {
		mode = next;
		query = '';
		selectedIndex = 0;
		if (next === 'palette') {
			await tick();
			searchInput?.focus();
		}
	}

	export function close() {
		mode = null;
		query = '';
	}

	export function isOpen() {
		return mode !== null;
	}

	export function handleKeydown(event: KeyboardEvent): boolean {
		if (!mode) return false;
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return true;
		}
		if (mode !== 'palette') return false;

		const vimDown = event.key === 'j' && query.length === 0;
		const vimUp = event.key === 'k' && query.length === 0;
		if (event.key === 'ArrowDown' || vimDown) {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, Math.max(0, paletteDefinitions.length - 1));
			return true;
		}
		if (event.key === 'ArrowUp' || vimUp) {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			return true;
		}
		if (event.key === 'Enter' && paletteDefinitions[selectedIndex]) {
			event.preventDefault();
			run(paletteDefinitions[selectedIndex].id);
			return true;
		}
		return false;
	}

	function run(id: string) {
		if (id === 'open-command-palette') return void open('palette');
		if (id === 'show-shortcuts') return void open('help');
		if (id === 'open-settings') void goto('/settings');
		else if (id === 'open-timeline') {
			if (page.url.pathname === '/') window.dispatchEvent(new CustomEvent('dev-stream-command', { detail: id }));
			else void goto('/');
		}
		else window.dispatchEvent(new CustomEvent('dev-stream-command', { detail: id }));
		close();
	}

</script>

{#if mode}
	<div class="backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && close()}>
		<div class="overlay" role="dialog" aria-modal="true" aria-label={mode === 'palette' ? 'Command palette' : 'Keyboard shortcuts'}>
			<header>
				<h2>{mode === 'palette' ? 'Command palette' : 'Keyboard shortcuts'}</h2>
				<button class="close" aria-label="Close" onclick={close}>Esc</button>
			</header>
			{#if mode === 'palette'}
				<input bind:this={searchInput} bind:value={query} aria-label="Search commands" aria-controls="command-options" aria-activedescendant={paletteDefinitions[selectedIndex] ? `command-${paletteDefinitions[selectedIndex].id}` : undefined} placeholder="Search commands…" />
			{/if}
			<div class="commands" id="command-options" role={mode === 'palette' ? 'listbox' : undefined}>
				{#each (mode === 'palette' ? paletteDefinitions : visibleDefinitions) as definition, index (definition.id)}
					<button id={`command-${definition.id}`} class="command" class:selected={mode === 'palette' && selectedIndex === index} role={mode === 'palette' ? 'option' : undefined} aria-selected={mode === 'palette' ? selectedIndex === index : undefined} onmouseenter={() => mode === 'palette' && (selectedIndex = index)} onclick={() => run(definition.id)}>
						<span>{shortcutTitles[definition.id] ?? definition.id}</span>
						<span class="bindings">
							{#each definition.bindings as binding}
								<kbd>{formatShortcut(binding, 'mac')}</kbd>
							{/each}
						</span>
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: grid;
		place-items: start center;
		padding-top: min(14vh, 8rem);
		background: oklch(0.05 0.02 255 / 0.62);
	}
	.overlay {
		width: min(36rem, calc(100vw - 2rem));
		max-height: min(70vh, 38rem);
		display: flex;
		flex-direction: column;
		padding: var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--surface-raised);
		box-shadow: 0 8px 8px oklch(0.05 0.02 255 / 0.55);
	}
	header { display: flex; align-items: center; padding: var(--space-sm) var(--space-md); }
	h2 { margin: 0; font-size: 0.95rem; }
	.close { margin-left: auto; border: 0; background: transparent; color: var(--fg-dim); font: 0.72rem var(--mono); }
	input {
		margin: var(--space-xs) var(--space-xs) var(--space-sm);
		padding: 0.72rem var(--space-md);
		border: 1px solid var(--rail);
		border-radius: var(--radius-sm);
		background: var(--inset);
		color: var(--fg);
	}
	.commands { overflow-y: auto; }
	.command {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: 0.65rem var(--space-md);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		text-align: left;
		font-size: 0.84rem;
	}
	.command:hover, .command:focus-visible, .command.selected { background: var(--rail-soft); }
	.command.selected { color: var(--fg); }
	.bindings { margin-left: auto; display: flex; gap: var(--space-xs); }
	kbd {
		min-width: 1.35rem;
		padding: 0.15rem 0.32rem;
		border-radius: 4px;
		background: var(--inset);
		color: var(--fg-soft);
		font: 0.7rem var(--mono);
		text-align: center;
	}
	@media (prefers-reduced-motion: no-preference) {
		.overlay { animation: appear 180ms var(--ease-out); }
		@keyframes appear { from { opacity: 0; transform: translateY(-6px); } }
	}
</style>
