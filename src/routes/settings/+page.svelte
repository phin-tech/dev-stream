<script lang="ts">
	import { onMount } from 'svelte';
	import {
		apiConfig,
		fetchSettings,
		fetchSources,
		fetchPluginRegistry,
		installPlugin,
		installRegistryPlugin,
		regenerateToken,
		revealInFinder,
		saveSettings
	} from '$lib/api';
	import SourceSettings from '$lib/components/SourceSettings.svelte';
	import type { RegistryPluginStatus, SettingsInfo, SourceStatus } from '../../shared/types';

	let info = $state<SettingsInfo | null>(null);
	let token = $state('');
	let tokenVisible = $state(false);
	let retention = $state(0);
	let markSeenOnScroll = $state(false);
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);
	let confirmingRegenerate = $state(false);
	let sources = $state<SourceStatus[]>([]);
	let pluginUrl = $state('');
	let installingPlugin = $state(false);
	let registry = $state<RegistryPluginStatus[]>([]);
	let registryError = $state<string | null>(null);
	let registryBusy = $state<string | null>(null);

	onMount(async () => {
		try {
			const [settings, config, integrations] = await Promise.all([
				fetchSettings(),
				apiConfig(),
				fetchSources()
			]);
			info = settings;
			retention = settings.retention_days;
			markSeenOnScroll = settings.mark_seen_on_scroll;
			token = config.token;
			sources = integrations;
			try {
				registry = await fetchPluginRegistry();
			} catch (err) {
				registryError = String(err);
			}
		} catch (err) {
			error = String(err);
		}
	});

	function onSourceChange(updated: SourceStatus) {
		sources = sources.map((s) => (s.slug === updated.slug ? updated : s));
	}

	async function onPluginInstall() {
		error = null;
		status = null;
		installingPlugin = true;
		try {
			const installed = await installPlugin(pluginUrl);
			sources = [...sources.filter((source) => source.slug !== installed.slug), installed];
			pluginUrl = '';
			status = `${installed.label} installed. Review its permissions before trusting it.`;
		} catch (err) {
			error = String(err);
		} finally {
			installingPlugin = false;
		}
	}

	async function onRegistryInstall(plugin: RegistryPluginStatus) {
		registryBusy = plugin.slug;
		error = null;
		try {
			const installed = await installRegistryPlugin(plugin.slug);
			sources = [...sources.filter((source) => source.slug !== installed.slug), installed];
			registry = registry.map((entry) => entry.slug === plugin.slug
				? { ...entry, installed: true, update_available: false } : entry);
			status = `${plugin.label} ${plugin.installed ? 'updated' : 'installed'}. Review its permissions before enabling it.`;
		} catch (err) {
			error = String(err);
		} finally {
			registryBusy = null;
		}
	}

	async function onRetentionSave() {
		error = null;
		try {
			const saved = await saveSettings({ retention_days: retention });
			retention = saved.retention_days;
			status =
				saved.retention_days === 0
					? 'Keeping every post.'
					: `Posts older than ${saved.retention_days} days will be swept.`;
		} catch (err) {
			error = String(err);
		}
	}

	async function onMarkSeenToggle() {
		error = null;
		try {
			const saved = await saveSettings({ mark_seen_on_scroll: markSeenOnScroll });
			markSeenOnScroll = saved.mark_seen_on_scroll;
			status = saved.mark_seen_on_scroll
				? 'Posts are marked read as they scroll out of view.'
				: 'Posts are marked read only when clicked or selected.';
		} catch (err) {
			markSeenOnScroll = !markSeenOnScroll; // the save failed; put the toggle back
			error = String(err);
		}
	}

	async function unmute(key: 'muted_sources' | 'muted_tags', value: string) {
		if (!info) return;
		error = null;
		try {
			const next = info[key].filter((v) => v !== value);
			await saveSettings({ [key]: next });
			info = { ...info, [key]: next };
			status = `Unmuted ${value}. Its history is back in the timeline.`;
		} catch (err) {
			error = String(err);
		}
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			status = 'Copied to clipboard.';
		} catch (err) {
			// The command is selectable in place, so a clipboard denial is not fatal.
			error = String(err);
		}
	}

	async function onRegenerate() {
		error = null;
		try {
			token = await regenerateToken();
			tokenVisible = true;
			confirmingRegenerate = false;
			status = 'New token issued. Anything holding the old one must re-read ~/.dev-stream/token.';
		} catch (err) {
			error = String(err);
		}
	}
</script>

