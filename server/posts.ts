/**
 * The posts repository: the single validated path by which anything -- the CLI,
 * a Claude hook, the MCP server, a poller, a stray curl -- enters the timeline.
 *
 * Everything in here is synchronous because `node:sqlite` is; there is no
 * connection pool and no await points, so a write is atomic without ceremony.
 */

import { monotonicUlid } from './vendored.ts';
import type { Db } from './db.ts';
import { DEDUPE_WINDOW_MS } from './paths.ts';
import type {
	Facet,
	Facets,
	Post,
	PostInput,
	PostMeta,
	PostPage,
	PostQuery,
	PostWriteResult
} from '../src/shared/types.ts';

/** Anything longer is a client bug, not a post. Guards the DB and the UI. */
const MAX_TITLE = 500;
const MAX_BODY = 100_000;
const MAX_TAGS = 32;
const MAX_TAG_LEN = 64;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** A malformed post from a client: the API turns this into a 400, not a 500. */
export class ValidationError extends Error {}

/** The shape rows come back in. `node:sqlite` gives us null-prototype objects. */
interface PostRow {
	id: string;
	ts: string;
	source: string;
	kind: string;
	title: string;
	body: string | null;
	tags: string;
	project: string | null;
	repo: string | null;
	meta: string;
	dedupe_key: string | null;
	created_at: string;
	updated_at: string;
}

function rowToPost(row: PostRow): Post {
	const post: Post = {
		id: row.id,
		ts: row.ts,
		source: row.source,
		kind: row.kind,
		title: row.title,
		tags: JSON.parse(row.tags),
		meta: JSON.parse(row.meta),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
	// Omit rather than emit nulls: `body?: string` in the shared types means
	// absent, and clients round-tripping a post shouldn't gain null fields.
	if (row.body !== null) post.body = row.body;
	if (row.dedupe_key !== null) post.dedupe_key = row.dedupe_key;
	return post;
}

function str(value: unknown, field: string, max: number, required = false): string | undefined {
	if (value === undefined || value === null || value === '') {
		if (required) throw new ValidationError(`${field} is required`);
		return undefined;
	}
	if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
	const trimmed = value.trim();
	if (required && !trimmed) throw new ValidationError(`${field} is required`);
	if (trimmed.length > max) {
		throw new ValidationError(`${field} exceeds ${max} characters (got ${trimmed.length})`);
	}
	return trimmed || undefined;
}

/**
 * Tags are lowercased so `#Deploy` and `#deploy` are one tag. Filtering is exact
 * match against `post_tags`, so without this the same tag typed two ways would
 * split the timeline in a way the user can see but not explain.
 */
function normalizeTags(input: unknown): string[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) throw new ValidationError('tags must be an array of strings');

	const seen = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== 'string') throw new ValidationError('tags must be an array of strings');
		const tag = raw.trim().toLowerCase().replace(/^#/, '');
		if (!tag) continue;
		if (tag.length > MAX_TAG_LEN) {
			throw new ValidationError(`tag "${tag}" exceeds ${MAX_TAG_LEN} characters`);
		}
		seen.add(tag);
	}
	if (seen.size > MAX_TAGS) throw new ValidationError(`too many tags (max ${MAX_TAGS})`);
	return [...seen];
}

function normalizeTs(input: unknown): string {
	if (input === undefined || input === null || input === '') return new Date().toISOString();
	if (typeof input !== 'string') throw new ValidationError('ts must be an ISO-8601 string');
	const parsed = new Date(input);
	if (Number.isNaN(parsed.getTime())) throw new ValidationError(`ts is not a valid date: ${input}`);
	// Normalize to UTC ISO so that `ORDER BY ts` -- a *lexicographic* sort on a
	// TEXT column -- is a chronological sort. Mixed offsets would silently
	// scramble the feed's ordering.
	return parsed.toISOString();
}

/** A post that has cleared validation: required fields present, defaults applied. */
type ValidatedPost = PostInput & {
	ts: string;
	kind: string;
	tags: string[];
	meta: PostMeta;
};

export function validate(input: unknown): ValidatedPost {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new ValidationError('post must be a JSON object');
	}
	const raw = input as Record<string, unknown>;

	const meta = raw.meta ?? {};
	if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
		throw new ValidationError('meta must be a JSON object');
	}

	return {
		ts: normalizeTs(raw.ts),
		source: str(raw.source, 'source', 100, true)!,
		kind: str(raw.kind, 'kind', 50) ?? 'event',
		title: str(raw.title, 'title', MAX_TITLE, true)!,
		body: str(raw.body, 'body', MAX_BODY),
		tags: normalizeTags(raw.tags),
		meta: meta as Post['meta'],
		dedupe_key: str(raw.dedupe_key, 'dedupe_key', 200)
	};
}

