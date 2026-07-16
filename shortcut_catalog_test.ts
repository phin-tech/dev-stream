import { assertEquals } from "@std/assert";
import {
  globalShortcutDefinitions,
  timelineShortcutDefinitions,
  viewShortcutDefinitions,
} from "./src/lib/shortcut-catalog.ts";
import type { ViewWithUnread } from "./src/shared/types.ts";

Deno.test("the global catalog follows macOS conventions", () => {
  const bindings = Object.fromEntries(
    globalShortcutDefinitions.map((command) => [command.id, command.bindings]),
  );
  assertEquals(bindings["open-command-palette"], ["mod+k", ":"]);
  assertEquals(bindings["show-shortcuts"], ["mod+/", "?"]);
  assertEquals(bindings["open-settings"], ["mod+,"]);
  assertEquals(bindings["open-timeline"], ["mod+0"]);
});

Deno.test("the timeline catalog includes the complete safe Vim navigation set", () => {
  const bindings = Object.fromEntries(
    timelineShortcutDefinitions.map((command) => [command.id, command.bindings]),
  );
  assertEquals(bindings["focus-search"], ["mod+f", "/"]);
  assertEquals(bindings["select-next"], ["arrowdown", "j"]);
  assertEquals(bindings["select-previous"], ["arrowup", "k"]);
  assertEquals(bindings["jump-to-top"], ["mod+arrowup", "g g"]);
  assertEquals(bindings["jump-to-bottom"], ["mod+arrowdown", "shift+g"]);
  assertEquals(bindings["page-down"], ["ctrl+d"]);
  assertEquals(bindings["page-up"], ["ctrl+u"]);
  assertEquals(bindings["open-details"], ["enter", "o"]);
  assertEquals(bindings["toggle-quick-look"], ["space"]);
  assertEquals(bindings["open-primary-link"], ["g l", "mod+enter"]);
  assertEquals(bindings["toggle-read"], ["m"]);
  assertEquals(bindings["show-new"], ["."]);
  assertEquals(bindings["toggle-sidebar"], ["mod+b", "z"]);
  assertEquals(bindings["toggle-archive"], ["a"]);
});

Deno.test("saved views use Command 1 through 9 and never assign a destructive command", () => {
  const views = Array.from({ length: 11 }, (_, index) => ({
    id: `view-${index + 1}`,
    name: `View ${index + 1}`,
    filter: {},
    unread: index,
  })) as unknown as ViewWithUnread[];

  const commands = viewShortcutDefinitions(views);
  assertEquals(commands.length, 9);
  assertEquals(commands[0].bindings, ["mod+1"]);
  assertEquals(commands[8].bindings, ["mod+9"]);
  assertEquals(commands.some((command) => command.id.includes("delete")), false);
});
