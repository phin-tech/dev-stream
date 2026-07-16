import { assert, assertEquals, assertThrows } from "@std/assert";
import { openDb } from "./db.ts";
import {
  countPosts,
  insertPost,
  queryPosts,
  ValidationError,
} from "./posts.ts";
import { DEDUPE_WINDOW_MS } from "./paths.ts";
import { archivePost, restorePost } from "./archive.ts";

const db = () => openDb(":memory:");

Deno.test("insert applies defaults and reads back", () => {
  const d = db();
  const { post, deduped } = insertPost(d, { source: "cli", title: "hello" });

  assertEquals(post.source, "cli");
  assertEquals(post.kind, "event"); // defaulted
  assertEquals(post.tags, []);
  assertEquals(post.meta, {});
  assertEquals(deduped, false);
  assert(post.id.length > 0);
  assert(!Number.isNaN(Date.parse(post.ts))); // server-assigned
  // Absent optionals must not come back as nulls.
  assertEquals(post.body, undefined);
  assertEquals(post.summary, undefined);
  assertEquals(post.dedupe_key, undefined);
});

Deno.test("summary survives round-trip and is searchable", () => {
  const d = db();
  const { post } = insertPost(d, {
    source: "agent",
    title: "Shipped checkout",
    summary: "Payment retries are now resilient.",
    body: "Long implementation detail.",
  });
  assertEquals(post.summary, "Payment retries are now resilient.");
  assertEquals(queryPosts(d, { q: "resilient" }).posts[0].id, post.id);
});

Deno.test("archived posts leave the timeline and remain recoverable", () => {
  const d = db();
  const { post } = insertPost(d, { source: "agent", title: "finished task" });

  assertEquals(archivePost(d, post.id), true);
  assertEquals(queryPosts(d, {}).posts, []);
  assertEquals(queryPosts(d, { archived: true }).posts[0].archived, true);

  assertEquals(restorePost(d, post.id), true);
  assertEquals(queryPosts(d, { archived: true }).posts, []);
  assertEquals(queryPosts(d, {}).posts[0].archived, false);
});

Deno.test("rejects posts missing required fields", () => {
  const d = db();
  assertThrows(
    () => insertPost(d, { title: "no source" }),
    ValidationError,
    "source is required",
  );
  assertThrows(
    () => insertPost(d, { source: "cli" }),
    ValidationError,
    "title is required",
  );
  assertThrows(
    () => insertPost(d, { source: "cli", title: "   " }),
    ValidationError,
    "title is required",
  );
  assertThrows(
    () => insertPost(d, { source: "cli", title: "x", ts: "nonsense" }),
    ValidationError,
  );
  assertThrows(() => insertPost(d, "not an object"), ValidationError);
  // Nothing partial should have landed.
  assertEquals(countPosts(d), 0);
});

Deno.test("tags are lowercased, de-hashed and deduplicated", () => {
  const d = db();
  const { post } = insertPost(d, {
    source: "cli",
    title: "x",
    tags: ["#Deploy", "deploy", " CI ", ""],
  });
  assertEquals(post.tags.toSorted(), ["ci", "deploy"]);

  // ...and the normalized form is what filtering matches, however it's typed.
  assertEquals(queryPosts(d, { tag: ["#DEPLOY"] }).posts.length, 1);
});

Deno.test("ts is normalized to UTC so lexicographic ordering is chronological", () => {
  const d = db();
  // Same instant, expressed in a non-UTC offset. Stored raw, "2026-07-13T23:00:00+02:00"
  // would sort *after* the UTC 22:00 post below, scrambling the feed.
  insertPost(d, {
    source: "a",
    title: "earlier",
    ts: "2026-07-13T23:00:00+02:00",
  }); // 21:00Z
  insertPost(d, { source: "b", title: "later", ts: "2026-07-13T22:00:00Z" });

  assertEquals(
    queryPosts(d, {}).posts.map((p) => p.title),
    ["later", "earlier"],
  );
});

Deno.test("meta.project and meta.repo are promoted to filterable columns", () => {
  const d = db();
  insertPost(d, {
    source: "claude-code",
    title: "edited a file",
    meta: {
      project: "dev-stream",
      repo: "phin-tech/dev-stream",
      branch: "main",
    },
  });

  assertEquals(queryPosts(d, { project: ["dev-stream"] }).posts.length, 1);
  assertEquals(
    queryPosts(d, { repo: ["phin-tech/dev-stream"] }).posts.length,
    1,
  );
  assertEquals(queryPosts(d, { project: ["other"] }).posts.length, 0);
  // The rest of meta survives the round-trip.
  assertEquals(queryPosts(d, {}).posts[0].meta.branch, "main");
});

