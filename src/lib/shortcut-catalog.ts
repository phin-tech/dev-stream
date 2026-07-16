import type { ViewWithUnread } from "../shared/types";
import type { ShortcutDefinition } from "./shortcut-engine";

export const shortcutTitles: Record<string, string> = {
  "open-command-palette": "Command palette",
  "show-shortcuts": "Quick shortcut reference",
  "open-settings": "Settings",
  "open-timeline": "Timeline",
  "focus-search": "Focus search",
  "select-next": "Select next post",
  "select-previous": "Select previous post",
  "jump-to-top": "Jump to first post",
  "jump-to-bottom": "Jump to last post",
  "page-down": "Move half a page down",
  "page-up": "Move half a page up",
  "open-details": "Open selected post details",
  "toggle-quick-look": "Quick Look selected post",
  "toggle-read": "Mark selected post read or unread",
  "show-new": "Show newer posts",
  "toggle-sidebar": "Collapse or expand views",
  "open-primary-link": "Open selected post’s primary link",
  "toggle-archive": "Archive or restore selected post",
};

export const globalShortcutDefinitions: ShortcutDefinition[] = [
  { id: "open-command-palette", bindings: ["mod+k", ":"], scope: "global" },
  { id: "show-shortcuts", bindings: ["mod+/", "?"], scope: "global" },
  { id: "open-settings", bindings: ["mod+,"], scope: "global" },
  { id: "open-timeline", bindings: ["mod+0"], scope: "global" },
];

export const timelineShortcutDefinitions: ShortcutDefinition[] = [
  { id: "focus-search", bindings: ["mod+f", "/"], scope: "timeline" },
  { id: "select-next", bindings: ["arrowdown", "j"], scope: "timeline" },
  { id: "select-previous", bindings: ["arrowup", "k"], scope: "timeline" },
  { id: "jump-to-top", bindings: ["mod+arrowup", "g g"], scope: "timeline" },
  { id: "jump-to-bottom", bindings: ["mod+arrowdown", "shift+g"], scope: "timeline" },
  { id: "page-down", bindings: ["ctrl+d"], scope: "timeline" },
  { id: "page-up", bindings: ["ctrl+u"], scope: "timeline" },
  { id: "open-details", bindings: ["enter", "o"], scope: "timeline" },
  { id: "toggle-quick-look", bindings: ["space"], scope: "timeline" },
  { id: "toggle-read", bindings: ["m"], scope: "timeline" },
  { id: "show-new", bindings: ["."], scope: "timeline" },
  { id: "toggle-sidebar", bindings: ["mod+b", "z"], scope: "timeline" },
  { id: "open-primary-link", bindings: ["g l", "mod+enter"], scope: "timeline" },
  { id: "toggle-archive", bindings: ["a"], scope: "timeline" },
];

export function viewShortcutDefinitions(views: ViewWithUnread[]): ShortcutDefinition[] {
  return views.slice(0, 9).map((view, index) => ({
    id: `open-view:${view.id}`,
    bindings: [`mod+${index + 1}`],
    scope: "global",
  }));
}
