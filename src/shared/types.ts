/**
 * The contract shared by every part of dev-stream: the ingestion API, the CLI,
 * the MCP server, and the SvelteKit UI.
 *
 * IMPORTANT: this file must stay type-only and import-free. It is compiled both
 * by the npm toolchain (Vite / svelte-check, which typechecks `src/**`) and by
 * Deno (which runs the server from `server/`). Anything that only one of those
 * two understands -- a `node:` builtin, a `jsr:` specifier, a Deno global, a
 * runtime value -- breaks the other. Keep values out; put them in `server/`.
 */

/** Well-known kinds, but the field is deliberately open: any slug is accepted. */
export type PostKind =
  | "event"
  | "note"
  | "alert"
  | "pr"
  | "issue"
  | (string & {});

/** A labelled external link on a card, e.g. `{ label: 'PR', url: '…' }`. */
export interface PostLink {
  /** Short label shown on the chip, e.g. "PR", "Review", "Notification". */
  label: string;
  url: string;
}

/**
 * Open-ended per-post metadata. The keys called out here are the ones promoted
 * to real indexed columns (`project`, `repo`); everything else is stored as
 * JSON and is readable but not filterable.
 */
export interface PostMeta {
  project?: string;
  repo?: string;
  branch?: string;
  /** The single canonical link. Rendered as an "open" chip. */
  url?: string;
  /**
   * Additional labelled links, so a card can carry several references at once
   * (a PR *and* its review page, an issue *and* its notification). Rendered as a
   * row of named link chips alongside `url`.
   */
  links?: PostLink[];
  duration_ms?: number;
  [key: string]: unknown;
}

/** A post as stored and as returned by the API. */
export interface Post {
  id: string;
  /** ISO-8601 UTC. Server-assigned when the client omits it. */
  ts: string;
  /** Free-form origin slug, e.g. "claude-code", "ci", "github". */
  source: string;
  kind: PostKind;
  title: string;
  /** Plain-text compact-card context. */
  summary?: string;
  /** Markdown. Sanitized at render time, never at write time. */
  body?: string;
  tags: string[];
  meta: PostMeta;
  /** Re-posting the same key inside the dedupe window updates instead of duplicating. */
  dedupe_key?: string;
  /**
   * Whether the reader has seen this post. Read state is per-post and server-held,
   * so it holds across every window and survives a restart. Present on posts read
   * back from the timeline; absent (and treated as unseen) on a freshly written one.
   */
  seen?: boolean;
  /** Whether the reader has removed this post from the active timeline. */
  archived?: boolean;
  created_at: string;
  updated_at: string;
}

/** What a client sends to `POST /api/posts`. */
export interface PostInput {
  ts?: string;
  source: string;
  kind?: PostKind;
  title: string;
  summary?: string;
  body?: string;
  tags?: string[];
  meta?: PostMeta;
  dedupe_key?: string;
}

/**
 * The filter set behind both `GET /api/posts` and a saved view. Every field maps
 * 1:1 onto a query param, so a view is literally a serialized query.
 */
export interface PostFilter {
  source?: string[];
  project?: string[];
  repo?: string[];
  kind?: string[];
  /** AND semantics: a post must carry every listed tag. */
  tag?: string[];
  /** Full-text search over title, summary, body and tags. */
  q?: string;
  /** Inclusive ISO-8601 bounds. */
  since?: string;
  until?: string;
  /** Built-in Archive view. False/absent is the active timeline. */
  archived?: boolean;
}

export interface PostQuery extends PostFilter {
  limit?: number;
  /** Opaque keyset cursor from the previous page's `next_cursor`. */
  cursor?: string;
  /**
   * Sources/tags the user has muted. Applied by the API from settings, not sent
   * by clients -- muting is a property of the timeline, not of a request.
   */
  exclude_source?: string[];
  exclude_tag?: string[];
  /**
   * Exclusive lower bound on `ts`, as opposed to `since`, which is inclusive.
   * Backs a view's unread count: everything strictly after `last_seen_ts`.
   */
  after?: string;
}

export interface PostPage {
  posts: Post[];
  /** Null when this is the last page. */
  next_cursor: string | null;
}

/** Result of a write, so callers can tell an update apart from a fresh post. */
export interface PostWriteResult {
  post: Post;
  deduped: boolean;
}

/** A saved filter set. */
export interface View {
  id: string;
  name: string;
  filter: PostFilter;
  pinned: boolean;
  position: number;
  /** Everything newer than this is unread. Advanced when the view is opened. */
  last_seen_ts?: string;
  created_at: string;
  updated_at: string;
}

/** A view plus how many posts have arrived in it since it was last opened. */
export interface ViewWithUnread extends View {
  unread: number;
}

