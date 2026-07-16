import type { Db } from "./db.ts";

export function archivePost(db: Db, id: string): boolean {
  const result = db.prepare(`
    INSERT INTO archived_posts (post_id, archived_at)
    SELECT id, ? FROM posts WHERE id = ?
    ON CONFLICT(post_id) DO UPDATE SET archived_at = excluded.archived_at
  `).run(new Date().toISOString(), id);
  return Number(result.changes) > 0;
}

export function restorePost(db: Db, id: string): boolean {
  const result = db.prepare("DELETE FROM archived_posts WHERE post_id = ?").run(id);
  return Number(result.changes) > 0;
}
