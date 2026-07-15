/**
 * First-run setup and client discovery: the bearer token and the bound port.
 *
 * The contract with every client (CLI, hooks, MCP, curl) is just two files in
 * `~/.dev-stream/`: `token` and `port`. That is the whole discovery protocol.
 */

import { encodeHex } from './vendored.ts';
import { ensureHome, portPath, tokenPath } from './paths.ts';

/**
 * Reads the token, creating it on first run.
 *
 * Written 0600: it is the only thing standing between a random process (or a
 * webpage doing a localhost fetch) and the user's timeline.
 */
export async function readOrCreateToken(): Promise<string> {
	await ensureHome();
	const path = tokenPath();

	try {
		const existing = (await Deno.readTextFile(path)).trim();
		if (existing) return existing;
		// Fall through on an empty/truncated file: regenerate rather than run
		// with an empty token, which would authenticate everyone.
	} catch (err) {
		if (!(err instanceof Deno.errors.NotFound)) throw err;
	}

	const token = encodeHex(crypto.getRandomValues(new Uint8Array(32)));
	await Deno.writeTextFile(path, token + '\n', { mode: 0o600 });
	// writeTextFile's `mode` only applies when it creates the file, so an
	// existing-but-empty file keeps its old permissions. Force them.
	await Deno.chmod(path, 0o600).catch(() => {}); // best-effort: no-op on Windows
	return token;
}

/**
 * Mints a fresh token, replacing the old one on disk.
 *
 * Every other client (CLI, hooks, MCP) re-reads the token file on each run, so
 * they pick the new one up automatically. Anything holding the old token in
 * memory -- a long-lived MCP server, an open SSE stream's *next* reconnect --
 * stops working, which is exactly what regenerating a credential is supposed to
 * do. The caller is responsible for telling the running server to accept it.
 */
export async function regenerateToken(): Promise<string> {
	await ensureHome();
	const token = encodeHex(crypto.getRandomValues(new Uint8Array(32)));
	await Deno.writeTextFile(tokenPath(), token + '\n', { mode: 0o600 });
	await Deno.chmod(tokenPath(), 0o600).catch(() => {}); // mode only applies on create
	return token;
}

export async function writePort(port: number): Promise<void> {
	await ensureHome();
	await Deno.writeTextFile(portPath(), `${port}\n`);
}

/** The port of a *previously running* instance, if any. May be stale. */
export async function readPort(): Promise<number | null> {
	try {
		const raw = (await Deno.readTextFile(portPath())).trim();
		const port = Number.parseInt(raw, 10);
		return Number.isInteger(port) && port > 0 ? port : null;
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) return null;
		throw err;
	}
}

/** Cleared on clean shutdown so clients don't chase a dead port. */
export async function clearPort(): Promise<void> {
	await Deno.remove(portPath()).catch(() => {});
}

/**
 * Compares two tokens without leaking their contents through timing.
 *
 * `crypto.subtle.timingSafeEqual` is not available in Deno, and a plain `===`
 * on a secret short-circuits at the first differing byte. Lengths are public.
 */
export function tokenMatches(expected: string, given: string): boolean {
	if (given.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
	}
	return diff === 0;
}
