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

/** Everything a command needs to act on the feed, without reaching into the DOM. */
export interface CommandContext {
  readonly feed: Feed;
  /** The scrolling feed element; null until the page has mounted. */
  readonly scroller: HTMLElement | null;
  scrollToTop(smooth?: boolean): void;
  openTimeline(): void;
  openView(view: ViewWithUnread): void | Promise<void>;
  showNew(): void;
  toggleSelectedDetails(): void;
}

export interface Command {
  id: string;
  title: string;
  /**
   * Key-binding, e.g. `"mod+1"`, `"Escape"`, `"j"`. `mod` is Cmd on macOS and
   * Ctrl elsewhere. Omit for commands that are only invoked programmatically.
   */
  keys?: string;
  /** Fire even while a text field is focused. Only safe for chords and Escape. */
  whenTyping?: boolean;
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
  const target = event.target as HTMLElement | null;
  const typing = target?.matches("input, textarea, select") ?? false;

  for (const cmd of commands) {
    if (!cmd.keys || !matchKeys(cmd.keys, event)) continue;
    if (typing && !cmd.whenTyping) continue;
    if (cmd.enabled && !cmd.enabled(ctx)) continue;

    event.preventDefault();
    void cmd.run(ctx, event);
    return true;
  }
  return false;
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
    keys: "Escape",
    whenTyping: true,
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
    keys: "j",
    run: (ctx) => revealSelection(ctx, ctx.feed.moveSelection(1)),
  },
  {
    id: "select-prev",
    title: "Previous post",
    keys: "k",
    run: (ctx) => revealSelection(ctx, ctx.feed.moveSelection(-1)),
  },
  {
    id: "jump-to-top",
    title: "Jump to top",
    keys: "g",
    run: (ctx) => {
      ctx.feed.selected = -1;
      ctx.scrollToTop(true);
    },
  },
  {
    id: "toggle-details",
    title: "Expand or collapse selected post",
    keys: "Enter",
    enabled: (ctx) => ctx.feed.selected >= 0,
    run: (ctx) => ctx.toggleSelectedDetails(),
  },
  {
    // `.` is the conventional "show me what arrived" key in a live feed.
    id: "show-new",
    title: "Show new posts",
    keys: ".",
    enabled: (ctx) => ctx.feed.pending.length > 0,
    run: (ctx) => ctx.showNew(),
  },
];

/**
 * A command per saved view for the first ten, bound to Cmd/Ctrl 1–9 and 0.
 * Derived from live state, so the titles and bindings track the sidebar.
 */
export function viewCommands(views: ViewWithUnread[]): Command[] {
  return views.slice(0, 10).map((view, i) => ({
    id: `open-view:${view.id}`,
    title: `Open view: ${view.name}`,
    // i = 0..8 -> 1..9; the tenth (i = 9) takes 0, matching the key row.
    keys: `mod+${(i + 1) % 10}`,
    whenTyping: true,
    run: (ctx) => ctx.openView(view),
  }));
}
