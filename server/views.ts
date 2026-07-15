/**
 * Saved views: a named filter set.
 *
 * A view is not a new query language -- it is literally a serialized `PostFilter`,
 * the same object the filter bar produces and `GET /api/posts` consumes. That is
 * what keeps "what I see when I fiddle with the filter bar" and "what I see when I
 * click a saved view" from ever drifting apart.
 */

import { monotonicUlid } from './vendored.ts';
import type { PostFilter, View, ViewWithUnread } from '../src/shared/types.ts';
import type { Db } from './db.ts';
import { countMatching, ValidationError } from './posts.ts';

const MAX_NAME = 100;

interface ViewRow {
	id: string;
	name: string;
	filter: string;
	pinned: number;
	position: number;
	last_seen_ts: string | null;
	created_at: string;
	updated_at: string;
}

function rowToView(row: ViewRow): View {
	const view: View = {
		id: row.id,
		name: row.name,
		filter: JSON.parse(row.filter),
		pinned: row.pinned === 1, // SQLite has no boolean type
		position: Number(row.position),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
	if (row.last_seen_ts !== null) view.last_seen_ts = row.last_seen_ts;
	return view;
}

/** Only the keys a filter is allowed to have -- a view must not smuggle in a cursor. */
function validateFilter(input: unknown): PostFilter {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new ValidationError('filter must be a JSON object');
	}
	const raw = input as Record<string, unknown>;
	const filter: PostFilter = {};

	for (const key of ['source', 'project', 'repo', 'kind', 'tag'] as const) {
		const value = raw[key];
		if (value === undefined || value === null) continue;
		if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
			throw new ValidationError(`filter.${key} must be an array of strings`);
		}
		if (value.length > 0) filter[key] = value as string[];
	}

	for (const key of ['q', 'since', 'until'] as const) {
		const value = raw[key];
		if (value === undefined || value === null || value === '') continue;
		if (typeof value !== 'string') throw new ValidationError(`filter.${key} must be a string`);
		filter[key] = value;
	}

	return filter;
}

function validateName(input: unknown): string {
	if (typeof input !== 'string' || !input.trim()) throw new ValidationError('name is required');
	const name = input.trim();
	if (name.length > MAX_NAME) throw new ValidationError(`name exceeds ${MAX_NAME} characters`);
	return name;
}

/**
 * Every view, with its unread count.
 *
 * The counts are computed here rather than cached, because a cached count is a
 * count that can be wrong -- and an unread badge that lies is worse than no badge.
 * Each is one indexed COUNT(*) over a filter; there are a handful of views.
 */
export function listViews(db: Db, exclusions: PostFilter & Record<string, unknown> = {}): ViewWithUnread[] {
	const rows = db
		.prepare('SELECT * FROM views ORDER BY pinned DESC, position ASC, created_at ASC')
		.all() as unknown as ViewRow[];

	return rows.map((row) => {
		const view = rowToView(row);
		return {
			...view,
			unread: view.last_seen_ts
				// `after`, not `since`: the marker is exclusive, or a post written in
				// the same millisecond as the mark would be unread from birth.
				? countMatching(db, { ...view.filter, ...exclusions, after: view.last_seen_ts })
				: // Never opened: everything in it is new, but calling the entire
					// backlog "unread" would just be noise on first run.
					0
		};
	});
}

export function getView(db: Db, id: string): View | null {
	const row = db.prepare('SELECT * FROM views WHERE id = ?').get(id) as unknown as ViewRow | undefined;
	return row ? rowToView(row) : null;
}

export function createView(db: Db, input: unknown): View {
	if (typeof input !== 'object' || input === null) throw new ValidationError('view must be an object');
	const raw = input as Record<string, unknown>;

	const name = validateName(raw.name);
	const filter = validateFilter(raw.filter ?? {});
	const now = new Date().toISOString();
	const id = monotonicUlid();

	try {
		db.prepare(
			`INSERT INTO views (id, name, filter, pinned, position, last_seen_ts, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			name,
			JSON.stringify(filter),
			raw.pinned ? 1 : 0,
			typeof raw.position === 'number' ? raw.position : 0,
			// A new view starts "caught up": its unread count counts what arrives
			// from now on, not the entire history that matched before it existed.
			now,
			now,
			now
		);
	} catch (err) {
		// The name is UNIQUE, so a clash is a user error, not a server fault.
		if (String(err).includes('UNIQUE')) {
			throw new ValidationError(`a view named "${name}" already exists`);
		}
		throw err;
	}

	return getView(db, id)!;
}

export function updateView(db: Db, id: string, input: unknown): View {
	const existing = getView(db, id);
	if (!existing) throw new ValidationError('view not found');

	if (typeof input !== 'object' || input === null) throw new ValidationError('view must be an object');
	const raw = input as Record<string, unknown>;

	const name = raw.name === undefined ? existing.name : validateName(raw.name);
	const filter = raw.filter === undefined ? existing.filter : validateFilter(raw.filter);
	const pinned = raw.pinned === undefined ? existing.pinned : Boolean(raw.pinned);
	const position = typeof raw.position === 'number' ? raw.position : existing.position;

	try {
		db.prepare(
			`UPDATE views SET name = ?, filter = ?, pinned = ?, position = ?, updated_at = ?
			  WHERE id = ?`
		).run(name, JSON.stringify(filter), pinned ? 1 : 0, position, new Date().toISOString(), id);
	} catch (err) {
		if (String(err).includes('UNIQUE')) {
			throw new ValidationError(`a view named "${name}" already exists`);
		}
		throw err;
	}

	return getView(db, id)!;
}

export function deleteView(db: Db, id: string): boolean {
	const result = db.prepare('DELETE FROM views WHERE id = ?').run(id);
	return Number(result.changes) > 0;
}

/**
 * Marks a view as read up to now. Called when the user opens it.
 *
 * `now`, not "the newest post in the view": if a post arrives between the query
 * and the click, using the newest post's `ts` would mark it read without it ever
 * having been on screen.
 */
export function markViewSeen(db: Db, id: string): View | null {
	const result = db
		.prepare('UPDATE views SET last_seen_ts = ?, updated_at = ? WHERE id = ?')
		.run(new Date().toISOString(), new Date().toISOString(), id);

	return Number(result.changes) > 0 ? getView(db, id) : null;
}
