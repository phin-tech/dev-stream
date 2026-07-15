/**
 * `dev-stream init claude` — installs the hook recipes into Claude Code's settings.
 *
 * There is no plugin here, and deliberately so: hooks shell out to `dev-stream
 * hook`, which is just another client of the same HTTP API that curl uses. This
 * command only edits JSON.
 */

import { basename, dirname, join } from '@std/path';

/** Which Claude events become timeline posts, and what fires on each. */
export interface HookRecipe {
	event: string;
	/** Tool names for tool events; absent means "every occurrence". */
	matcher?: string;
}

/**
 * The default recipe set.
 *
 * Chosen for signal, not completeness. `Read`/`Grep`/`Glob` fire constantly and
 * say nothing about what changed, so they are left out — a feed of them is a feed
 * nobody reads. `PreToolUse` is skipped too: it would double every entry.
 */
export const DEFAULT_RECIPES: HookRecipe[] = [
	{ event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write|NotebookEdit|Bash|Task' },
	{ event: 'Stop' },
	{ event: 'Notification' },
	{ event: 'SessionStart' }
];

interface CommandHook {
	type: 'command';
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

interface HookMatcher {
	matcher?: string;
	hooks: CommandHook[];
	[key: string]: unknown;
}

interface Settings {
	hooks?: Record<string, HookMatcher[]>;
	[key: string]: unknown;
}

/** How we recognise our own entries, so re-running init updates instead of duplicating. */
const isOurs = (hook: CommandHook) => /\bdev-stream\b.*\bhook\b/.test(hook.command);

/**
 * The command Claude should run.
 *
 * When invoked from the compiled binary, hard-code its absolute path: hooks run
 * with whatever PATH the Claude Code process happens to have, which frequently
 * isn't the user's interactive shell PATH. When running from source (`deno run`),
 * fall back to the bare name, since baking in a path to the `deno` executable
 * would be useless.
 */
export function selfCommand(): string {
	const exe = Deno.execPath();
	return basename(exe).startsWith('dev-stream') ? `${exe} hook` : 'dev-stream hook';
}

/**
 * Merges our hooks into an existing settings object, in place of any previous
 * dev-stream entries.
 *
 * Preserves everything else — the user's own hooks, and any other settings —
 * because this file is theirs and we are a guest in it.
 */
export function mergeHooks(
	settings: Settings,
	command: string,
	recipes: HookRecipe[] = DEFAULT_RECIPES
): Settings {
	const hooks: Record<string, HookMatcher[]> = { ...(settings.hooks ?? {}) };

	for (const recipe of recipes) {
		// Drop any earlier dev-stream entry for this event first, so re-running
		// after an upgrade rewrites the command rather than stacking a second one.
		const existing = (hooks[recipe.event] ?? [])
			.map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !isOurs(h)) }))
			.filter((entry) => entry.hooks.length > 0);

		const ours: HookMatcher = {
			...(recipe.matcher ? { matcher: recipe.matcher } : {}),
			hooks: [
				{
					type: 'command',
					command,
					// A hook runs inside the user's editing loop. `dev-stream hook`
					// spools and exits when the app is down, so it never actually
					// waits — but a low timeout guarantees it can't hang Claude.
					timeout: 5
				}
			]
		};

		hooks[recipe.event] = [...existing, ours];
	}

	return { ...settings, hooks };
}

/** Where the hooks go. Project-local by default; `--global` for every project. */
export function settingsPath(global: boolean, cwd: string = Deno.cwd()): string {
	if (global) {
		const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
		if (!home) throw new Error('cannot locate home directory');
		return join(home, '.claude', 'settings.json');
	}
	return join(cwd, '.claude', 'settings.json');
}

export interface InitResult {
	path: string;
	created: boolean;
	events: string[];
}

export async function initClaude(global: boolean, cwd: string = Deno.cwd()): Promise<InitResult> {
	const path = settingsPath(global, cwd);

	let settings: Settings = {};
	let created = true;
	try {
		const raw = await Deno.readTextFile(path);
		settings = JSON.parse(raw) as Settings;
		created = false;
	} catch (err) {
		if (err instanceof SyntaxError) {
			// Never overwrite a file we failed to understand -- it's the user's
			// Claude config, and clobbering it would be unforgivable.
			throw new Error(`${path} exists but is not valid JSON; fix or move it first`);
		}
		if (!(err instanceof Deno.errors.NotFound)) throw err;
	}

	const merged = mergeHooks(settings, selfCommand());

	await Deno.mkdir(dirname(path), { recursive: true });
	await Deno.writeTextFile(path, JSON.stringify(merged, null, 2) + '\n');

	return { path, created, events: DEFAULT_RECIPES.map((r) => r.event) };
}
