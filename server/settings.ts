/**
 * User-editable settings, stored as JSON values in a key/value table.
 *
 * Reads always go through `getSettings`, which layers stored values over
 * `DEFAULTS`. That means a key added in a later phase works immediately on an old
 * database without a migration or a null check at every call site.
 */

import type { Db } from './db.ts';
import type { Settings } from '../src/shared/types.ts';
import { ValidationError } from './posts.ts';

const DEFAULTS: Settings = {
	// 0 = keep everything. A local timeline is cheap to store, and silently
	// deleting a developer's history by default would be a hostile thing to do:
	// retention is opt-in.
	retention_days: 0,
	muted_sources: [],
	muted_tags: []
};

export function getSettings(db: Db): Settings {
	const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as {
		key: string;
		value: string;
	}[];

	const stored: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			stored[row.key] = JSON.parse(row.value);
		} catch {
			// A corrupt row must not take the app down -- fall back to the default.
			console.error(`[settings] ignoring unparseable value for "${row.key}"`);
		}
	}

	return { ...DEFAULTS, ...stored } as Settings;
}

/** Applies a partial update. Unknown keys are rejected rather than silently stored. */
export function updateSettings(db: Db, patch: unknown): Settings {
	if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
		throw new ValidationError('settings must be a JSON object');
	}

	const entries = Object.entries(patch as Record<string, unknown>);
	for (const [key, value] of entries) {
		if (!(key in DEFAULTS)) throw new ValidationError(`unknown setting: ${key}`);

		if (key === 'retention_days') {
			if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
				throw new ValidationError('retention_days must be a non-negative integer');
			}
		}

		if (key === 'muted_sources' || key === 'muted_tags') {
			if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
				throw new ValidationError(`${key} must be an array of strings`);
			}
		}
	}

	const now = new Date().toISOString();
	db.exec('BEGIN IMMEDIATE');
	try {
		const upsert = db.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		);
		for (const [key, value] of entries) upsert.run(key, JSON.stringify(value), now);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}

	return getSettings(db);
}