Deno.test("dedupe_key updates the existing post inside the window", () => {
  const d = db();
  const first = insertPost(d, {
    source: "ci",
    title: "build running",
    dedupe_key: "build-42",
  });
  const second = insertPost(d, {
    source: "ci",
    title: "build passed",
    dedupe_key: "build-42",
    tags: ["green"],
  });

  assertEquals(second.deduped, true);
  assertEquals(second.post.id, first.post.id); // same card, mutated
  assertEquals(countPosts(d), 1);

  const [post] = queryPosts(d, {}).posts;
  assertEquals(post.title, "build passed");
  assertEquals(post.tags, ["green"]);
});

Deno.test("dedupe_key posts afresh outside the window", () => {
  const d = db();
  const first = insertPost(d, {
    source: "ci",
    title: "nightly failed",
    dedupe_key: "nightly",
  });

  // Age the first post past the window. created_at (not ts) is what the window
  // consults, so this is the honest way to simulate the passage of time.
  const stale = new Date(Date.now() - DEDUPE_WINDOW_MS - 1000).toISOString();
  d.prepare("UPDATE posts SET created_at = ? WHERE id = ?").run(
    stale,
    first.post.id,
  );

  const second = insertPost(d, {
    source: "ci",
    title: "nightly failed",
    dedupe_key: "nightly",
  });

  assertEquals(second.deduped, false);
  assertEquals(countPosts(d), 2); // one entry per night, as intended
});

Deno.test("dedupe replaces tags rather than accumulating them", () => {
  const d = db();
  insertPost(d, {
    source: "ci",
    title: "run",
    dedupe_key: "k",
    tags: ["running"],
  });
  insertPost(d, {
    source: "ci",
    title: "run",
    dedupe_key: "k",
    tags: ["passed"],
  });

  assertEquals(queryPosts(d, { tag: ["running"] }).posts.length, 0); // stale tag gone
  assertEquals(queryPosts(d, { tag: ["passed"] }).posts.length, 1);
});

Deno.test("filters combine with AND, and multiple tags require all of them", () => {
  const d = db();
  insertPost(d, {
    source: "ci",
    kind: "alert",
    title: "a",
    tags: ["deploy", "failed"],
  });
  insertPost(d, { source: "ci", kind: "event", title: "b", tags: ["deploy"] });
  insertPost(d, { source: "github", kind: "pr", title: "c", tags: ["failed"] });

  assertEquals(queryPosts(d, { source: ["ci"] }).posts.length, 2);
  assertEquals(queryPosts(d, { source: ["ci", "github"] }).posts.length, 3); // IN, not AND
  assertEquals(queryPosts(d, { kind: ["alert"] }).posts.length, 1);
  assertEquals(queryPosts(d, { tag: ["deploy"] }).posts.length, 2);
  assertEquals(queryPosts(d, { tag: ["deploy", "failed"] }).posts.length, 1); // AND
  assertEquals(
    queryPosts(d, { source: ["ci"], tag: ["failed"] }).posts.length,
    1,
  );
});

Deno.test("since/until bound the range inclusively", () => {
  const d = db();
  insertPost(d, { source: "a", title: "old", ts: "2026-01-01T00:00:00Z" });
  insertPost(d, { source: "a", title: "mid", ts: "2026-06-01T00:00:00Z" });
  insertPost(d, { source: "a", title: "new", ts: "2026-12-01T00:00:00Z" });

  assertEquals(
    queryPosts(d, { since: "2026-06-01T00:00:00Z" }).posts.map((p) => p.title),
    [
      "new",
      "mid",
    ],
  );
  assertEquals(
    queryPosts(d, {
      since: "2026-02-01T00:00:00Z",
      until: "2026-07-01T00:00:00Z",
    }).posts.map(
      (p) => p.title,
    ),
    ["mid"],
  );
});

Deno.test("full-text search covers title, body and tags", () => {
  const d = db();
  insertPost(d, {
    source: "a",
    title: "Deployed to production",
    body: "took 4 minutes",
  });
  insertPost(d, { source: "a", title: "Unrelated", body: "nothing to see" });
  insertPost(d, { source: "a", title: "Tagged only", tags: ["deployment"] });

  assertEquals(queryPosts(d, { q: "production" }).posts.length, 1);
  assertEquals(queryPosts(d, { q: "minutes" }).posts.length, 1); // body
  assertEquals(queryPosts(d, { q: "deployment" }).posts.length, 1); // tags column
  // Trailing token is a prefix match, so search works while you type. "deploy"
  // prefixes both "Deployed" and the "deployment" tag.
  assertEquals(queryPosts(d, { q: "deploy" }).posts.length, 2);
  // Multiple tokens are AND-ed.
  assertEquals(queryPosts(d, { q: "deployed production" }).posts.length, 1);
  assertEquals(queryPosts(d, { q: "deployed unrelated" }).posts.length, 0);
});

