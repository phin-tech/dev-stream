<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<nav>
	<span class="brand"><span class="live-dot"></span>dev<span class="slash">/</span>stream</span>
	<a href="/" class:current={page.url.pathname === '/'}>timeline</a>
	<a href="/settings" class:current={page.url.pathname === '/settings'}>settings</a>
</nav>

{@render children()}

<style>
	/* One dark theme — deliberately. This window sits alongside a terminal all day,
	   so it reads as ink: a deep, cool blue-slate (not pure black) with a single
	   warm signal colour. The feed is a live stream of machine events, so the design
	   commits to two ideas: a *time-rail* (a literal chronological spine down the
	   feed, git-log-graph vernacular) and *two voices* — a mono "machine voice" for
	   timestamps, sources, kinds, tags and data, and a sans "human voice" for
	   titles and prose. Amber is the one warm accent: live, now, unread, active. */
	:global(:root) {
		--ink: #0d0f14; /* app background */
		--surface: #14161d; /* raised chrome */
		--inset: #090a0e; /* wells: code, inputs */
		--rail: #232a37; /* the time-rail + hairlines */
		--rail-soft: #1a1f29; /* row dividers, hover */

		--fg: #e7e9ee;
		--fg-soft: #9aa0ad;
		--fg-dim: #5f6672;

		--live: #f6a935; /* the warm signal: live pulse, unread, active view */
		--live-soft: #ffc266;
		--alert: #ff6b5c;

		/* Kept for source-hued badges; a few components still reference --accent. */
		--accent: var(--live);
		--accent-soft: var(--live-soft);

		--mono: ui-monospace, 'SF Mono', SFMono-Regular, 'JetBrains Mono', Menlo, monospace;
		--sans: ui-sans-serif, -apple-system, 'Inter', system-ui, sans-serif;

		/* The time-rail geometry, shared by the feed and its cards. */
		--gutter: 62px; /* width of the timestamp column left of the rail */
		--node: 9px; /* the dot each post sits on */
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
		gap: 1.1rem;
		padding: 0 1rem;
		height: 46px;
		flex-shrink: 0;
		border-bottom: 1px solid var(--rail);
		background: linear-gradient(var(--surface), var(--ink));
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--mono);
		font-weight: 600;
		font-size: 0.86rem;
		letter-spacing: -0.01em;
		margin-right: auto;
	}
	.slash {
		color: var(--live);
	}

	/* A slow pulse on the brand mark: the stream is live. One animated thing. */
	.live-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--live);
		animation: brand-pulse 2.4s ease-out infinite;
	}
	@keyframes brand-pulse {
		0% {
			box-shadow: 0 0 0 0 rgb(246 169 53 / 0.55);
		}
		70% {
			box-shadow: 0 0 0 6px rgb(246 169 53 / 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgb(246 169 53 / 0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.live-dot {
			animation: none;
		}
	}

	a {
		color: var(--fg-dim);
		text-decoration: none;
		font-family: var(--mono);
		font-size: 0.78rem;
	}
	a:hover {
		color: var(--fg);
	}
	a.current {
		color: var(--fg);
	}
</style>
