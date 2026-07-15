/**
 * Per-post read state: which posts the reader has already seen.
 *
 * "Seen" is the reader's, not the post's, so it lives in its own table
 * (`seen_posts`) rather than a column a write path could clobber. A row exists iff
 * the post has been seen; marking is idempotent (`INSERT OR IGNORE`) so a card that
 * is clicked, then scrolled past, then bulk-cleared costs at most one row.
 *
 * The read side lives in `posts.ts` (`queryPosts`/`getPost` join this table to set
 * `post.seen`); this module owns only the writes.
 */

import type { Db } from './db.ts';
import type { PostQuery } from '../src/shared/types.ts';
import { buildWhere, whereSql } from './posts.ts';

/** Marks a post seen. Idempotent, and a no-op for an id that does not exist. */
export function markSeen(db: Db, id: string): void {
	// Guarded by EXISTS rather than the FK: `INSERT OR IGNORE` skips a duplicate
	// key but still *throws* on a foreign-key violation, so an id for a post that
	// was never written (or has been swept) would blow up. The WHERE EXISTS makes
	// it a real no-op with no extra round trip.
	db.prepare(
		`INSERT OR IGNORE INTO seen_posts (post_id, seen_at)
		 SELECT ?, ? WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?)`
	).run(id, new Date().toISOString(), id);
}

/** Clears a post's read marker, so it counts as unseen again ("mark as unread"). */
export function markUnseen(db: Db, id: string): void {
	db.prepare('DELETE FROM seen_posts WHERE post_id = ?').run(id);
}

/**
 * Marks every post matching `query` as seen, and returns how many newly were.
 *
 * Backs "mark all as read": the client passes the timeline's active filter, so
 * clearing while a view is open clears only that view, not the whole backlog. The
 * filter's mutes are honoured -- a muted post is one the reader can't see, so there
 * is nothing to mark. `INSERT OR IGNORE ... SELECT` does it in one statement rather
 * than a round trip per post, and the `changes` count excludes posts already seen.
 */
export function markAllSeen(db: Db, query: PostQuery): number {
	// cursor is meaningless here: "mark all as read" is about the whole filtered set,
	// not the page the reader happens to have scrolled to.
	const { where, params } = buildWhere({ ...query, cursor: undefined });
	const now = new Date().toISOString();

	const result = db
		.prepare(
			`INSERT OR IGNORE INTO seen_posts (post_id, seen_at)
			 SELECT p.id, ? FROM posts p ${whereSql(where)}`
		)
		.run(now, ...params);

	return Number(result.changes);
}
