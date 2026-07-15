/**
 * Every on-disk location dev-stream owns, in one place.
 *
 * `DEV_STREAM_HOME` overrides the root. Tests set it to a temp dir; without it
 * they would scribble on the developer's real timeline.
 */

import { join } from './vendored.ts';

export const APP_VERSION = '0.1.0';

/** The port we *prefer*. We fall back to an OS-assigned one if it's taken. */
export const DEFAULT_PORT = 4517;

/**
 * Re-posting the same `dedupe_key` within this window updates the existing post
 * rather than appending a new one. Sized for the case it exists to solve: a hook
 * or poller firing repeatedly about one long-running thing (a build, a PR) and
 * wanting the timeline to show one entry that evolves.
 */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export function home(): string {
	const override = Deno.env.get('DEV_STREAM_HOME');
	if (override) return override;

	const base = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
	if (!base) throw new Error('cannot locate home directory: set HOME or DEV_STREAM_HOME');
	return join(base, '.dev-stream');
}

/**
 * Is this the user's real timeline, or a relocated one (a test, `task dev`)?
 *
 * This decides whether we may take the well-known port. A relocated home is a
 * DIFFERENT timeline with a different token and database, so it must never squat
 * 4517: it would answer `/api/health` as a perfectly valid dev-stream, the CLI
 * would believe it, and then every post would 401 against a token from the wrong
 * timeline. (Which is exactly what happened.)
 */
export const isDefaultHome = (): boolean => !Deno.env.get('DEV_STREAM_HOME');

export const dbPath = () => join(home(), 'stream.db');
/** Bearer token. Written 0600 on first run. */
export const tokenPath = () => join(home(), 'token');
/** The port actually bound, so clients never have to hardcode one. */
export const portPath = () => join(home(), 'port');
/** JSON-lines dropped by clients while the app was down; drained on startup. */
export const spoolDir = () => join(home(), 'spool');

/** Creates the home + spool dirs if absent. Safe to call repeatedly. */
export async function ensureHome(): Promise<void> {
	await Deno.mkdir(spoolDir(), { recursive: true }); // recursive => also creates home()
}
