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
	import Modal from '$lib/components/Modal.svelte';
	import SourceSettings from '$lib/components/SourceSettings.svelte';
	import { relativeTime } from '$lib/format';
	import type { RegistryPluginStatus, SettingsInfo, SourceStatus } from '../../shared/types';

	type SectionId = 'api' | 'storage' | 'reading' | 'integrations' | 'mcp' | 'muted';

	const sections: { id: SectionId; label: string; hint: string }[] = [
		{ id: 'api', label: 'API', hint: 'Port and access token' },
		{ id: 'storage', label: 'Storage', hint: 'Database and retention' },
		{ id: 'reading', label: 'Reading', hint: 'Mark-seen behaviour' },
		{ id: 'integrations', label: 'Integrations', hint: 'Plugins and sources' },
		{ id: 'mcp', label: 'MCP Server', hint: 'Agent access' },
		{ id: 'muted', label: 'Muted', hint: 'Hidden sources and tags' }
	];

	let activeSection = $state<SectionId>('api');
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
	// The slug whose settings dialog is open; null means no dialog.
	let selectedSlug = $state<string | null>(null);
	const selected = $derived(sources.find((s) => s.slug === selectedSlug) ?? null);

	function isSectionId(value: string): value is SectionId {
		return sections.some((s) => s.id === value);
	}

	function selectSection(id: SectionId) {
		activeSection = id;
		// Deep-linkable without history spam — back leaves Settings entirely.
		history.replaceState(null, '', `#${id}`);
	}

	onMount(async () => {
		const initial = window.location.hash.slice(1);
		if (isSectionId(initial)) activeSection = initial;
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
			// Straight into the dialog: reviewing permissions is the next step anyway.
			selectedSlug = installed.slug;
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
			if (!plugin.installed) selectedSlug = installed.slug;
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

	<div class="settings-shell">
		<aside class="settings-nav" aria-label="Settings sections">
			{#each sections as section (section.id)}
				<button
					class="nav-item"
					class:active={activeSection === section.id}
					aria-current={activeSection === section.id ? 'true' : undefined}
					onclick={() => selectSection(section.id)}
				>
					<span class="nav-label">{section.label}</span>
					<span class="nav-hint">{section.hint}</span>
					{#if section.id === 'integrations' && sources.length > 0}
						<span class="count">{sources.length}</span>
					{:else if section.id === 'muted' && info && (info.muted_sources.length + info.muted_tags.length) > 0}
						<span class="count">{info.muted_sources.length + info.muted_tags.length}</span>
					{/if}
				</button>
			{/each}
		</aside>

		<div class="settings-content">
			{#if error}<p class="error">{error}</p>{/if}
			{#if status}<p class="status">{status}</p>{/if}

			{#if !info}
				<p class="dim">Loading…</p>
			{:else}
				{#key activeSection}
					<div class="section-enter">
						{#if activeSection === 'api'}
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
						{:else if activeSection === 'storage'}
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
						{:else if activeSection === 'reading'}
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
						{:else if activeSection === 'integrations'}
							<section>
								<h2>Integrations</h2>
								<p class="dim note-top">
									Installed sources post through the same API as everything else. A plugin cannot run
									until you review and trust its requested permissions — select a row to configure it.
								</p>
								{#if sources.length === 0}
									<p class="dim">Nothing installed yet — install one from the registry below.</p>
								{:else}
									<div class="table-wrap">
										<table class="sources-table">
											<thead>
												<tr>
													<th>Source</th>
													<th class="optional">Type</th>
													<th>Status</th>
													<th class="optional">Last polled</th>
													<th><span class="sr-only">Actions</span></th>
												</tr>
											</thead>
											<tbody>
												{#each sources as source (source.slug)}
													<tr onclick={() => (selectedSlug = source.slug)}>
														<td>
															<strong>{source.label}</strong>
															<span class="slug">{source.slug}</span>
														</td>
														<td class="optional">
															<span class="type">{source.origin === 'plugin' ? 'plugin' : 'built-in'}</span>
														</td>
														<td>
															<span class="status-cell">
																{#if source.origin === 'plugin' && !source.trusted}
																	<span class="pill untrusted">untrusted</span>
																{:else if source.enabled}
																	<span class="pill on">on</span>
																{:else}
																	<span class="pill">off</span>
																{/if}
																{#if source.last_error}
																	<span class="row-error" title={source.last_error}>⚠</span>
																{/if}
															</span>
														</td>
														<td class="optional polled">
															{source.last_polled_at ? `${relativeTime(source.last_polled_at)} ago` : 'never'}
														</td>
														<td class="actions-cell">
															<button
																class="configure"
																onclick={(event) => {
																	event.stopPropagation();
																	selectedSlug = source.slug;
																}}
															>Configure</button>
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{/if}
								<h3>Available to install</h3>
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
								<h3>From GitHub</h3>
								<form class="plugin-install" onsubmit={(event) => { event.preventDefault(); onPluginInstall(); }}>
									<label for="plugin-url">Install an unlisted plugin from GitHub</label>
									<div>
										<input id="plugin-url" type="url" required placeholder="https://github.com/owner/repo/tree/main/plugin" bind:value={pluginUrl} />
										<button type="submit" disabled={installingPlugin}>{installingPlugin ? 'Installing…' : 'Install'}</button>
									</div>
								</form>
								<p class="dim">
									Credentials are stored in plain text in the local SQLite database. It is a
									single-user machine-local app, but that is worth knowing before you paste a token
									with broad scopes.
								</p>
							</section>
						{:else if activeSection === 'mcp'}
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
						{:else if activeSection === 'muted'}
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
					</div>
				{/key}
			{/if}
		</div>
	</div>

	<Modal open={selected !== null} title={selected?.label ?? ''} onClose={() => (selectedSlug = null)}>
		{#if selected}
			<SourceSettings source={selected} onChange={onSourceChange} framed={false} />
		{/if}
	</Modal>
</main>

<style>
	main {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-xl);
		width: min(100%, 68rem);
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
	h3 {
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--fg-soft);
		margin: var(--space-xl) 0 var(--space-sm);
	}

	.settings-shell {
		display: flex;
		align-items: flex-start;
		gap: var(--space-xl);
	}

	.settings-nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 13rem;
		flex-shrink: 0;
		position: sticky;
		top: var(--space-xl);
	}
	.nav-item {
		position: relative;
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-areas: 'label count' 'hint count';
		column-gap: var(--space-sm);
		align-items: center;
		text-align: left;
		padding: var(--space-sm) var(--space-md);
		min-height: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--fg-soft);
		transition: background 160ms var(--ease-out), color 160ms var(--ease-out), border-color 160ms var(--ease-out);
	}
	.nav-label { grid-area: label; font-size: 0.85rem; font-weight: 700; }
	.nav-hint { grid-area: hint; font-size: 0.72rem; color: var(--fg-dim); margin-top: 1px; }
	.count {
		grid-area: count;
		font-family: var(--mono);
		font-size: 0.68rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: var(--inset);
		border: 1px solid var(--rail-soft);
		color: var(--fg-dim);
	}
	.nav-item:hover {
		background: var(--surface);
		color: var(--fg);
		border-color: transparent;
	}
	.nav-item.active {
		background: var(--surface);
		border-color: var(--rail-soft);
		color: var(--fg);
	}
	/* The accent tick, echoing the top nav's current-page underline. */
	.nav-item.active::before {
		content: '';
		position: absolute;
		left: 0;
		top: 50%;
		translate: 0 -50%;
		width: 2px;
		height: 60%;
		border-radius: 2px;
		background: var(--live);
	}
	.nav-item.active .count {
		border-color: var(--live);
		color: var(--live-soft);
	}

	.settings-content {
		flex: 1;
		min-width: 0;
	}

	/* Section swap: a small settle-in, kept off under reduced motion. */
	@keyframes section-in {
		from { opacity: 0; translate: 0 4px; }
		to { opacity: 1; translate: 0 0; }
	}
	.section-enter {
		animation: section-in 200ms var(--ease-out);
	}
	@media (prefers-reduced-motion: reduce) {
		.section-enter { animation: none; }
	}

	section {
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

	section button {
		font-size: 0.78rem;
		font-weight: 700;
		min-height: 2.5rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg-soft);
	}
	section button:hover {
		border-color: var(--live);
		color: var(--live-soft);
	}
	section button.danger {
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

	/* --- installed sources table ------------------------------------------ */
	.table-wrap {
		overflow-x: auto;
		margin: var(--space-lg) 0;
	}
	.sources-table {
		width: 100%;
		border-collapse: collapse;
		border-block: 1px solid var(--rail-soft);
	}
	.sources-table th {
		text-align: left;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--fg-dim);
		padding: var(--space-sm) var(--space-md) var(--space-sm) 0;
		border-bottom: 1px solid var(--rail-soft);
	}
	.sources-table td {
		padding: var(--space-md) var(--space-md) var(--space-md) 0;
		vertical-align: middle;
		font-size: 0.85rem;
	}
	.sources-table tbody tr {
		border-bottom: 1px solid var(--rail-soft);
		cursor: pointer;
		transition: background 160ms var(--ease-out);
	}
	.sources-table tbody tr:last-child {
		border-bottom: 0;
	}
	.sources-table tbody tr:hover {
		background: color-mix(in oklch, var(--surface-raised) 60%, transparent);
	}
	.sources-table td strong {
		display: block;
		font-size: 0.88rem;
		font-weight: 700;
	}
	.slug {
		display: block;
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--fg-dim);
		margin-top: 1px;
	}
	.type {
		font-size: 0.75rem;
		color: var(--fg-soft);
	}
	.status-cell {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.pill {
		font-size: 0.7rem;
		font-weight: 700;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--rail);
		color: var(--fg-dim);
	}
	.pill.on {
		border-color: color-mix(in srgb, var(--live) 45%, transparent);
		color: var(--live-soft);
		background: color-mix(in srgb, var(--live) 10%, transparent);
	}
	/* Untrusted is a pending decision — it should be the loudest row state. */
	.pill.untrusted {
		border-color: color-mix(in srgb, var(--alert) 45%, transparent);
		color: var(--alert);
		background: color-mix(in srgb, var(--alert) 8%, transparent);
	}
	.row-error {
		color: var(--alert);
		font-size: 0.8rem;
		cursor: help;
	}
	.polled {
		color: var(--fg-soft);
		font-size: 0.78rem;
	}
	.actions-cell {
		text-align: right;
		padding-right: 0;
	}
	.sources-table .configure {
		min-height: 2rem;
		padding: var(--space-xs) var(--space-sm);
		font-size: 0.75rem;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

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

	@media (max-width: 46rem) {
		main { padding: var(--space-md); }
		.sources-table .optional { display: none; }
		.settings-shell { flex-direction: column; gap: var(--space-lg); }
		.settings-nav {
			position: static;
			width: 100%;
			flex-direction: row;
			overflow-x: auto;
			padding-bottom: var(--space-xs);
		}
		.nav-item { flex-shrink: 0; }
		.nav-hint { display: none; }
		.nav-item.active::before { display: none; }
		.nav-item.active { border-color: var(--live); }
		section { padding: var(--space-lg); }
		dl { grid-template-columns: 1fr; gap: var(--space-sm); }
		dd { margin-bottom: var(--space-md); }
		.token { min-width: 0; max-width: 100%; }
	}
</style>
