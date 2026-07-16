export type ShortcutScope = "global" | "timeline" | "settings" | "menu" | "dialog";
export type ShortcutPlatform = "mac" | "other";

export interface ShortcutDefinition {
  id: string;
  bindings: string[];
  scope: ShortcutScope;
  allowInText?: boolean;
}

export interface ShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export interface ShortcutState {
  pending: string[];
  startedAt: number | null;
}

export interface ShortcutEnvironment {
  now: number;
  platform: ShortcutPlatform;
  /** Ordered from most specific to least specific. */
  activeScopes: ShortcutScope[];
  textEntry: boolean;
}

export interface ShortcutResult {
  commandId: string | null;
  handled: boolean;
  state: ShortcutState;
}

export interface BindingConflict {
  binding: string;
  scope: ShortcutScope;
  commandIds: string[];
}

export const initialShortcutState: ShortcutState = {
  pending: [],
  startedAt: null,
};

const SEQUENCE_TIMEOUT_MS = 700;

function normalizeKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  if (normalized === "return") return "enter";
  if (normalized === " ") return "space";
  return normalized;
}

function normalizeChord(chord: string): string {
  const parts = chord.trim().toLowerCase().split("+");
  const key = normalizeKey(parts.pop() ?? "");
  const modifiers = new Set(parts.map((part) => part === "cmd" ? "mod" : part));
  const ordered = ["mod", "ctrl", "alt", "shift"].filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join("+");
}

function normalizeBinding(binding: string): string {
  return binding.trim().split(/\s+/).map(normalizeChord).join(" ");
}

function inputChord(input: ShortcutInput, platform: ShortcutPlatform): string {
  const modifiers: string[] = [];
  if (platform === "mac" ? input.metaKey : input.ctrlKey) modifiers.push("mod");
  if (input.ctrlKey && platform === "mac") modifiers.push("ctrl");
  if (input.altKey) modifiers.push("alt");
  // Printable punctuation already carries Shift in `event.key` ("?", ":").
  // Keep Shift explicit for letters so Vim's `G` remains distinct from `g`.
  if (input.shiftKey && /^[a-z]$/i.test(input.key)) modifiers.push("shift");
  modifiers.push(normalizeKey(input.key));
  return modifiers.join("+");
}

function canRunInText(definition: ShortcutDefinition, chord: string): boolean {
  return definition.allowInText === true || chord.startsWith("mod+");
}

function resetResult(): ShortcutResult {
  return { commandId: null, handled: false, state: initialShortcutState };
}

export function advanceShortcut(
  definitions: ShortcutDefinition[],
  state: ShortcutState,
  input: ShortcutInput,
  environment: ShortcutEnvironment,
): ShortcutResult {
  if (input.isComposing) return resetResult();

  const chord = inputChord(input, environment.platform);
  const expired = state.startedAt !== null && environment.now - state.startedAt > SEQUENCE_TIMEOUT_MS;
  const pending = expired ? [] : state.pending;
  const candidate = [...pending, chord];

  for (const scope of environment.activeScopes) {
    const scoped = definitions.filter((definition) => definition.scope === scope);
    let waitsForSequence = false;

    for (const definition of scoped) {
      if (environment.textEntry && !canRunInText(definition, chord)) continue;

      for (const rawBinding of definition.bindings) {
        const binding = normalizeBinding(rawBinding).split(" ");
        const isPrefix = candidate.every((part, index) => binding[index] === part);
        if (!isPrefix) continue;
        if (binding.length === candidate.length) {
          return { commandId: definition.id, handled: true, state: initialShortcutState };
        }
        waitsForSequence = true;
      }
    }

    if (waitsForSequence) {
      return {
        commandId: null,
        handled: true,
        state: {
          pending: candidate,
          startedAt: pending.length === 0 ? environment.now : state.startedAt,
        },
      };
    }
  }

  return resetResult();
}

export function bindingConflicts(definitions: ShortcutDefinition[]): BindingConflict[] {
  const claims = new Map<string, string[]>();
  for (const definition of definitions) {
    for (const binding of definition.bindings) {
      const normalized = normalizeBinding(binding);
      const key = `${definition.scope}\u0000${normalized}`;
      const commandIds = claims.get(key) ?? [];
      commandIds.push(definition.id);
      claims.set(key, commandIds);
    }
  }

  return [...claims.entries()]
    .filter(([, commandIds]) => commandIds.length > 1)
    .map(([claim, commandIds]) => {
      const [scope, binding] = claim.split("\u0000") as [ShortcutScope, string];
      return { binding, scope, commandIds };
    });
}

function displayKey(key: string): string {
  const labels: Record<string, string> = {
    escape: "Esc",
    enter: "Return",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    space: "Space",
  };
  return labels[key] ?? key.toUpperCase();
}

function formatChord(chord: string, platform: ShortcutPlatform): string {
  const parts = normalizeChord(chord).split("+");
  const key = parts.pop() ?? "";
  const labels: Record<string, string> = platform === "mac"
    ? { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl+", ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+" };
  return parts.map((modifier) => labels[modifier]).join("") + displayKey(key);
}

export function formatShortcut(binding: string, platform: ShortcutPlatform): string {
  return binding.trim().split(/\s+/).map((chord) => formatChord(chord, platform)).join(" ");
}
