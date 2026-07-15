<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<nav>
	<span class="brand"><span class="brand-mark">d<span>/</span>s</span>dev-stream</span>
	<div class="nav-links">
		<a href="/" class:current={page.url.pathname === '/'}>Timeline</a>
		<a href="/settings" class:current={page.url.pathname === '/settings'}>Settings</a>
	</div>
	<span class="connection"><span></span>Live</span>
</nav>

{@render children()}

<style>
		:global(:root) {
			--ink: oklch(0.14 0.025 255);
			--surface: oklch(0.2 0.032 255);
			--surface-raised: oklch(0.235 0.038 255);
			--inset: oklch(0.115 0.024 255);
			--rail: oklch(0.35 0.045 255);
			--rail-soft: oklch(0.27 0.036 255);
			--fg: oklch(0.96 0.012 255);
			--fg-soft: oklch(0.78 0.025 255);
			--fg-dim: oklch(0.63 0.035 255);
			--live: oklch(0.72 0.18 255);
			--live-soft: oklch(0.82 0.12 255);
			--alert: oklch(0.7 0.2 28);
			--success: oklch(0.78 0.19 142);
			--violet: oklch(0.72 0.2 305);
			--orange: oklch(0.78 0.17 65);
			--cyan: oklch(0.79 0.14 195);
			--accent: var(--live);
			--accent-soft: var(--live-soft);
			--mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
			--sans: ui-rounded, 'SF Pro Rounded', 'Avenir Next', system-ui, sans-serif;
			--space-xs: 0.25rem;
			--space-sm: 0.5rem;
			--space-md: 0.75rem;
			--space-lg: 1rem;
			--space-xl: 1.5rem;
			--radius-sm: 0.5rem;
			--radius-md: 0.75rem;
			--z-dropdown: 20;
			--z-sticky: 30;
			--ease-out: cubic-bezier(0.22, 1, 0.36, 1);
		}

	:global(html),
	:global(body) {
		margin: 0;
		background: var(--ink);
		color: var(--fg);
		font-family: var(--sans);
		-webkit-font-smoothing: antialiased;
	}

	:global(button) {
		font: inherit;
		cursor: pointer;
		color: inherit;
	}

	/* Visible keyboard focus everywhere, in the signal colour. */
	:global(:focus-visible) {
		outline: 2px solid var(--live);
		outline-offset: 2px;
		border-radius: 4px;
	}

	/* The window is the viewport; only the feed scrolls. */
		:global(body) {
			height: 100vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

		nav {
		display: flex;
		align-items: center;
			gap: var(--space-xl);
			padding: 0 var(--space-lg);
			height: 3.5rem;
		flex-shrink: 0;
		border-bottom: 1px solid var(--rail);
			background: var(--surface);
		}

	.brand {
		display: flex;
		align-items: center;
			gap: var(--space-sm);
			font-weight: 700;
			font-size: 0.95rem;
			letter-spacing: -0.02em;
		}
		.brand-mark {
			display: grid;
			place-items: center;
			width: 1.75rem;
			height: 1.75rem;
			border-radius: var(--radius-sm);
			background: var(--live);
			color: var(--ink);
			font-family: var(--mono);
			font-size: 0.72rem;
			box-shadow: 0 4px 8px oklch(0.06 0.03 255 / 0.45);
		}
		.brand-mark span { color: var(--fg); }
		.nav-links { display: flex; align-self: stretch; gap: var(--space-xs); margin-inline: auto; }
		.connection { display: flex; align-items: center; gap: var(--space-sm); color: var(--fg-soft); font-size: 0.78rem; }
		.connection span { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px color-mix(in oklch, var(--success) 18%, transparent); }
		a {
			display: flex;
			align-items: center;
			padding: 0 var(--space-md);
			border-bottom: 2px solid transparent;
			color: var(--fg-dim);
			text-decoration: none;
			font-size: 0.85rem;
			font-weight: 650;
			transition: color 160ms var(--ease-out), border-color 160ms var(--ease-out);
		}
		a:hover {
			color: var(--fg);
		}
		a.current {
			color: var(--fg);
			border-bottom-color: var(--live);
		}
		@media (max-width: 38rem) { .brand { font-size: 0; } .brand-mark { font-size: 0.72rem; } .connection { display: none; } .nav-links { margin-left: auto; margin-right: 0; } }
		@media (prefers-reduced-motion: reduce) { :global(*) { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
	</style>
