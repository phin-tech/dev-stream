/**
 * SQLite via `node:sqlite` (built into Deno 2, zero deps).
 *
 * Migrations are a plain ordered array keyed off `PRAGMA user_version`. Adding a
 * migration means appending to `MIGRATIONS` -- never editing an existing entry,
 * which would silently skip on any database that already ran it.
 */

import { DatabaseSync } from "node:sqlite";
import { diag } from "./diag.ts";

// TEMPORARY: if this fires BEFORE the win.bind lines in main.ts, node:sqlite was
// evaluated too early and that is what silently kills the binds.
diag("EVAL server/db.ts body — node:sqlite has now been evaluated");

export type Db = DatabaseSync;

/**
 * Ordered, append-only. Index + 1 is the resulting `user_version`.
 */
const MIGRATIONS: string[] = [
  // --- 1: posts, tags, full-text index, views, sources -----------------------
  `
	CREATE TABLE posts (
		id          TEXT PRIMARY KEY,          -- ULID: unique + time-sortable
		ts          TEXT NOT NULL,             -- ISO-8601 UTC; client-supplied or server-assigned
		source      TEXT NOT NULL,
		kind        TEXT NOT NULL DEFAULT 'event',
		title       TEXT NOT NULL,
		body        TEXT,
		-- Denormalized JSON array. post_tags below is the *filterable* copy; this
		-- one exists so reading a page of posts is a single row read with no join.
		tags        TEXT NOT NULL DEFAULT '[]',
		-- Promoted out of meta because the plan makes them first-class filters.
		project     TEXT,
		repo        TEXT,
		meta        TEXT NOT NULL DEFAULT '{}',
		dedupe_key  TEXT,
		created_at  TEXT NOT NULL,
		updated_at  TEXT NOT NULL
	);

	-- The feed's one true ordering, and the keyset-pagination index.
	CREATE INDEX posts_ts_id      ON posts (ts DESC, id DESC);
	CREATE INDEX posts_source_ts  ON posts (source, ts DESC);
	CREATE INDEX posts_project_ts ON posts (project, ts DESC);
	CREATE INDEX posts_repo_ts    ON posts (repo, ts DESC);
	CREATE INDEX posts_kind_ts    ON posts (kind, ts DESC);
	-- Partial: the vast majority of posts carry no dedupe_key.
	CREATE INDEX posts_dedupe     ON posts (dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL;

	CREATE TABLE post_tags (
		post_id TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
		tag     TEXT NOT NULL,
		PRIMARY KEY (post_id, tag)
	);
	CREATE INDEX post_tags_tag ON post_tags (tag);

	-- External-content FTS5: the index stores only the inverted terms and reads
	-- column values back from posts, so we don't keep a second copy of every body.
	CREATE VIRTUAL TABLE posts_fts USING fts5 (
		title, body, tags,
		content = 'posts',
		content_rowid = 'rowid'
	);

	-- External-content tables are NOT auto-synced; these triggers are load-bearing.
	-- Deletes are expressed as the magic 'delete' command row with the OLD values,
	-- which is how FTS5 unwinds the postings it wrote.
	CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
		INSERT INTO posts_fts (rowid, title, body, tags)
		VALUES (new.rowid, new.title, new.body, new.tags);
	END;
	CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
		INSERT INTO posts_fts (posts_fts, rowid, title, body, tags)
		VALUES ('delete', old.rowid, old.title, old.body, old.tags);
	END;
	CREATE TRIGGER posts_fts_au AFTER UPDATE ON posts BEGIN
		INSERT INTO posts_fts (posts_fts, rowid, title, body, tags)
		VALUES ('delete', old.rowid, old.title, old.body, old.tags);
		INSERT INTO posts_fts (rowid, title, body, tags)
		VALUES (new.rowid, new.title, new.body, new.tags);
	END;

	-- Saved views (Phase 4 owns the UI; the table lands with the schema).
	CREATE TABLE views (
		id           TEXT PRIMARY KEY,
		name         TEXT NOT NULL UNIQUE,
		filter       TEXT NOT NULL,            -- JSON PostFilter
		pinned       INTEGER NOT NULL DEFAULT 0,
		position     INTEGER NOT NULL DEFAULT 0,
		last_seen_ts TEXT,                     -- drives unread counts
		created_at   TEXT NOT NULL,
		updated_at   TEXT NOT NULL
	);

	-- Known sources: display metadata now, integration credentials + poll cursors
	-- in Phase 6. Rows are created lazily the first time a slug posts.
	CREATE TABLE sources (
		slug       TEXT PRIMARY KEY,
		label      TEXT,
		color      TEXT,
		muted      INTEGER NOT NULL DEFAULT 0,
		config     TEXT NOT NULL DEFAULT '{}',
		cursor     TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	`,

  // --- 2: user-editable settings ---------------------------------------------
  // Key/value rather than one row with a column per setting: settings accrete
  // across phases (retention now, integration toggles in Phase 6) and adding one
  // shouldn't need a migration.
  `
	CREATE TABLE settings (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,      -- JSON-encoded, so numbers/bools survive the round-trip
		updated_at TEXT NOT NULL
	);
	`,

  // --- 3: integration state on `sources` --------------------------------------
  // The sources table already existed (rows are created lazily whenever a slug
  // posts). Integrations are just sources that also poll, so they hang their
  // enablement, credentials, watermark and last error off the same row rather
  // than getting a table of their own.
  `
	ALTER TABLE sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
	-- Surfaced in the UI: a poller that has been quietly 401ing for a week is the
	-- single most likely way this feature goes wrong.
	ALTER TABLE sources ADD COLUMN last_error TEXT;
	ALTER TABLE sources ADD COLUMN last_polled_at TEXT;
	`,

  // --- 4: per-post read state -------------------------------------------------
  // A row exists iff the reader has seen that post; its absence is "unseen". A
  // join-and-check table rather than a `seen` column on posts, because read state
  // is the reader's, not the post's: a write path (a hook, a poller re-reporting a
  // deduped PR) must never accidentally clear or set it. ON DELETE CASCADE ties it
  // to retention -- when a post is swept, its read marker goes with it.
  `
	CREATE TABLE seen_posts (
		post_id TEXT PRIMARY KEY REFERENCES posts (id) ON DELETE CASCADE,
		seen_at TEXT NOT NULL
	);
	`,

  // --- 5: explicit compact-card summaries -----------------------------------
  `
	ALTER TABLE posts ADD COLUMN summary TEXT;
	DROP TRIGGER posts_fts_ai;
	DROP TRIGGER posts_fts_ad;
	DROP TRIGGER posts_fts_au;
	DROP TABLE posts_fts;
	CREATE VIRTUAL TABLE posts_fts USING fts5 (
		title, summary, body, tags, content = 'posts', content_rowid = 'rowid'
	);
	CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
		INSERT INTO posts_fts (rowid, title, summary, body, tags)
		VALUES (new.rowid, new.title, new.summary, new.body, new.tags);
	END;
	CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
		INSERT INTO posts_fts (posts_fts, rowid, title, summary, body, tags)
		VALUES ('delete', old.rowid, old.title, old.summary, old.body, old.tags);
	END;
	CREATE TRIGGER posts_fts_au AFTER UPDATE ON posts BEGIN
		INSERT INTO posts_fts (posts_fts, rowid, title, summary, body, tags)
		VALUES ('delete', old.rowid, old.title, old.summary, old.body, old.tags);
		INSERT INTO posts_fts (rowid, title, summary, body, tags)
		VALUES (new.rowid, new.title, new.summary, new.body, new.tags);
	END;
	INSERT INTO posts_fts(posts_fts) VALUES('rebuild');
	`,

  // --- 6: plugin trust --------------------------------------------------------
  // The sha256 of the plugin manifest the user trusted, on the same `sources`
  // row everything else about an integration lives on. NULL means "never
  // trusted" (every built-in, and every plugin before its first grant). Trust
  // is checked by comparing this against the CURRENT manifest's hash, so
  // editing a manifest — say, adding a host to `permissions.net` — revokes it
  // implicitly.
  `
	ALTER TABLE sources ADD COLUMN trusted_hash TEXT;
	`,

  // --- 7: reversible per-post archive state ---------------------------------
  `
	CREATE TABLE archived_posts (
		post_id     TEXT PRIMARY KEY REFERENCES posts (id) ON DELETE CASCADE,
		archived_at TEXT NOT NULL
	);
	`,
];

/**
 * Opens the database, applies pragmas, and migrates to the latest schema.
 *
 * @param path a filesystem path, or `:memory:` in tests.
 */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);

  // WAL keeps a reader (the UI querying a page) from blocking a writer (a hook
  // posting), which is the whole access pattern here. NORMAL trades an fsync
  // per commit for the risk of losing the last few posts on an OS crash --
  // the right trade for a local activity feed.
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  // Off by default in SQLite, and post_tags' ON DELETE CASCADE depends on it.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as unknown as {
    user_version: number;
  };
  const current = row.user_version;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      // user_version does not accept a bound parameter; `version + 1` is a
      // loop counter, not user input, so the interpolation is safe.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${version + 1} failed: ${err}`, {
        cause: err,
      });
    }
  }
}