/** What a client sends to create or update a view. */
export interface ViewInput {
  name: string;
  filter: PostFilter;
  pinned?: boolean;
  position?: number;
}

/** One selectable value in the filter bar, with how many posts carry it. */
export interface Facet {
  value: string;
  count: number;
}

/**
 * The values available to filter by, given everything *else* the user has already
 * picked. Each dimension excludes its own selections from the count, so choosing
 * `source=ci` doesn't collapse the source list to a single entry.
 */
export interface Facets {
  source: Facet[];
  project: Facet[];
  repo: Facet[];
  kind: Facet[];
  tag: Facet[];
}

/** User-editable configuration, persisted in the `settings` table. */
export interface Settings {
  /** Delete posts older than this. 0 = keep everything. */
  retention_days: number;
  /**
   * Sources/tags hidden from the timeline.
   *
   * Muting hides, it does not stop ingestion: a muted source keeps posting, and
   * unmuting brings its history back. Deleting data because someone found it
   * noisy today would be the wrong trade.
   */
  muted_sources: string[];
  muted_tags: string[];
  /**
   * When true, a post is marked seen once it scrolls up out of the viewport, not
   * only when it is clicked or keyboard-selected. Off by default: "seen" then means
   * "scrolled past" rather than "looked at", which some readers want and some don't.
   */
  mark_seen_on_scroll: boolean;
}

/** Settings plus the read-only facts the settings page displays. */
export interface SettingsInfo extends Settings {
  db_path: string;
  port: number;
  post_count: number;
}

/** One credential/option an integration asks the settings page to collect. */
export interface ConfigField {
  key: string;
  label: string;
  /** Its value is never sent back to the client; only `configured` is. */
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

/**
 * The access a plugin's manifest asks for. This is both the sandbox spec (the
 * worker is spawned with exactly these permissions) and what the settings page
 * shows the user before they trust the plugin.
 */
export interface PluginPermissions {
  /** Outbound hosts, e.g. `["api.github.com"]`. */
  net?: string[];
  /**
   * Config keys whose value is a URL whose host is added to `net` at poll
   * time. This is how a plugin supports a self-hosted API (GitHub Enterprise)
   * without asking for unrestricted network access.
   */
  net_from_config?: string[];
  /** Extra readable paths. The plugin's own directory is always readable. */
  read?: string[];
  /** Writable paths. */
  write?: string[];
  /**
   * Executables the plugin may spawn, e.g. `["gh"]`. ELEVATED: a subprocess is
   * NOT sandboxed — it runs with the app's full permissions. The settings page
   * warns accordingly.
   */
  run?: string[];
  /** Environment variables it may read, e.g. `["GH_TOKEN"]`. */
  env?: string[];
}

export interface RegistryPlugin {
  slug: string;
  label: string;
  description: string;
  version: string;
  min_app_version: string;
  source: { owner: string; repo: string; ref: string; path: string };
  manifest_sha256: string;
}

export interface RegistryPluginStatus extends RegistryPlugin {
  installed: boolean;
  update_available: boolean;
  compatible: boolean;
}

/** An integration's state, as the settings page sees it. Carries no secrets. */
export interface SourceStatus {
  slug: string;
  label: string;
  /** Built-ins ship with the app; plugins were found in `~/.dev-stream/plugins`. */
  origin: "builtin" | "plugin";
  /**
   * Built-ins are always trusted. A plugin is trusted only after the user
   * explicitly granted it — and the grant binds to the manifest's content
   * hash, so editing the manifest (say, to add a host) revokes it.
   */
  trusted: boolean;
  /** What the plugin's manifest asks for. Absent for built-ins. */
  permissions?: PluginPermissions;
  enabled: boolean;
  /** True once every required secret has a stored value. */
  configured: boolean;
  fields: ConfigField[];
  config: Record<string, unknown>;
  cursor: string | null;
  last_error: string | null;
  last_polled_at: string | null;
}

/** Server-sent event payloads on `GET /api/events`. */
export type StreamEvent =
  | { type: "post"; post: Post; deduped: boolean }
  | { type: "hello"; server: ServerInfo };

/** Unauthenticated discovery payload from `GET /api/health`. */
export interface ServerInfo {
  app: "dev-stream";
  version: string;
  pid: number;
  port: number;
  started_at: string;
}

/**
 * Everything a client needs to talk to the local API.
 *
 * A `type`, not an `interface`, and that is load-bearing: this crosses a
 * `win.bind()` boundary, whose return type is `BrowserWindowReturn`
 * (`{ readonly [key: string]: unknown }`). TypeScript gives type aliases an
 * implicit index signature but withholds one from interfaces (an interface can
 * be augmented later, so its keys aren't final), so declaring this as an
 * interface makes it un-returnable from a binding.
 */
export type ApiConfig = {
  port: number;
  token: string;
};
