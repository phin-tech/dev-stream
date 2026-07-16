import { assertEquals } from "@std/assert";
import {
  nextFilterOptionIndex,
  typeaheadFilterOptionIndex,
} from "./src/lib/filter-keyboard.ts";

Deno.test("filter option navigation wraps in both directions", () => {
  assertEquals(nextFilterOptionIndex(0, -1, 3), 2);
  assertEquals(nextFilterOptionIndex(2, 1, 3), 0);
  assertEquals(nextFilterOptionIndex(1, 1, 3), 2);
  assertEquals(nextFilterOptionIndex(0, 1, 0), -1);
});

Deno.test("filter typeahead starts after the current option and wraps", () => {
  const values = ["agent", "ci", "github", "monitor"];
  assertEquals(typeaheadFilterOptionIndex(values, 0, "g"), 2);
  assertEquals(typeaheadFilterOptionIndex(values, 3, "a"), 0);
  assertEquals(typeaheadFilterOptionIndex(values, 1, "zzz"), -1);
});
