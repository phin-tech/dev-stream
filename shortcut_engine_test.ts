import { assertEquals } from "@std/assert";
import {
  advanceShortcut,
  bindingConflicts,
  formatShortcut,
  initialShortcutState,
  type ShortcutDefinition,
  type ShortcutInput,
} from "./src/lib/shortcut-engine.ts";

const definitions: ShortcutDefinition[] = [
  { id: "palette", bindings: ["mod+k", ":"], scope: "global" },
  { id: "search", bindings: ["mod+f", "/"], scope: "timeline" },
  { id: "top", bindings: ["mod+arrowup", "g g"], scope: "timeline" },
  { id: "next", bindings: ["j"], scope: "timeline" },
  { id: "close-menu", bindings: ["escape"], scope: "menu", allowInText: true },
];

function key(key: string, overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

Deno.test("macOS mod bindings require Command and exact modifiers", () => {
  const matched = advanceShortcut(
    definitions,
    initialShortcutState,
    key("k", { metaKey: true }),
    { now: 0, platform: "mac", activeScopes: ["global"], textEntry: false },
  );
  assertEquals(matched.commandId, "palette");
  assertEquals(matched.handled, true);

  const ctrlIsNotCommand = advanceShortcut(
    definitions,
    initialShortcutState,
    key("k", { ctrlKey: true }),
    { now: 0, platform: "mac", activeScopes: ["global"], textEntry: false },
  );
  assertEquals(ctrlIsNotCommand.commandId, null);

  const extraModifierDoesNotMatch = advanceShortcut(
    definitions,
    initialShortcutState,
    key("k", { metaKey: true, shiftKey: true }),
    { now: 0, platform: "mac", activeScopes: ["global"], textEntry: false },
  );
  assertEquals(extraModifierDoesNotMatch.commandId, null);
});

Deno.test("Vim sequences wait for completion and then resolve", () => {
  const first = advanceShortcut(
    definitions,
    initialShortcutState,
    key("g"),
    { now: 100, platform: "mac", activeScopes: ["timeline", "global"], textEntry: false },
  );
  assertEquals(first.commandId, null);
  assertEquals(first.handled, true);
  assertEquals(first.state.pending, ["g"]);

  const second = advanceShortcut(definitions, first.state, key("g"), {
    now: 500,
    platform: "mac",
    activeScopes: ["timeline", "global"],
    textEntry: false,
  });
  assertEquals(second.commandId, "top");
  assertEquals(second.state, initialShortcutState);
});

Deno.test("an expired Vim sequence starts over without firing", () => {
  const first = advanceShortcut(
    definitions,
    initialShortcutState,
    key("g"),
    { now: 100, platform: "mac", activeScopes: ["timeline"], textEntry: false },
  );
  const expired = advanceShortcut(definitions, first.state, key("g"), {
    now: 901,
    platform: "mac",
    activeScopes: ["timeline"],
    textEntry: false,
  });
  assertEquals(expired.commandId, null);
  assertEquals(expired.state.pending, ["g"]);
});

Deno.test("plain shortcuts never fire while editing text or composing", () => {
  const editing = advanceShortcut(
    definitions,
    initialShortcutState,
    key("j"),
    { now: 0, platform: "mac", activeScopes: ["timeline"], textEntry: true },
  );
  assertEquals(editing.commandId, null);
  assertEquals(editing.handled, false);

  const composing = advanceShortcut(
    definitions,
    initialShortcutState,
    key(":" , { isComposing: true }),
    { now: 0, platform: "mac", activeScopes: ["global"], textEntry: false },
  );
  assertEquals(composing.commandId, null);
  assertEquals(composing.handled, false);
});

Deno.test("the most specific active scope wins", () => {
  const result = advanceShortcut(
    definitions,
    initialShortcutState,
    key("Escape"),
    {
      now: 0,
      platform: "mac",
      activeScopes: ["menu", "timeline", "global"],
      textEntry: true,
    },
  );
  assertEquals(result.commandId, "close-menu");
});

Deno.test("conflict detection rejects duplicate bindings in the same scope", () => {
  assertEquals(
    bindingConflicts([
      { id: "one", bindings: ["j"], scope: "timeline" },
      { id: "two", bindings: ["J", "mod+j"], scope: "timeline" },
      { id: "menu-j", bindings: ["j"], scope: "menu" },
    ]),
    [{ binding: "j", scope: "timeline", commandIds: ["one", "two"] }],
  );
});

Deno.test("shortcut labels use native macOS glyphs and readable sequences", () => {
  assertEquals(formatShortcut("mod+shift+s", "mac"), "⌘⇧S");
  assertEquals(formatShortcut("g g", "mac"), "G G");
  assertEquals(formatShortcut("escape", "mac"), "Esc");
});

Deno.test("shift-produced punctuation matches the character while capital letters retain Shift", () => {
  const help = advanceShortcut(
    [{ id: "help", bindings: ["?"], scope: "global" }],
    initialShortcutState,
    key("?", { shiftKey: true }),
    { now: 0, platform: "mac", activeScopes: ["global"], textEntry: false },
  );
  assertEquals(help.commandId, "help");

  const capital = advanceShortcut(
    [{ id: "bottom", bindings: ["shift+g"], scope: "timeline" }],
    initialShortcutState,
    key("G", { shiftKey: true }),
    { now: 0, platform: "mac", activeScopes: ["timeline"], textEntry: false },
  );
  assertEquals(capital.commandId, "bottom");
});
