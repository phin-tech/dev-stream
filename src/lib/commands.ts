/**
 * A tiny command registry for the timeline.
 *
 * Every user action worth a name lives here as a `Command`: an id, a title, an
 * optional key-binding, and a `run`. The keyboard is just *one* entry point --
 * `dispatchKey` matches an event against the registry -- so the same commands can
 * later be surfaced from a palette or a toolbar without duplicating their logic.
 *
 * We run inside a system webview (Deno desktop), so there is no native menu to
 * intercept these chords: an `Escape` or a `Cmd+1` reaches the DOM, and matched
 * commands `preventDefault` so the webview's own defaults don't also fire.
 */

import { tick } from "svelte";
import type { Feed } from "./feed.svelte";
import type { ViewWithUnread } from "../shared/types";
import { selectionRevealMode } from "./timeline";
import type { FilterDimension } from "./filter-keyboard";
import {
  advanceShortcut,
  initialShortcutState,
  type ShortcutDefinition,
  type ShortcutState,
} from "./shortcut-engine";

/** Everything a command needs to act on the feed, without reaching into the DOM. */
export interface CommandContext {
  readonly feed: Feed;
  /** The scrolling feed element; null until the page has mounted. */
  readonly scroller: HTMLElement | null;
  scrollToTop(smooth?: boolean): void;
  openTimeline(): void;
  openView(view: ViewWithUnread): void | Promise<void>;
  showNew(): void;
  openSelectedDetails(): void;
  toggleSelectedQuickLook(): void;
  focusSearch(): void;
  scrollToBottom(): void;
  scrollPage(direction: 1 | -1): void;
  toggleSelectedRead(): void;
  toggleSidebar(): void;
  hasSelectedLink(): boolean;
  openSelectedLink(): void;
  toggleSelectedArchive(): void;
  openFilter(dimension: FilterDimension): void;
  clearFilters(): void;
}

export interface Command extends ShortcutDefinition {
  id: string;
  title: string;
  /**
   * Key-binding, e.g. `"mod+1"`, `"Escape"`, `"j"`. `mod` is Cmd on macOS and
   * Ctrl elsewhere. Omit for commands that are only invoked programmatically.
   */
  /** When present and false, the binding is ignored and the key falls through. */
  enabled?(ctx: CommandContext): boolean;
  run(ctx: CommandContext, event: KeyboardEvent): void | Promise<void>;
}

/** Does `spec` (e.g. `"mod+shift+k"`) describe exactly this keyboard event? */
export function matchKeys(spec: string, event: KeyboardEvent): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));

  // `mod` means Cmd or Ctrl -- whichever this platform uses -- so we accept
  // either. A spec without `mod` therefore requires *neither* to be held.
  if (mods.has("mod") !== (event.metaKey || event.ctrlKey)) return false;
  if (mods.has("shift") !== event.shiftKey) return false;
  if (mods.has("alt") !== event.altKey) return false;

  return event.key.toLowerCase() === key;
}

const commandStates = new WeakMap<CommandContext, ShortcutState>();

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select, [contenteditable='true'], [role='textbox']") ||
    target.isContentEditable;
}

/**
 * Runs the first registered command whose binding matches `event`.
 * Returns true if one fired. Text fields keep every plain keystroke; only
 * `whenTyping` commands (chords, Escape) are allowed to fire while typing.
 */
export function dispatchKey(
  commands: Command[],
  event: KeyboardEvent,
  ctx: CommandContext,
): boolean {
  if (event.defaultPrevented) return false;
  const available = commands.filter((command) => !command.enabled || command.enabled(ctx));
  const result = advanceShortcut(
    available,
    commandStates.get(ctx) ?? initialShortcutState,
    {
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.isComposing,
    },
    {
      now: performance.now(),
      platform: "mac",
      activeScopes: ["timeline", "global"],
      textEntry: isTextEntry(event.target),
    },
  );
  commandStates.set(ctx, result.state);
  if (!result.handled) return false;
  event.preventDefault();
  const command = available.find((candidate) => candidate.id === result.commandId);
  if (command) void command.run(ctx, event);
  return true;
}

/** Scrolls the newly-selected card into view once the DOM has caught up. */
export async function revealSelection(
  ctx: CommandContext,
  index: number,
): Promise<void> {
  if (index < 0) return;
  // The card may not exist yet if selection pulled in a new page.
  await tick();
  if (selectionRevealMode(index) === "top") {
    const firstCard = ctx.scroller?.querySelector<HTMLElement>(
      "article[data-post-id]",
    );
    const daymark = firstCard?.previousElementSibling;
    if (
      daymark instanceof HTMLElement && daymark.classList.contains("daymark")
    ) {
      daymark.scrollIntoView({ block: "start", behavior: "auto" });
    }
    ctx.scrollToTop();
    return;
  }
  ctx.scroller
    ?.querySelectorAll("article")[index]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
}

