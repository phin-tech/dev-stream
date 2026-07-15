<script lang="ts">
	import { untrack } from 'svelte';
	import { pollSource, saveSource, trustSource } from '../api';
	import { relativeTime } from '../format';
	import type { SourceStatus } from '../../shared/types';

	interface Props {
		source: SourceStatus;
		onChange: (source: SourceStatus) => void;
	}

	let { source, onChange }: Props = $props();

	/**
	 * The manifest's permission list, flattened for display. This is the whole
	 * point of the trust step: the user reads THIS, then decides.
	 */
	const permissionRows = $derived.by(() => {
		const p = source.permissions;
		if (!p) return [];
		const rows: { label: string; value: string; warn?: string }[] = [];
		if (p.net?.length) rows.push({ label: 'Network', value: p.net.join(', ') });
		if (p.net_from_config?.length) {
			rows.push({
				label: 'Network (from config)',
				value: p.net_from_config.map((k) => `the host in “${k}”`).join(', ')
			});
		}
		if (p.read?.length) rows.push({ label: 'Read files', value: p.read.join(', ') });
		if (p.write?.length) rows.push({ label: 'Write files', value: p.write.join(', ') });
		if (p.run?.length) {
			rows.push({
				label: 'Run commands',
				value: p.run.join(', '),
				warn: 'commands run OUTSIDE the sandbox, with the app’s full access'
			});
		}
		if (p.env?.length) rows.push({ label: 'Environment variables', value: p.env.join(', ') });
		if (rows.length === 0) rows.push({ label: 'No access requested', value: 'runs fully sandboxed' });
		return rows;
	});

	// Secrets start blank because the server never sends them back. Submitting a
	// blank secret preserves the stored one (the server enforces that), so the
	// user only ever has to type a token when they actually want to change it.
	// Seeded once, then owned by the form: the user's half-typed token must not be
	// overwritten every time the parent re-renders with a refreshed status.
	let values = $state<Record<string, string>>(
		untrack(() =>
			Object.fromEntries(source.fields.map((f) => [f.key, String(source.config[f.key] ?? '')]))
		)
	);

	let busy = $state(false);
	let message = $state<string | null>(null);

	async function save(enabled: boolean) {
		busy = true;
		message = null;
		const wasEnabled = source.enabled;
		try {
			const updated = await saveSource(source.slug, { enabled, config: values });
			onChange(updated);
			// Secrets are write-only: clear the box so it never looks like the stored
			// value is being displayed back.
			for (const field of source.fields) {
				if (field.secret) values[field.key] = '';
			}
			message = enabled
				? 'Saved. Polling now…'
				: wasEnabled
					? 'Disabled. Credentials kept.'
					: 'Saved.';
		} catch (err) {
			message = String(err);
		} finally {
			busy = false;
		}
	}

	async function pollNow() {
		busy = true;
		message = null;
		try {
			const result = await pollSource(source.slug);
			message = result.error ? result.error : `Polled: ${result.posts} new post(s).`;
		} catch (err) {
			message = String(err);
		} finally {
			busy = false;
		}
	}

	async function setTrust(trusted: boolean) {
		busy = true;
		message = null;
		try {
			const updated = await trustSource(source.slug, trusted);
			onChange(updated);
			message = trusted
				? 'Trusted. It can be enabled now.'
				: 'Trust revoked. The plugin is disabled and will not run.';
		} catch (err) {
			message = String(err);
		} finally {
			busy = false;
		}
	}
</script>

