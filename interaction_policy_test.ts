import { assertEquals } from "@std/assert";
import {
  escapeIntent,
  quickLookIntent,
} from "./src/lib/interaction-policy.ts";

Deno.test("Escape closes an open card menu before changing timeline filters", () => {
  assertEquals(
    escapeIntent({ menuOpen: true, namingView: false, hasFilter: true }),
    "close-menu",
  );
});

Deno.test("Escape cancels view naming before changing timeline filters", () => {
  assertEquals(
    escapeIntent({ menuOpen: false, namingView: true, hasFilter: true }),
    "cancel-view-naming",
  );
});

Deno.test("Space opens Quick Look only when a post is selected", () => {
  assertEquals(
    quickLookIntent({ hasSelection: true, quickLookOpen: false }),
    "open",
  );
  assertEquals(
    quickLookIntent({ hasSelection: false, quickLookOpen: false }),
    "none",
  );
});

Deno.test("Space closes an open Quick Look", () => {
  assertEquals(
    quickLookIntent({ hasSelection: true, quickLookOpen: true }),
    "close",
  );
});
