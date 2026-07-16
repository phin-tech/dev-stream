import { assertEquals } from "@std/assert";
import { escapeIntent } from "./src/lib/interaction-policy.ts";

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