<main>
	<header class="page-head">
		<div>
			<h1>Settings</h1>
			<p>Connections, storage, reading preferences, and local access.</p>
		</div>
		<span class="local-badge">Local only</span>
	</header>

	{#if error}<p class="error">{error}</p>{/if}
	{#if status}<p class="status">{status}</p>{/if}

	{#if !info}
		<p class="dim">Loading…</p>
	{:else}
		<section>
			<h2>API</h2>
			<dl>
				<dt>Port</dt>
				<dd>
					<code>127.0.0.1:{info.port}</code>
					<span class="dim">— clients read this from <code>~/.dev-stream/port</code></span>
				</dd>

				<dt>Token</dt>
				<dd>
					<code class="token">{tokenVisible ? token : '•'.repeat(32)}</code>
					<button onclick={() => (tokenVisible = !tokenVisible)}>
						{tokenVisible ? 'Hide' : 'Reveal'}
					</button>

					{#if confirmingRegenerate}
						<!-- Rotating is irreversible and breaks anything holding the old
						     token until it re-reads the file, so it takes two clicks. -->
						<button class="danger" onclick={onRegenerate}>Confirm — break existing clients</button>
						<button onclick={() => (confirmingRegenerate = false)}>Cancel</button>
					{:else}
						<button onclick={() => (confirmingRegenerate = true)}>Regenerate</button>
					{/if}
				</dd>
			</dl>
		</section>

		<section>
			<h2>Storage</h2>
			<dl>
				<dt>Database</dt>
				<dd>
					<code>{info.db_path}</code>
					<button onclick={() => revealInFinder(info!.db_path)}>Reveal in Finder</button>
				</dd>

				<dt>Posts</dt>
				<dd>{info.post_count.toLocaleString()}</dd>

				<dt>Retention</dt>
				<dd>
					<input type="number" min="0" bind:value={retention} />
					<span class="dim">days — 0 keeps everything</span>
					<button onclick={onRetentionSave}>Save</button>
				</dd>
			</dl>
			<p class="dim note">
				Swept at startup and once a day. Retention is by event time, so a post backfilled today
				about last year counts as a year old.
			</p>
		</section>

		<section>
			<h2>Reading</h2>
			<dl>
				<dt>Mark seen</dt>
				<dd>
					<label class="toggle">
						<input
							type="checkbox"
							bind:checked={markSeenOnScroll}
							onchange={onMarkSeenToggle}
						/>
						on scroll past
					</label>
				</dd>
			</dl>
			<p class="dim note">
				A post is always marked read when you click it or select it with j/k. Turn this on to
				also mark it read once it scrolls up out of view.
			</p>
		</section>

		<section>
			<h2>Integrations</h2>
			<p class="dim note-top">
				Installed plugins post through the same API as everything else. A plugin cannot run
				until you review and trust its requested permissions.
			</p>
			{#if registryError}
				<p class="error">Registry unavailable: {registryError}</p>
			{:else if registry.length > 0}
				<div class="registry" aria-label="Plugin registry">
					{#each registry as plugin (plugin.slug)}
						<div class="registry-row">
							<div>
								<strong>{plugin.label}</strong>
								<span class="version">v{plugin.version}</span>
								<p>{plugin.description}</p>
							</div>
							<button disabled={!plugin.compatible || registryBusy !== null || (plugin.installed && !plugin.update_available)} onclick={() => onRegistryInstall(plugin)}>
								{registryBusy === plugin.slug ? 'Working…' : plugin.update_available ? 'Update' : plugin.installed ? 'Installed' : plugin.compatible ? 'Install' : `Requires ${plugin.min_app_version}`}
							</button>
						</div>
					{/each}
				</div>
			{/if}
			<form class="plugin-install" onsubmit={(event) => { event.preventDefault(); onPluginInstall(); }}>
				<label for="plugin-url">Install an unlisted plugin from GitHub</label>
				<div>
					<input id="plugin-url" type="url" required placeholder="https://github.com/owner/repo/tree/main/plugin" bind:value={pluginUrl} />
					<button type="submit" disabled={installingPlugin}>{installingPlugin ? 'Installing…' : 'Install'}</button>
				</div>
			</form>
			{#each sources as source (source.slug)}
				<SourceSettings {source} onChange={onSourceChange} />
			{/each}
			<p class="dim">
				Credentials are stored in plain text in the local SQLite database. It is a
				single-user machine-local app, but that is worth knowing before you paste a token
				with broad scopes.
			</p>
		</section>

		<section>
			<h2>MCP server</h2>
			<p class="dim note-top">
				Exposes the timeline to any MCP client (Claude Code, Claude Desktop) as four tools —
				<code>post_to_timeline</code>, <code>search_timeline</code>, <code>list_views</code> and
				<code>get_view_posts</code> — so an agent can post to the stream and answer questions like
				“what did I ship this week?” from your own activity.
			</p>
			<dl>
				<dt>Claude Code</dt>
				<dd>
					<code class="cmd">claude mcp add dev-stream -- dev-stream mcp</code>
					<button onclick={() => copy('claude mcp add dev-stream -- dev-stream mcp')}>Copy</button>
				</dd>

				<dt>Other clients</dt>
				<dd>
					<code class="cmd">dev-stream mcp</code>
					<span class="dim">— a stdio server; point the client's command at this</span>
				</dd>
			</dl>
			<p class="dim note">
				The MCP server is a client of this same local API, so reads need the app running. Posting
				still works while it's closed — those spool to disk and flush on next launch.
			</p>
		</section>

		<section>
			<h2>Muted</h2>
			{#if info.muted_sources.length === 0 && info.muted_tags.length === 0}
				<p class="dim">Nothing is muted. Use the ⋯ menu on any card to hide a source or tag.</p>
			{:else}
				<!-- Muting hides, it never deletes: unmuting brings the history back. -->
				<p class="dim">Hidden from the timeline. Unmuting brings their history back.</p>
				<div class="chips">
					{#each info.muted_sources as source (source)}
						<button class="chip" onclick={() => unmute('muted_sources', source)}>
							{source} ×
						</button>
					{/each}
					{#each info.muted_tags as tag (tag)}
						<button class="chip" onclick={() => unmute('muted_tags', tag)}>#{tag} ×</button>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</main>

<style>
	main {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-xl);
		width: min(100%, 62rem);
		box-sizing: border-box;
		margin-inline: auto;
	}
	.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-lg); margin-bottom: 2rem; }
	.page-head p { margin: var(--space-xs) 0 0; color: var(--fg-soft); font-size: 0.9rem; }
	.local-badge { padding: var(--space-xs) var(--space-sm); border-radius: 999px; background: color-mix(in oklch, var(--success) 16%, var(--surface)); color: var(--success); font-size: 0.75rem; font-weight: 750; }

	h1 {
		font-size: 1.5rem;
		letter-spacing: -0.025em;
		margin: 0;
	}
	h2 {
		font-size: 1rem;
		font-weight: 750;
		color: var(--fg);
		margin: 0 0 var(--space-lg);
	}

	section {
		margin-bottom: var(--space-lg);
		padding: var(--space-xl);
		border: 1px solid var(--rail-soft);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: var(--space-md) var(--space-lg);
		align-items: baseline;
	}
	dt {
		color: var(--fg-soft);
		font-size: 0.8rem;
		font-weight: 650;
	}
	dd {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.9rem;
	}

	code {
		font-family: var(--mono);
		font-size: 0.8rem;
		background: var(--inset);
		border: 1px solid var(--rail-soft);
		padding: 0.15rem 0.4rem;
		border-radius: 5px;
		word-break: break-all;
	}
	.token {
		min-width: 18rem;
	}
	/* A command line: select-all on click so it's easy to grab even without the
	   Copy button, and let it wrap rather than overflow the column. */
	.cmd {
		user-select: all;
		white-space: pre-wrap;
	}

	button {
		font-size: 0.78rem;
		font-weight: 700;
		min-height: 2.5rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg-soft);
	}
	button:hover {
		border-color: var(--live);
		color: var(--live-soft);
	}
	button.danger {
		border-color: var(--alert);
		color: var(--alert);
	}

	input[type='number'] {
		width: 5rem;
		padding: 0.28rem 0.4rem;
		border-radius: 7px;
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg);
		font-family: var(--mono);
		font-size: 0.82rem;
	}
	.plugin-install { margin: var(--space-lg) 0; }
	.registry { margin: var(--space-lg) 0; border-block: 1px solid var(--rail-soft); }
	.registry-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-lg); padding: var(--space-md) 0; border-bottom: 1px solid var(--rail-soft); }
	.registry-row:last-child { border-bottom: 0; }
	.registry-row strong { font-size: 0.9rem; }
	.registry-row p { margin: var(--space-xs) 0 0; color: var(--fg-soft); font-size: 0.8rem; line-height: 1.4; }
	.version { margin-left: var(--space-sm); color: var(--fg-dim); font: 0.72rem var(--mono); }
	.plugin-install label { display: block; margin-bottom: var(--space-xs); color: var(--fg-soft); font-size: 0.8rem; font-weight: 650; }
	.plugin-install div { display: flex; gap: var(--space-sm); }
	.plugin-install input { flex: 1; min-width: 0; padding: var(--space-sm); border-radius: var(--radius-sm); border: 1px solid var(--rail); background: var(--inset); color: var(--fg); font-family: var(--mono); }
	.plugin-install input:focus { outline: none; border-color: var(--live); }
	input[type='number']:focus {
		outline: none;
		border-color: var(--live);
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-family: var(--mono);
		font-size: 0.82rem;
		color: var(--fg-soft);
	}
	input[type='checkbox'] {
		accent-color: var(--live);
		width: 0.95rem;
		height: 0.95rem;
	}

	.dim {
		color: var(--fg-soft);
		font-size: 0.82rem;
		line-height: 1.5;
	}
	.note {
		margin: 0.7rem 0 0;
	}
	.note-top {
		margin: 0 0 0.7rem;
	}
	.error {
		color: var(--alert);
	}
	.status {
		color: var(--live-soft);
		font-size: 0.85rem;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-top: 0.5rem;
	}
	.chip {
		font-family: var(--mono);
		font-size: 0.72rem;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--rail);
		background: transparent;
		color: var(--fg-dim);
	}
	.chip:hover {
		border-color: var(--live);
		color: var(--live-soft);
	}
	@media (max-width: 40rem) {
		main { padding: var(--space-md); }
		section { padding: var(--space-lg); }
		dl { grid-template-columns: 1fr; gap: var(--space-sm); }
		dd { margin-bottom: var(--space-md); }
		.token { min-width: 0; max-width: 100%; }
	}
</style>