Deno.test("search treats FTS5 operators as literal text rather than syntax", () => {
  const d = db();
  insertPost(d, { source: "a", title: "normal post" });

  // Each of these is a syntax error (or a silently different query) if the
  // input is passed to MATCH unescaped. None may throw.
  for (
    const q of [
      '"',
      'foo"bar',
      "AND",
      "NOT OR",
      "a*",
      "col:value",
      "-x",
      "(((",
      "^",
    ]
  ) {
    const page = queryPosts(d, { q });
    assertEquals(
      page.posts.length,
      0,
      `expected no match for ${JSON.stringify(q)}`,
    );
  }

  // And a query that is only punctuation must not become a match-everything.
  assertEquals(queryPosts(d, { q: "   " }).posts.length, 1); // blank => no filter applied
});

Deno.test("search combines with filters", () => {
  const d = db();
  insertPost(d, { source: "ci", title: "deploy failed" });
  insertPost(d, { source: "github", title: "deploy failed" });

  assertEquals(queryPosts(d, { q: "deploy", source: ["ci"] }).posts.length, 1);
});

Deno.test("deleting a post unwinds its FTS entry", () => {
  const d = db();
  const { post } = insertPost(d, { source: "a", title: "ephemeral secret" });
  assertEquals(queryPosts(d, { q: "ephemeral" }).posts.length, 1);

  // Retention sweeps (Phase 4) delete rows; a stale FTS index would keep
  // "finding" posts that no longer exist and then fail to join them.
  d.prepare("DELETE FROM posts WHERE id = ?").run(post.id);
  assertEquals(queryPosts(d, { q: "ephemeral" }).posts.length, 0);
});

Deno.test("keyset pagination walks every post exactly once", () => {
  const d = db();
  // All sharing one ts, so the (ts, id) tiebreaker is what's actually under
  // test: ordering by ts alone would make the cursor loop or skip, and a
  // non-monotonic id would order same-instant posts arbitrarily.
  const ts = "2026-07-13T12:00:00Z";
  for (let i = 0; i < 7; i++) {
    insertPost(d, { source: "a", title: `post ${i}`, ts });
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = queryPosts(d, { limit: 2, cursor });
    seen.push(...result.posts.map((p) => p.title));
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }

  assertEquals(seen.length, 7);
  assertEquals(new Set(seen).size, 7); // no duplicates, no skips
  assertEquals(seen[0], "post 6"); // newest first
  assertEquals(seen.at(-1), "post 0");
});

Deno.test("pagination is stable when new posts arrive mid-scroll", () => {
  const d = db();
  for (let i = 0; i < 4; i++) {
    insertPost(d, {
      source: "a",
      title: `old ${i}`,
      ts: `2026-07-13T0${i}:00:00Z`,
    });
  }

  const first = queryPosts(d, { limit: 2 });
  assertEquals(first.posts.map((p) => p.title), ["old 3", "old 2"]);

  // The live head grows while the user is paging -- the exact case OFFSET
  // pagination gets wrong (it would re-serve 'old 2' as the next page's head).
  insertPost(d, {
    source: "a",
    title: "brand new",
    ts: "2026-07-13T09:00:00Z",
  });

  const second = queryPosts(d, { limit: 2, cursor: first.next_cursor! });
  assertEquals(second.posts.map((p) => p.title), ["old 1", "old 0"]);
});

Deno.test("an invalid cursor is a client error, not a crash", () => {
  const d = db();
  assertThrows(
    () => queryPosts(d, { cursor: "not-base64!!" }),
    ValidationError,
    "invalid cursor",
  );
});

Deno.test("limit is clamped to a sane maximum", () => {
  const d = db();
  for (let i = 0; i < 3; i++) insertPost(d, { source: "a", title: `p${i}` });
  assertEquals(queryPosts(d, { limit: 100_000 }).posts.length, 3); // clamped, not rejected
});

Deno.test("posting registers the source", () => {
  const d = db();
  insertPost(d, { source: "claude-code", title: "x" });
  insertPost(d, { source: "claude-code", title: "y" });

  const rows = d.prepare("SELECT slug FROM sources").all() as unknown as {
    slug: string;
  }[];
  assertEquals(rows.map((r) => r.slug), ["claude-code"]); // upserted, not duplicated
});
