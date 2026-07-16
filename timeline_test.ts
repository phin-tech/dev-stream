import { assertEquals } from "@std/assert";
import {
  activityArrivalMode,
  compactBodyPreview,
  needsProgressiveDisclosure,
  resolvePostPreview,
  resolveSidebarCollapsed,
  selectionRevealMode,
  postLinks,
} from "./src/lib/timeline.ts";

Deno.test("live activity appears inline when the reader is at the top", () => {
  assertEquals(activityArrivalMode({ pendingCount: 3, atTop: true }), "inline");
});

Deno.test("live activity preserves position and offers a newer-items indicator away from the top", () => {
  assertEquals(
    activityArrivalMode({ pendingCount: 3, atTop: false }),
    "indicator",
  );
});

Deno.test("the timeline shows no arrival affordance when nothing is pending", () => {
  assertEquals(activityArrivalMode({ pendingCount: 0, atTop: false }), "none");
});

Deno.test("short post bodies stay fully visible", () => {
  assertEquals(
    needsProgressiveDisclosure("A concise update with one useful sentence."),
    false,
  );
});

Deno.test("long post bodies use progressive disclosure", () => {
  assertEquals(needsProgressiveDisclosure("Context ".repeat(50)), true);
});

Deno.test("multi-line post bodies disclose even when their character count is modest", () => {
  assertEquals(
    needsProgressiveDisclosure(
      "Summary\n\n- first item\n- second item\n- third item",
    ),
    true,
  );
});

Deno.test("the sidebar starts expanded on a wide viewport", () => {
  assertEquals(
    resolveSidebarCollapsed({ narrow: false, override: null }),
    false,
  );
});

Deno.test("the sidebar automatically collapses on a narrow viewport", () => {
  assertEquals(resolveSidebarCollapsed({ narrow: true, override: null }), true);
});

Deno.test("an explicit expansion overrides narrow auto-collapse", () => {
  assertEquals(
    resolveSidebarCollapsed({ narrow: true, override: "expanded" }),
    false,
  );
});

Deno.test("an explicit collapse remains collapsed on a wide viewport", () => {
  assertEquals(
    resolveSidebarCollapsed({ narrow: false, override: "collapsed" }),
    true,
  );
});

Deno.test("compact previews flatten markdown into one readable line", () => {
  assertEquals(
    compactBodyPreview(
      "First **important** update.\n\n- Review [the PR](https://example.com)\n- Ship it",
    ),
    "First important update. Review the PR Ship it",
  );
});

Deno.test("an explicit summary is the compact-card preview", () => {
  assertEquals(
    resolvePostPreview({
      summary: "Review requested on the checkout PR.",
      body: "A much longer body.",
    }),
    "Review requested on the checkout PR.",
  );
});

Deno.test("body-only posts retain a derived compact preview", () => {
  assertEquals(
    resolvePostPreview({
      body: "Build **failed** during the integration suite.",
    }),
    "Build failed during the integration suite.",
  );
});

Deno.test("blank summaries fall back to the body instead of hiding useful context", () => {
  assertEquals(
    resolvePostPreview({ summary: "   ", body: "Useful fallback context." }),
    "Useful fallback context.",
  );
});

Deno.test("selecting the first post reveals the timeline heading", () => {
  assertEquals(selectionRevealMode(0), "top");
  assertEquals(selectionRevealMode(1), "nearest");
});

Deno.test("post links preserve declared priority and reject unsafe URLs", () => {
  assertEquals(
    postLinks({
      links: [
        { label: "Pull request", url: "https://example.com/pr/12" },
        { label: "unsafe", url: "javascript:alert(1)" },
      ],
      url: "https://example.com/fallback",
    }),
    [
      { label: "Pull request", url: "https://example.com/pr/12" },
      { label: "open", url: "https://example.com/fallback" },
    ],
  );
});
