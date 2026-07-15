/**
 * Persistence for source workers: enablement, credentials, watermark, last error.
 *
 * All of it lives on the `sources` row the slug already owns.
 */

import type { Db } from '../db.ts';
import { ValidationError } from '../posts.ts';
import type { SourceStatus, SourceWorker } from './types.ts';
import { findWorker, getWorkers } from './registry.ts';

interface SourceRow {
	slug: string;
	config: string;
	cursor: string | null;
	enabled: number;
	last_error: string | null;
	last_polled_at: string | null;
	trusted_hash: string | null;
}

export interface SourceState {
	config: Record<string, unknown>;
	cursor: string | null;
	enabled: boolean;
	/** The manifest hash the user trusted, or null. Meaningless for built-ins. */
	trustedHash: string | null;
}

/**
 * Built-ins are trusted by construction — they ARE the app. A plugin is
 * trusted only while the stored grant matches its current manifest byte for
 * byte, so a manifest edit (new host, new `run` grant) re-prompts.
 */
export function isTrusted(worker: SourceWorker, state: SourceState): boolean {
	if (worker.origin !== 'plugin') return true;
	return state.trustedHash !== null && state.trustedHash === worker.manifestHash;
}

export function getSourceState(db: Db, slug: string): SourceState {
	const row = db
		.prepare(
			'SELECT slug, config, cursor, enabled, last_error, last_polled_at, trusted_hash FROM sources WHERE slug = ?'
		)
		.get(slug) as unknown as SourceRow | undefined;

	if (!row) return { config: {}, cursor: null, enabled: false, trustedHash: null };

	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(row.config);
	} catch {
		console.error(`[sources] ${slug} has unparseable config; treating it as empty`);
	}

	return {
		config,
		cursor: row.cursor,
		enabled: row.enabled === 1,
		trustedHash: row.trusted_hash
	};
}

function upsert(db: Db, slug: string, patch: Partial<SourceRow>): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO sources (slug, created_at, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (slug) DO NOTHING`
	).run(slug, now, now);

	const columns = Object.keys(patch);
	if (columns.length === 0) return;

	// Column names come from this module's own literals, never from a request.
	db.prepare(
		`UPDATE sources SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE slug = ?`
	).run(...(Object.values(patch) as (string | number | null)[]), now, slug);
}

/**
 * Saves enablement and config.
 *
 * A secret whose incoming value is blank is *left alone* rather than cleared: the
 * settings page cannot show the user their stored token (it never receives it), so
 * submitting the form without retyping it must not wipe it.
 */
export function saveSourceConfig(
	db: Db,
	slug: string,
	input: unknown
): SourceStatus {
	const worker = findWorker(slug);
	if (!worker) throw new ValidationError(`unknown source: ${slug}`);

	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new ValidationError('body must be a JSON object');
	}
	const raw = input as Record<string, unknown>;

	const current = getSourceState(db, slug);
	const config = { ...current.config };

	const incoming = (raw.config ?? {}) as Record<string, unknown>;
	if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
		throw new ValidationError('config must be a JSON object');
	}

	for (const field of worker.configFields) {
		if (!(field.key in incoming)) continue;
		const value = incoming[field.key];
		if (value !== undefined && typeof value !== 'string') {
			throw new ValidationError(`config.${field.key} must be a string`);
		}
		if (field.secret && !String(value ?? '').trim()) continue; // keep the stored secret
		config[field.key] = String(value ?? '').trim();
	}

	// Escape hatch for tests: point a worker at a fake API. Not a declared field,
	// so it never shows up in the settings UI.
	if (typeof incoming.api_base === 'string') config.api_base = incoming.api_base;

	const enabled = raw.enabled === undefined ? current.enabled : Boolean(raw.enabled);

	// The trust gate. Config and credentials may be saved untrusted (typing a
	// token is not running code), but nothing polls until the user has seen the
	// manifest's permission list and said yes.
	if (enabled && !isTrusted(worker, current)) {
		throw new ValidationError(`${worker.label} must be trusted before it can be enabled`);
	}

	upsert(db, slug, {
		config: JSON.stringify(config),
		enabled: enabled ? 1 : 0,
		// Re-enabling or re-keying a broken source should clear the old complaint.
		last_error: null
	});

	return describeSource(db, worker);
}

/**
 * Grants or revokes trust for a plugin.
 *
 * Granting stores the hash of the manifest AS IT IS RIGHT NOW — the exact
 * permission list the user just read. Revoking also disables the source: an
 * untrusted plugin must never be one background tick away from running.
 */
export function setSourceTrust(db: Db, slug: string, input: unknown): SourceStatus {
	const worker = findWorker(slug);
	if (!worker) throw new ValidationError(`unknown source: ${slug}`);
	if (worker.origin !== 'plugin') {
		throw new ValidationError(`${worker.label} is built in; trust does not apply`);
	}

	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new ValidationError('body must be a JSON object');
	}
	const trusted = (input as Record<string, unknown>).trusted;
	if (typeof trusted !== 'boolean') {
		throw new ValidationError('trusted must be a boolean');
	}

	if (trusted) {
		upsert(db, slug, { trusted_hash: worker.manifestHash ?? null });
	} else {
		upsert(db, slug, { trusted_hash: null, enabled: 0 });
	}

	return describeSource(db, worker);
}

export function recordPoll(db: Db, slug: string, cursor: string | null, error: string | null): void {
	upsert(db, slug, {
		cursor,
		last_error: error,
		last_polled_at: new Date().toISOString()
	});
}

/** The status a client sees. Never includes a secret's value. */
export function describeSource(db: Db, worker: SourceWorker): SourceStatus {
	const row = db
		.prepare('SELECT slug, config, cursor, enabled, last_error, last_polled_at FROM sources WHERE slug = ?')
		.get(worker.slug) as unknown as SourceRow | undefined;

	const state = getSourceState(db, worker.slug);

	const publicConfig: Record<string, unknown> = {};
	for (const field of worker.configFields) {
		// A secret's value never leaves the server. The UI learns only whether one
		// is set, via `configured` below.
		if (!field.secret) publicConfig[field.key] = state.config[field.key] ?? '';
	}

	const configured = worker.configFields
		.filter((f) => f.secret)
		.every((f) => String(state.config[f.key] ?? '').trim().length > 0);

	return {
		slug: worker.slug,
		label: worker.label,
		origin: worker.origin ?? 'builtin',
		trusted: isTrusted(worker, state),
		// The permission list rides along so the settings page can show the user
		// exactly what they would be (or have been) granting.
		...(worker.permissions ? { permissions: worker.permissions } : {}),
		enabled: state.enabled,
		configured,
		fields: worker.configFields,
		config: publicConfig,
		cursor: state.cursor,
		last_error: row?.last_error ?? null,
		last_polled_at: row?.last_polled_at ?? null
	};
}

export function listSources(db: Db): SourceStatus[] {
	return getWorkers().map((worker) => describeSource(db, worker));
}