/** Convenience wrapper: a single post is just a batch of one. */
export function insertPost(db: Db, input: unknown): PostWriteResult {
	return insertPosts(db, [input])[0];
}

/**
 * Writes a batch of posts atomically. Either all of them land or none do.
 *
 * Atomicity is what makes a batch safely retryable. If a bad post at index 9 left
 * 0-8 committed, the client's natural response -- fix it and resend the batch --
 * would duplicate the first nine. So every post is validated *before* the
 * transaction opens, which is where malformed input actually fails.
 *
 * (The spool drain deliberately does NOT use this: there, one bad line must not
 * strand every good line behind it, so it inserts post by post and quarantines
 * the failures.)
 */
export function insertPosts(db: Db, inputs: unknown[]): PostWriteResult[] {
	const validated = inputs.map(validate);

	// One transaction also means a post and its tag rows can never be half-written
	// -- a post whose tags failed to land would be invisible to every tag filter.
	db.exec('BEGIN IMMEDIATE');
	try {
		const results = validated.map((p) => writePost(db, p));
		db.exec('COMMIT');
		return results;
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

/**
 * Writes one validated post, or updates the recent one carrying the same
 * `dedupe_key`. Assumes an open transaction.
 *
 * The dedupe window is what makes a poller idempotent: GitHub re-reporting the
 * same PR every 60s should mutate one card, not append a hundred. Outside the
 * window the same key posts afresh, so a nightly build that fails every night
 * still gets one entry per night.
 */
function writePost(db: Db, p: ValidatedPost): PostWriteResult {
	const now = new Date().toISOString();
	const tagsJson = JSON.stringify(p.tags);
	const metaJson = JSON.stringify(p.meta);
	const project = typeof p.meta.project === 'string' ? p.meta.project : null;
	const repo = typeof p.meta.repo === 'string' ? p.meta.repo : null;

	const existingId = p.dedupe_key ? findDedupeTarget(db, p.dedupe_key, now) : null;

	let id: string;
	if (existingId) {
		id = existingId;
		db.prepare(
			`UPDATE posts
			    SET ts = ?, source = ?, kind = ?, title = ?, body = ?, tags = ?,
			        project = ?, repo = ?, meta = ?, updated_at = ?
			  WHERE id = ?`
		).run(p.ts, p.source, p.kind, p.title, p.body ?? null, tagsJson, project, repo, metaJson, now, id);
		// Replaced wholesale, not merged: a build that was #running and is now
		// #passed must stop matching a #running filter.
		db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(id);
	} else {
		// MONOTONIC ulid, not the plain one: the feed sorts by (ts, id), so the id
		// is the tiebreaker whenever two posts share a timestamp -- which is
		// routine, since a burst of hook events easily lands in the same
		// millisecond and `ts` only has millisecond resolution. Plain ulid()
		// randomizes its suffix within a millisecond, which would order those posts
		// arbitrarily (and differently on each query). monotonicUlid() guarantees a
		// strictly increasing id, so the tiebreak is insertion order -- which is
		// what a timeline means by "newest".
		id = monotonicUlid();
		db.prepare(
			`INSERT INTO posts
			   (id, ts, source, kind, title, body, tags, project, repo, meta, dedupe_key, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			p.ts,
			p.source,
			p.kind,
			p.title,
			p.body ?? null,
			tagsJson,
			project,
			repo,
			metaJson,
			p.dedupe_key ?? null,
			now,
			now
		);
	}

	const insertTag = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)');
	for (const tag of p.tags) insertTag.run(id, tag);

	// Sources are discovered, not registered: a slug exists because something
	// posted with it. Phase 6 hangs credentials and poll cursors off these rows.
	db.prepare(
		`INSERT INTO sources (slug, created_at, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (slug) DO UPDATE SET updated_at = excluded.updated_at`
	).run(p.source, now, now);

	const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as unknown as PostRow;
	return { post: rowToPost(row), deduped: existingId !== null };
}

function findDedupeTarget(db: Db, key: string, now: string): string | null {
	const cutoff = new Date(Date.parse(now) - DEDUPE_WINDOW_MS).toISOString();
	// created_at, not ts: the window is about how recently we *heard* about the
	// thing, and ts is client-controlled (a backfill could carry any timestamp).
	const row = db
		.prepare(
			`SELECT id FROM posts
			  WHERE dedupe_key = ? AND created_at >= ?
			  ORDER BY created_at DESC
			  LIMIT 1`
		)
		.get(key, cutoff) as unknown as { id: string } | undefined;
	return row?.id ?? null;
}

/**
 * FTS5's MATCH argument is a query *language*, not a string literal: bare user
 * input containing `"`, `*`, `:`, `AND`, or `-` is either a syntax error or,
 * worse, a silently different query. So we tokenize on whitespace and re-emit
 * each token as a quoted phrase, which FTS5 treats as opaque.
 *
 * The final token also gets a `*` so search feels like type-ahead: "depl"
 * matches "deploy" while the user is still typing.
 */
function toFtsQuery(q: string): string | null {
	const tokens = q
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		// Inside an FTS5 phrase, `"` is escaped by doubling it.
		.map((t) => t.replace(/"/g, '""'));

	if (tokens.length === 0) return null;
	return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ');
}

/**
 * Cursors are opaque on purpose: they encode `(ts, id)`, but clients must not
 * build or parse them, so we're free to change the keyset later.
 */
function encodeCursor(post: Post): string {
	return btoa(`${post.ts} ${post.id}`);
}

function decodeCursor(cursor: string): { ts: string; id: string } {
	try {
		const [ts, id] = atob(cursor).split(' ');
		if (!ts || !id) throw new Error('missing parts');
		return { ts, id };
	} catch {
		throw new ValidationError('invalid cursor');
	}
}

const normalizeTag = (tag: string) => tag.trim().toLowerCase().replace(/^#/, '');

/** The filter dimensions a facet count can exclude. See `queryFacets`. */
type Dimension = 'source' | 'project' | 'repo' | 'kind' | 'tag';

/**
 * Turns a filter into a WHERE clause. Shared by the feed and the facet counts,
 * so the two can never drift into disagreeing about what a filter means.
 *
 * `omit` drops one dimension from the clause -- that is what lets the filter bar
 * show "how many posts would I get if I *also* picked this?" rather than
 * collapsing every other option to zero once you pick one.
 */
function buildWhere(
	query: PostQuery,
	omit?: Dimension
): { where: string[]; params: (string | number)[] } {
	const where: string[] = [];
	const params: (string | number)[] = [];

	const inClause = (column: Dimension, values: string[] | undefined) => {
		if (omit === column || !values?.length) return;
		where.push(`p.${column} IN (${values.map(() => '?').join(', ')})`);
		params.push(...values);
	};

	inClause('source', query.source);
	inClause('project', query.project);
	inClause('repo', query.repo);
	inClause('kind', query.kind);

	// AND semantics: one EXISTS per tag, so "#deploy #failed" means both.
	if (omit !== 'tag') {
		for (const tag of query.tag ?? []) {
			where.push('EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)');
			params.push(normalizeTag(tag));
		}
	}

	// Mutes.
	//
	// NOT subject to `omit`, unlike the selections above: `omit` exists so the
	// picker stays widenable, but a muted value should never be offered at all --
	// inviting you to filter by something you've muted is nonsense.
	//
	// The carve-out is the selection instead: a muted value the user has
	// *explicitly* asked for is still shown. Muting means "keep this out of my way
	// by default", not "refuse to show it to me even when I ask", and a filter that
	// silently returned nothing because the thing you picked was muted would be
	// baffling.
	const excludedSources = (query.exclude_source ?? []).filter(
		(s) => !(query.source ?? []).includes(s)
	);
	if (excludedSources.length) {
		where.push(`p.source NOT IN (${excludedSources.map(() => '?').join(', ')})`);
		params.push(...excludedSources);
	}

	const selectedTags = (query.tag ?? []).map(normalizeTag);
	const excludedTags = (query.exclude_tag ?? [])
		.map(normalizeTag)
		.filter((t) => !selectedTags.includes(t));
	if (excludedTags.length) {
		where.push(
			`NOT EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag IN (${excludedTags
				.map(() => '?')
				.join(', ')}))`
		);
		params.push(...excludedTags);
	}

	// Exclusive lower bound, and that is the whole point of it existing alongside
	// `since` (which is inclusive): it backs a view's read marker. With `since`, a
	// post written in the very same millisecond as `last_seen_ts` would count as
	// unread the instant the view was created.
	if (query.after) {
		where.push('p.ts > ?');
		params.push(normalizeTs(query.after));
	}

	if (query.since) {
		where.push('p.ts >= ?');
		params.push(normalizeTs(query.since));
	}
	if (query.until) {
		where.push('p.ts <= ?');
		params.push(normalizeTs(query.until));
	}

	if (query.q?.trim()) {
		const fts = toFtsQuery(query.q);
		if (fts) {
			// A subquery rather than a join: we want the feed's chronological
			// ordering, not FTS5's relevance `rank`.
			where.push('p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)');
			params.push(fts);
		}
	}

	if (query.cursor) {
		const { ts, id } = decodeCursor(query.cursor);
		where.push('(p.ts, p.id) < (?, ?)');
		params.push(ts, id);
	}

	return { where, params };
}

const whereSql = (where: string[]) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

/**
 * Newest-first page of posts.
 *
 * Pagination is keyset, not OFFSET: the feed has a live head (new posts arrive
 * while you scroll), and OFFSET would duplicate or skip rows as everything
 * shifts down. `(ts, id) < (cursor.ts, cursor.id)` is stable regardless.
 */
export function queryPosts(db: Db, query: PostQuery): PostPage {
	const { where, params } = buildWhere(query);
	const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

	const sql = `
		SELECT p.* FROM posts p
		${whereSql(where)}
		ORDER BY p.ts DESC, p.id DESC
		LIMIT ?`;

	// Over-fetch by one: if the extra row exists there is another page, which
	// beats a COUNT(*) over the whole filtered set on every request.
	const rows = db.prepare(sql).all(...params, limit + 1) as unknown as PostRow[];

	const hasMore = rows.length > limit;
	const posts = rows.slice(0, limit).map(rowToPost);

	return {
		posts,
		next_cursor: hasMore && posts.length > 0 ? encodeCursor(posts[posts.length - 1]) : null
	};
}

export function getPost(db: Db, id: string): Post | null {
	const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as unknown as PostRow | undefined;
	return row ? rowToPost(row) : null;
}

export function countPosts(db: Db): number {
	const row = db.prepare('SELECT COUNT(*) AS n FROM posts').get() as unknown as { n: number };
	return Number(row.n);
}

/** How many posts match a filter. Used for a view's unread badge. */
export function countMatching(db: Db, query: PostQuery): number {
	const { where, params } = buildWhere({ ...query, cursor: undefined });
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql(where)}`)
		.get(...params) as unknown as { n: number };
	return Number(row.n);
}

/**
 * Deletes posts older than `days`. Returns how many went.
 *
 * `ts`, not `created_at`: retention is about how old the *event* was, which is
 * what the user means by "keep the last 30 days" -- a backfilled post from
 * six months ago is six months old however recently it was written.
 */
export function sweepRetention(db: Db, days: number): number {
	if (days <= 0) return 0; // 0 = keep everything

	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	// post_tags cascade; the FTS index is unwound by the delete trigger.
	const result = db.prepare('DELETE FROM posts WHERE ts < ?').run(cutoff);
	const deleted = Number(result.changes);

	if (deleted > 0) console.log(`[retention] deleted ${deleted} post(s) older than ${days} days`);
	return deleted;
}

/**
 * The values the filter bar can offer, and how many posts each would match.
 *
 * Every dimension is counted with the *other* filters applied but its own
 * omitted. Without that, picking `source=ci` would drop every other source to
 * zero and the picker would become a dead end -- you could never widen a
 * selection, only narrow it. Omitting the dimension answers the question the user
 * is actually asking: "what else could I add here?"
 *
 * The `cursor` is ignored: facets describe the whole filtered set, not the page
 * you happen to have scrolled to.
 */
export function queryFacets(db: Db, query: PostQuery): Facets {
	const countBy = (column: Exclude<Dimension, 'tag'>): Facet[] => {
		const { where, params } = buildWhere({ ...query, cursor: undefined }, column);
		const rows = db
			.prepare(
				`SELECT p.${column} AS value, COUNT(*) AS count
				   FROM posts p
				   ${whereSql([...where, `p.${column} IS NOT NULL`, `p.${column} != ''`])}
				  GROUP BY p.${column}
				  ORDER BY count DESC, value ASC`
			)
			.all(...params) as unknown as Facet[];
		return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
	};

	const { where, params } = buildWhere({ ...query, cursor: undefined }, 'tag');
	const tagRows = db
		.prepare(
			`SELECT t.tag AS value, COUNT(*) AS count
			   FROM post_tags t
			   JOIN posts p ON p.id = t.post_id
			   ${whereSql(where)}
			  GROUP BY t.tag
			  ORDER BY count DESC, value ASC`
		)
		.all(...params) as unknown as Facet[];

	return {
		source: countBy('source'),
		project: countBy('project'),
		repo: countBy('repo'),
		kind: countBy('kind'),
		tag: tagRows.map((r) => ({ value: r.value, count: Number(r.count) }))
	};
}
