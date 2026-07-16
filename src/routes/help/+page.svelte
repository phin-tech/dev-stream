<script lang="ts">
	import {
		globalShortcutDefinitions,
		shortcutTitles,
		timelineShortcutDefinitions
	} from '$lib/shortcut-catalog';
	import { formatShortcut, type ShortcutDefinition } from '$lib/shortcut-engine';

	const navigationIds = new Set([
		'focus-search',
		'select-next',
		'select-previous',
		'jump-to-top',
		'jump-to-bottom',
		'page-down',
		'page-up'
	]);
	const navigation = timelineShortcutDefinitions.filter((command) => navigationIds.has(command.id));
	const actions = timelineShortcutDefinitions.filter((command) => !navigationIds.has(command.id));

	interface Group {
		title: string;
		description: string;
		commands: ShortcutDefinition[];
	}

	const groups: Group[] = [
		{
			title: 'App',
			description: 'Available from every screen, including while a text field is focused.',
			commands: globalShortcutDefinitions
		},
		{
			title: 'Timeline navigation',
			description: 'Move through the stream without moving your hands away from the keyboard.',
			commands: navigation
		},
		{
			title: 'Timeline actions',
			description: 'These act on the selected post or the current timeline.',
			commands: actions
		}
	];
</script>

<main>
	<header class="page-head">
		<div>
			<h1>Keyboard shortcuts</h1>
			<p>macOS conventions for the app, with Vim-style commands for fast timeline triage.</p>
		</div>
		<kbd>?</kbd>
	</header>

	<div class="reference">
		{#each groups as group}
			<section aria-labelledby={`group-${group.title.toLowerCase().replaceAll(' ', '-')}`}>
				<div class="section-head">
					<h2 id={`group-${group.title.toLowerCase().replaceAll(' ', '-')}`}>{group.title}</h2>
					<p>{group.description}</p>
				</div>
				<div class="rows">
					{#each group.commands as command (command.id)}
						<div class="shortcut-row">
							<span>{shortcutTitles[command.id] ?? command.id}</span>
							<span class="bindings">
								{#each command.bindings as binding}
									<kbd>{formatShortcut(binding, 'mac')}</kbd>
								{/each}
							</span>
						</div>
					{/each}
					{#if group.title === 'App'}
						<div class="shortcut-row">
							<span>Saved views 1–9</span>
							<span class="bindings"><kbd>⌘1…⌘9</kbd></span>
						</div>
					{/if}
				</div>
			</section>
		{/each}
	</div>

	<aside class="note" aria-label="Keyboard behavior">
		<strong>Input safety</strong>
		<p>Plain Vim keys are ignored while you type in search, settings, or naming fields. Escape closes the topmost menu or dialog before it clears a timeline filter.</p>
	</aside>
</main>

<style>
	main {
		flex: 1;
		overflow-y: auto;
		width: min(58rem, calc(100% - 2rem));
		margin: 0 auto;
		padding: var(--space-xl) 0 3rem;
		box-sizing: border-box;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		gap: var(--space-xl);
		padding: 0 var(--space-sm) var(--space-xl);
	}
	h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.025em; }
	.page-head p, .section-head p, .note p {
		margin: var(--space-xs) 0 0;
		color: var(--fg-soft);
		font-size: 0.84rem;
		line-height: 1.5;
	}
	.page-head > kbd { margin-left: auto; }
	.reference {
		display: flex;
		flex-direction: column;
		gap: var(--space-xl);
	}
	section {
		display: grid;
		grid-template-columns: minmax(10rem, 15rem) minmax(0, 1fr);
		gap: var(--space-xl);
	}
	.section-head { padding: var(--space-sm); }
	h2 { margin: 0; font-size: 0.9rem; }
	.rows {
		padding: var(--space-xs);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--surface) 76%, var(--ink));
	}
	.shortcut-row {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		min-height: 2.65rem;
		padding: 0 var(--space-md);
		border-radius: var(--radius-sm);
		font-size: 0.84rem;
	}
	.shortcut-row:hover { background: var(--rail-soft); }
	.bindings { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-xs); }
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 1.45rem;
		min-height: 1.45rem;
		padding: 0.08rem 0.38rem;
		box-sizing: border-box;
		border-radius: 5px;
		background: var(--inset);
		color: var(--fg-soft);
		font: 0.72rem var(--mono);
		white-space: nowrap;
	}
	.note {
		margin: var(--space-xl) 0 0 calc(15rem + var(--space-xl));
		padding: var(--space-md);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--live) 8%, var(--surface));
		font-size: 0.82rem;
	}
	.note p { max-width: 68ch; }
	@media (max-width: 46rem) {
		section { grid-template-columns: 1fr; gap: var(--space-sm); }
		.note { margin-left: 0; }
	}
</style>
