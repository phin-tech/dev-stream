<script lang="ts">
	import { untrack } from 'svelte';
	import { pollSource, saveSource } from '../api';
	import { relativeTime } from '../format';
	import type { SourceStatus } from '../../shared/types';

	interface Props {
		source: SourceStatus;
		onChange: (source: SourceStatus) => void;
	}

	let { source, onChange }: Props = $props();

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
		try {
			const updated = await saveSource(source.slug, { enabled, config: values });
			onChange(updated);
			// Secrets are write-only: clear the box so it never looks like the stored
			// value is being displayed back.
			for (const field of source.fields) {
				if (field.secret) values[field.key] = '';
			}
			message = enabled ? 'Saved. Polling now…' : 'Disabled. Credentials kept.';
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
</script>

<div class="source" class:enabled={source.enabled}>
	<div class="head">
		<strong>{source.label}</strong>
		{#if source.enabled}
			<span class="badge on">on</span>
		{:else}
			<span class="badge">off</span>
		{/if}

		{#if source.last_polled_at}
			<span class="dim">polled {relativeTime(source.last_polled_at)} ago</span>
		{/if}

		<span class="spacer"></span>

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
		<button class="primary" disabled={busy} onclick={() => save(true)}>
			{source.enabled ? 'Save' : 'Enable'}
		</button>
		{#if message}<span class="message">{message}</span>{/if}
	</div>
</div>

<style>
	.source {
		border: 1px solid var(--rail);
		border-radius: 9px;
		padding: 0.8rem 0.9rem;
		margin-bottom: 0.75rem;
		background: var(--surface);
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
		font-size: 0.9rem;
		font-weight: 600;
	}
	.spacer {
		flex: 1;
	}

	.badge {
		font-family: var(--mono);
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 0.06rem 0.4rem;
		border-radius: 5px;
		border: 1px solid var(--rail);
		color: var(--fg-dim);
	}
	.badge.on {
		border-color: color-mix(in srgb, var(--live) 45%, transparent);
		color: var(--live-soft);
		background: color-mix(in srgb, var(--live) 10%, transparent);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.label {
		font-size: 0.78rem;
		color: var(--fg-soft);
	}
	.help {
		font-family: var(--mono);
		font-size: 0.7rem;
		color: var(--fg-dim);
	}

	input {
		padding: 0.34rem 0.5rem;
		border-radius: 7px;
		border: 1px solid var(--rail);
		background: var(--inset);
		color: var(--fg);
		font-family: var(--mono);
		font-size: 0.8rem;
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
		font-family: var(--mono);
		font-size: 0.75rem;
		padding: 0.28rem 0.6rem;
		border-radius: 7px;
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
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--fg-dim);
	}
	.error {
		color: var(--alert);
		font-size: 0.78rem;
		margin: 0 0 0.6rem;
	}
	.dim {
		font-family: var(--mono);
		color: var(--fg-dim);
		font-size: 0.72rem;
	}
</style>
