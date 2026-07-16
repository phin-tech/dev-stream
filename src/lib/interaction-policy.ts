export type EscapeIntent =
  | "close-menu"
  | "cancel-view-naming"
  | "reset-filter"
  | "none";

export function escapeIntent(input: {
  menuOpen: boolean;
  namingView: boolean;
  hasFilter: boolean;
}): EscapeIntent {
  if (input.menuOpen) return "close-menu";
  if (input.namingView) return "cancel-view-naming";
  if (input.hasFilter) return "reset-filter";
  return "none";
}

export type QuickLookIntent = "open" | "close" | "none";

export function quickLookIntent(input: {
  hasSelection: boolean;
  quickLookOpen: boolean;
}): QuickLookIntent {
  if (input.quickLookOpen) return "close";
  return input.hasSelection ? "open" : "none";
}
