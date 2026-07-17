<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		onClose: () => void;
		children: Snippet;
	}

	let { open, title, onClose, children }: Props = $props();

	const uid = $props.id();
	const titleId = `modal-title-${uid}`;

	let panel = $state<HTMLElement | null>(null);
	let restoreFocusTo: HTMLElement | null = null;

	$effect(() => {
		if (open) {
			restoreFocusTo =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
			// The panel itself takes initial focus so Tab starts at the top and
			// screen readers announce the dialog before its contents.
			panel?.focus();
		} else {
			// Return focus to whatever opened us (e.g. the table row's button),
			// otherwise keyboard users get dumped back at the top of the page.
			restoreFocusTo?.focus();
			restoreFocusTo = null;
		}
	});

	/**
	 * Every keypress inside the dialog stops here. The app's global shortcut
	 * engine listens on <svelte:window>, and it must never see keys meant for
	 * the modal (j/k while a button has focus, Esc, letters typed into fields).
	 */
	function onKeydown(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== 'Tab' || !panel) return;

		// Minimal focus trap: wrap Tab at both ends of the dialog.
		const focusable = [
			...panel.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
			)
		];
		if (focusable.length === 0) {
			event.preventDefault();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function onBackdropDown(event: MouseEvent) {
		// mousedown (not click) so a text selection started inside the panel that
		// ends on the backdrop doesn't dismiss the dialog mid-drag.
		if (event.target === event.currentTarget) onClose();
	}
</script>

{#if open}
	<div class="backdrop" role="presentation" onmousedown={onBackdropDown} onkeydown={onKeydown}>
		<div
			class="panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			tabindex="-1"
			bind:this={panel}
		>
			<header>
				<h2 id={titleId}>{title}</h2>
				<button class="close" onclick={onClose} aria-label="Close dialog">×</button>
			</header>
			<div class="body">
				{@render children()}
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
		place-items: center;
		padding: var(--space-lg);
		background: oklch(0.1 0.02 255 / 0.62);
		backdrop-filter: blur(3px);
		animation: fade-in 160ms var(--ease-out);
	}
	.panel {
		width: min(100%, 40rem);
		max-height: min(85vh, 52rem);
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--rail-soft);
		border-radius: var(--radius-md);
		box-shadow: 0 24px 64px oklch(0.05 0.02 255 / 0.6);
		animation: panel-in 200ms var(--ease-out);
	}
	.panel:focus {
		outline: none;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-lg);
		padding: var(--space-lg) var(--space-xl);
		border-bottom: 1px solid var(--rail-soft);
		flex-shrink: 0;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 750;
		letter-spacing: -0.01em;
	}
	.close {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		min-height: 0;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--fg-dim);
		font-size: 1.1rem;
		line-height: 1;
		transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
	}
	.close:hover {
		background: var(--inset);
		border-color: var(--rail);
		color: var(--fg);
	}
	.body {
		padding: var(--space-xl);
		overflow-y: auto;
	}

	@keyframes fade-in {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes panel-in {
		from { opacity: 0; translate: 0 8px; scale: 0.98; }
		to { opacity: 1; translate: 0 0; scale: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.backdrop,
		.panel {
			animation: none;
		}
	}
	@media (max-width: 46rem) {
		.backdrop {
			padding: var(--space-md);
			place-items: end center;
		}
		.panel {
			max-height: 88vh;
		}
		header,
		.body {
			padding: var(--space-lg);
		}
	}
</style>