<div class="source" class:enabled={source.enabled}>
	<div class="head">
		<strong>{source.label}</strong>
		{#if source.origin === 'plugin'}
			<span class="badge plugin">plugin</span>
		{/if}
		{#if source.enabled}
			<span class="badge on">on</span>
		{:else}
			<span class="badge">off</span>
		{/if}

		{#if source.last_polled_at}
			<span class="dim">polled {relativeTime(source.last_polled_at)} ago</span>
		{/if}

		<span class="spacer"></span>

		{#if source.origin === 'plugin' && source.trusted}
			<button disabled={busy} onclick={() => setTrust(false)}>Revoke trust</button>
		{/if}
		{#if source.enabled}
			<button disabled={busy} onclick={pollNow}>Poll now</button>
			<button disabled={busy} onclick={() => save(false)}>Disable</button>
		{/if}
	</div>

	{#if source.last_error}
		<!-- The single most likely way this feature fails is quietly: a token that
		     expired weeks ago and a feed that just went silent. Say it loudly. -->
		<p class="error">{source.last_error}</p>
	{/if}

	{#if source.origin === 'plugin'}
		<!-- The permission list is shown ALWAYS, not just at the trust prompt:
		     what a plugin can reach should stay one glance away. -->
		<div class="permissions" class:untrusted={!source.trusted}>
			<div class="permissions-head">
				{#if source.trusted}
					<span class="label">This plugin can access</span>
				{:else}
					<span class="label">This plugin asks for</span>
				{/if}
			</div>
			<ul>
				{#each permissionRows as row (row.label)}
					<li>
						<span class="perm-label">{row.label}:</span>
						<span class="perm-value">{row.value}</span>
						{#if row.warn}<span class="perm-warn">⚠ {row.warn}</span>{/if}
					</li>
				{/each}
			</ul>
			{#if !source.trusted}
				<p class="trust-note">
					Untrusted plugins never run. Trust it only if you know where its code came from —
					a manifest change asking for more access will require trusting it again.
				</p>
				<button class="primary" disabled={busy} onclick={() => setTrust(true)}>
					Trust this plugin
				</button>
			{/if}
		</div>
	{/if}

	<div class="fields">
		{#each source.fields as field (field.key)}
			<label>
				<span class="label">
					{field.label}
					{#if field.secret && source.configured}
						<span class="dim">— stored; leave blank to keep it</span>
					{/if}
				</span>
				<input
					type={field.secret ? 'password' : 'text'}
					placeholder={field.placeholder ?? ''}
					bind:value={values[field.key]}
				/>
				{#if field.help}<span class="help">{field.help}</span>{/if}
			</label>
		{/each}
	</div>

	<div class="actions">
		<!-- Saving config while untrusted is fine (typing a token runs nothing);
		     enabling is what the server refuses, so don't offer it. -->
		{#if source.origin === 'plugin' && !source.trusted}
			<button class="primary" disabled={busy} onclick={() => save(false)}>Save</button>
			<span class="dim">trust the plugin above to enable it</span>
		{:else}
			<button class="primary" disabled={busy} onclick={() => save(true)}>
				{source.enabled ? 'Save' : 'Enable'}
			</button>
		{/if}
		{#if message}<span class="message">{message}</span>{/if}
	</div>
</div>

<style>
	.source {
		border: 1px solid var(--rail);
		border-radius: var(--radius-md);
		padding: var(--space-lg);
		margin-bottom: var(--space-md);
		background: var(--surface-raised);
	}
	.source.enabled {
		border-color: color-mix(in srgb, var(--live) 40%, var(--rail));
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}
	.head strong {
		font-size: 0.95rem;
		font-weight: 750;
	}
	.spacer {
		flex: 1;
	}

	.badge {
		font-size: 0.75rem;
		font-weight: 700;
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-sm);
		border: 1px solid var(--rail);
		color: var(--fg-dim);
	}
	.badge.on {
		border-color: color-mix(in srgb, var(--live) 45%, transparent);
		color: var(--live-soft);
		background: color-mix(in srgb, var(--live) 10%, transparent);
	}
	.badge.plugin {
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	/* --- the trust surface ------------------------------------------------- */
	.permissions {
		border: 1px solid var(--rail);
		border-radius: var(--radius-sm);
		background: var(--inset);
		padding: var(--space-md);
		margin-bottom: var(--space-md);
	}
	/* Untrusted is the state that wants your eyes: it is a pending decision. */
	.permissions.untrusted {
		border-color: color-mix(in srgb, var(--alert) 40%, var(--rail));
	}
	.permissions-head {
		margin-bottom: var(--space-xs);
	}
	.permissions ul {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.perm-label {
		font-size: 0.8rem;
		font-weight: 650;
		color: var(--fg-soft);
	}
	.perm-value {
		font-size: 0.8rem;
		font-family: var(--mono, ui-monospace, monospace);
		color: var(--fg);
	}
	.perm-warn {
		display: block;
		font-size: 0.78rem;
		color: var(--alert);
	}
	.trust-note {
		font-size: 0.78rem;
		color: var(--fg-soft);
		margin: var(--space-sm) 0;
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.label {
		font-size: 0.82rem;
		font-weight: 650;
		color: var(--fg-soft);
	}
	.help {
		font-size: 0.78rem;
		color: var(--fg-soft);
	}

	input {
		min-height: 2.75rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg);
		font-size: 0.86rem;
	}
	input:focus {
		outline: none;
		border-color: var(--live);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.7rem;
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
	button:hover:not(:disabled) {
		border-color: var(--live);
		color: var(--live-soft);
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button.primary {
		border-color: color-mix(in srgb, var(--live) 55%, transparent);
		color: var(--live-soft);
		background: color-mix(in srgb, var(--live) 10%, transparent);
	}

	.message {
		font-size: 0.78rem;
		color: var(--fg-soft);
	}
	.error {
		color: var(--alert);
		font-size: 0.78rem;
		margin: 0 0 0.6rem;
	}
	.dim {
		color: var(--fg-soft);
		font-size: 0.78rem;
	}
</style>
