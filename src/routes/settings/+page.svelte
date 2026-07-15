<script lang="ts">
	import { onMount } from 'svelte';
	import {
		apiConfig,
		fetchSettings,
		fetchSources,
		regenerateToken,
		revealInFinder,
		saveSettings
	} from '$lib/api';
	import SourceSettings from '$lib/components/SourceSettings.svelte';
	import type { SettingsInfo, SourceStatus } from '../../shared/types';

	let info = $state<SettingsInfo | null>(null);
	let token = $state('');
	let tokenVisible = $state(false);
	let retention = $state(0);
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);
	let confirmingRegenerate = $state(false);
	let sources = $state<SourceStatus[]>([]);

	onMount(async () => {
		try {
			const [settings, config, integrations] = await Promise.all([
				fetchSettings(),
				apiConfig(),
				fetchSources()
			]);
			info = settings;
			retention = settings.retention_days;
			token = config.token;
			sources = integrations;
		} catch (err) {
			error = String(err);
		}
	});

	function onSourceChange(updated: SourceStatus) {
		sources = sources.map((s) => (s.slug === updated.slug ? updated : s));
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
	<h1>Settings</h1>

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
			<h2>Integrations</h2>
			<p class="dim note-top">
				Built-in pollers. They post through the same API as everything else, so their
				activity interleaves with your local events rather than living in a separate tab.
			</p>
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
		padding: 1.25rem;
		max-width: 46rem;
	}

	h1 {
		font-family: var(--mono);
		font-size: 1.1rem;
		letter-spacing: -0.01em;
		margin: 0 0 1.3rem;
	}
	h2 {
		font-family: var(--mono);
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--fg-dim);
		margin: 0 0 0.7rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--rail-soft);
	}

	section {
		margin-bottom: 1.9rem;
	}

	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: 0.6rem 1rem;
		align-items: baseline;
	}
	dt {
		font-family: var(--mono);
		color: var(--fg-dim);
		font-size: 0.78rem;
	}
	dd {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.88rem;
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

	button {
		font-family: var(--mono);
		font-size: 0.75rem;
		padding: 0.28rem 0.6rem;
		border-radius: 7px;
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
	input[type='number']:focus {
		outline: none;
		border-color: var(--live);
	}

	.dim {
		color: var(--fg-dim);
		font-size: 0.8rem;
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
</style>
