export type ActivityArrivalMode = "none" | "inline" | "indicator";

export function activityArrivalMode({
  pendingCount,
  atTop,
}: {
  pendingCount: number;
  atTop: boolean;
}): ActivityArrivalMode {
  if (pendingCount === 0) return "none";
  return atTop ? "inline" : "indicator";
}

export function needsProgressiveDisclosure(body: string): boolean {
  const meaningfulLines =
    body.split("\n").filter((line) => line.trim().length > 0).length;
  return body.trim().length > 280 || meaningfulLines > 3;
}

export function compactBodyPreview(body: string): string {
  return body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+] |#{1,6}\s+|>\s?)/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolvePostPreview(
  { summary, body }: { summary?: string; body?: string },
): string {
  const explicit = summary?.trim();
  return explicit || (body ? compactBodyPreview(body) : "");
}

export function selectionRevealMode(index: number): "top" | "nearest" {
  return index === 0 ? "top" : "nearest";
}

export type SidebarOverride = "expanded" | "collapsed" | null;

export function resolveSidebarCollapsed({
  narrow,
  override,
}: {
  narrow: boolean;
  override: SidebarOverride;
}): boolean {
  if (override) return override === "collapsed";
  return narrow;
}