/** The always-present timeline commands. View shortcuts are built per-render. */
export const NAV_COMMANDS: Command[] = [
  {
    id: "reset-filters",
    title: "Reset filters",
    bindings: ["escape"],
    scope: "timeline",
    allowInText: true,
    // Only claim Escape when there is something to clear; otherwise let it do
    // whatever the focused control wants (e.g. clearing the search box itself).
    enabled: (ctx) =>
      ctx.feed.activeViewId !== null || Object.keys(ctx.feed.filter).length > 0,
    run: (ctx, event) => {
      ctx.openTimeline();
      // Drop focus out of the search box so j/k work immediately afterwards.
      (event.target as HTMLElement | null)?.blur();
    },
  },
  {
    id: "select-next",
    title: "Next post",
    bindings: ["arrowdown", "j"],
    scope: "timeline",
    run: (ctx) => revealSelection(ctx, ctx.feed.moveSelection(1)),
  },
  {
    id: "select-prev",
    title: "Previous post",
    bindings: ["arrowup", "k"],
    scope: "timeline",
    run: (ctx) => revealSelection(ctx, ctx.feed.moveSelection(-1)),
  },
  {
    id: "jump-to-top",
    title: "Jump to top",
    bindings: ["mod+arrowup", "g g"],
    scope: "timeline",
    run: (ctx) => {
      ctx.feed.selected = -1;
      ctx.scrollToTop(true);
    },
  },
  {
    id: "jump-to-bottom",
    title: "Jump to bottom",
    bindings: ["mod+arrowdown", "shift+g"],
    scope: "timeline",
    run: (ctx) => ctx.scrollToBottom(),
  },
  {
    id: "page-down",
    title: "Page down",
    bindings: ["ctrl+d"],
    scope: "timeline",
    run: (ctx) => ctx.scrollPage(1),
  },
  {
    id: "page-up",
    title: "Page up",
    bindings: ["ctrl+u"],
    scope: "timeline",
    run: (ctx) => ctx.scrollPage(-1),
  },
  {
    id: "focus-search",
    title: "Focus timeline search",
    bindings: ["mod+f", "/"],
    scope: "timeline",
    run: (ctx) => ctx.focusSearch(),
  },
  {
    id: "open-details",
    title: "Open selected post details",
    bindings: ["enter", "o"],
    scope: "timeline",
    enabled: (ctx) => ctx.feed.selected >= 0,
    run: (ctx) => ctx.openSelectedDetails(),
  },
  {
    id: "toggle-quick-look",
    title: "Quick Look selected post",
    bindings: ["space"],
    scope: "timeline",
    enabled: (ctx) => ctx.feed.selected >= 0,
    run: (ctx) => ctx.toggleSelectedQuickLook(),
  },
  {
    id: "toggle-read",
    title: "Mark selected post read or unread",
    bindings: ["m"],
    scope: "timeline",
    enabled: (ctx) => ctx.feed.selected >= 0,
    run: (ctx) => ctx.toggleSelectedRead(),
  },
  {
    id: "toggle-sidebar",
    title: "Collapse or expand views",
    bindings: ["mod+b", "z"],
    scope: "timeline",
    run: (ctx) => ctx.toggleSidebar(),
  },
  {
    id: "open-primary-link",
    title: "Open selected post's primary link",
    bindings: ["g l", "mod+enter"],
    scope: "timeline",
    enabled: (ctx) => ctx.hasSelectedLink(),
    run: (ctx) => ctx.openSelectedLink(),
  },
  {
    id: "toggle-archive",
    title: "Archive or restore selected post",
    bindings: ["a"],
    scope: "timeline",
    enabled: (ctx) => ctx.feed.selected >= 0,
    run: (ctx) => ctx.toggleSelectedArchive(),
  },
  {
    id: "filter-source",
    title: "Filter by source",
    bindings: ["f s"],
    scope: "timeline",
    run: (ctx) => ctx.openFilter("source"),
  },
  {
    id: "filter-project",
    title: "Filter by project",
    bindings: ["f p"],
    scope: "timeline",
    run: (ctx) => ctx.openFilter("project"),
  },
  {
    id: "filter-repo",
    title: "Filter by repository",
    bindings: ["f r"],
    scope: "timeline",
    run: (ctx) => ctx.openFilter("repo"),
  },
  {
    id: "filter-kind",
    title: "Filter by kind",
    bindings: ["f k"],
    scope: "timeline",
    run: (ctx) => ctx.openFilter("kind"),
  },
  {
    id: "filter-tag",
    title: "Filter by tag",
    bindings: ["f t"],
    scope: "timeline",
    run: (ctx) => ctx.openFilter("tag"),
  },
  {
    id: "clear-filters",
    title: "Clear all filters",
    bindings: ["f c"],
    scope: "timeline",
    enabled: (ctx) => Object.keys(ctx.feed.filter).length > 0,
    run: (ctx) => ctx.clearFilters(),
  },
  {
    id: "open-timeline",
    title: "Open timeline",
    bindings: ["mod+0"],
    scope: "global",
    allowInText: true,
    run: (ctx) => ctx.openTimeline(),
  },
  {
    // `.` is the conventional "show me what arrived" key in a live feed.
    id: "show-new",
    title: "Show new posts",
    bindings: ["."],
    scope: "timeline",
    enabled: (ctx) => ctx.feed.pending.length > 0,
    run: (ctx) => ctx.showNew(),
  },
];

/**
 * A command per saved view for the first ten, bound to Cmd/Ctrl 1–9 and 0.
 * Derived from live state, so the titles and bindings track the sidebar.
 */
export function viewCommands(views: ViewWithUnread[]): Command[] {
  return views.slice(0, 9).map((view, i) => ({
    id: `open-view:${view.id}`,
    title: `Open view: ${view.name}`,
    // i = 0..8 -> 1..9; the tenth (i = 9) takes 0, matching the key row.
    bindings: [`mod+${i + 1}`],
    scope: "global",
    allowInText: true,
    run: (ctx) => ctx.openView(view),
  }));
}
