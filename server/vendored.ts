/**
 * Local replacements for the handful of `@std` helpers the desktop graph needs.
 *
 * THIS FILE EXISTS TO WORK AROUND A `deno desktop` BUG, and for no other reason.
 *
 * On Deno 2.9.2, `win.bind()` silently fails to register whenever the desktop
 * entrypoint's module graph contains ANY remote module (a `jsr:` or `npm:`
 * specifier). Every call from the page then rejects with
 * "No callback bound for: <name>" — the binding is registered, the window is the
 * right one, and the dispatcher simply never finds it. Merely *importing*
 * `@std/path` is enough; the symbol doesn't even have to be called.
 *
 * Reduced to the upstream repro (denoland/deno#35647, whose fix in #35654 is
 * listed in the 2.9.2 changelog but is demonstrably not effective here):
 *
 *   entrypoint with a used jsr import  -> bindings BROKEN
 *   entrypoint with an unused jsr import -> bindings BROKEN
 *   entrypoint with no remote imports  -> bindings WORK
 *
 * `"vendor": true` does not help: the graph still records the specifiers as
 * remote.
 *
 * So `main.ts` and everything reachable from it must import only local files.
 * The CLI and the MCP server are separate binaries and are NOT desktop apps, so
 * they keep using `@std` normally — this constraint applies to the desktop graph
 * alone.
 *
 * DELETE THIS FILE and go back to `@std` the moment `deno desktop` fixes the bug.
 * Each function below is a deliberately small stand-in for a battle-tested std
 * one, and that is a trade we are making under protest.
 */

const WINDOWS = Deno.build.os === 'windows';
const SEP = WINDOWS ? '\\' : '/';

/** Collapses separators and resolves `.` / `..` segments. */
function normalize(path: string): string {
	const isAbsolute = path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path);
	const parts = path.split(/[/\\]+/);

	// A drive letter or leading empty segment must survive the walk below.
	const prefix = /^[a-zA-Z]:/.test(path) ? parts.shift()! : '';

	const out: string[] = [];
	for (const part of parts) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (out.length && out.at(-1) !== '..') out.pop();
			else if (!isAbsolute) out.push('..');
			continue;
		}
		out.push(part);
	}

	const body = out.join(SEP);
	if (prefix) return `${prefix}${SEP}${body}`;
	if (isAbsolute) return SEP + body;
	return body || '.';
}

/** `join('/a', 'b', 'c.txt')` -> `/a/b/c.txt` */
export function join(...parts: string[]): string {
	const joined = parts.filter((p) => p.length > 0).join(SEP);
	return joined ? normalize(joined) : '.';
}

/** The directory containing `path`. */
export function dirname(path: string): string {
	const normalized = normalize(path);
	const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	if (index < 0) return '.';
	if (index === 0) return SEP; // "/foo" -> "/"
	return normalized.slice(0, index);
}

/** The final segment of `path`. */
export function basename(path: string): string {
	const normalized = normalize(path);
	const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	return index < 0 ? normalized : normalized.slice(index + 1);
}

/** Makes `path` absolute, against the current working directory. */
export function resolve(path: string): string {
	const isAbsolute = path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path);
	return isAbsolute ? normalize(path) : normalize(`${Deno.cwd()}${SEP}${path}`);
}

/** `file:///a/b.txt` -> `/a/b.txt` */
export function fromFileUrl(url: string | URL): string {
	const parsed = typeof url === 'string' ? new URL(url) : url;
	if (parsed.protocol !== 'file:') throw new TypeError('must be a file URL');

	const path = decodeURIComponent(parsed.pathname);
	// Windows file URLs look like file:///C:/x -> strip the leading slash.
	if (WINDOWS && /^\/[a-zA-Z]:/.test(path)) return path.slice(1).replace(/\//g, '\\');
	return path;
}

/** `/a/b.txt` -> `file:///a/b.txt`. Inverse of `fromFileUrl`. */
export function toFileUrl(path: string): URL {
	const absolute = resolve(path);
	const url = new URL('file:///');
	// Encode via pathname assignment so spaces and friends survive the trip.
	url.pathname = WINDOWS ? '/' + absolute.replace(/\\/g, '/') : absolute;
	return url;
}

export function encodeHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- ULID -------------------------------------------------------------------

/** Crockford's base32: no I, L, O or U, so it can't accidentally spell anything. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
/** The random half of the last id, as base32 digit values, for monotonic bumping. */
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
	let out = '';
	let now = ms;
	for (let i = TIME_LEN - 1; i >= 0; i--) {
		out = CROCKFORD[now % 32] + out;
		now = Math.floor(now / 32);
	}
	return out;
}

function randomDigits(): number[] {
	const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LEN));
	// One digit per byte (mod 32). Wasteful of entropy but still 80 bits, and the
	// randomness only has to break ties inside a single millisecond.
	return Array.from(bytes, (b) => b % 32);
}

/** Adds one to the random half, carrying leftwards. */
function increment(digits: number[]): number[] {
	const out = [...digits];
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i] < 31) {
			out[i]++;
			return out;
		}
		out[i] = 0; // carry
	}
	// Overflowed all 80 bits inside one millisecond. Not reachable in practice.
	throw new Error('ulid: random component overflowed');
}

/**
 * A ULID that is strictly increasing, even within a single millisecond.
 *
 * Monotonicity is load-bearing, not a nicety: the feed orders by `(ts, id)`, so
 * the id breaks ties whenever two posts share a timestamp — routine for a burst
 * of hook events. A random suffix would order those posts arbitrarily.
 */
export function monotonicUlid(): string {
	const now = Date.now();

	if (now <= lastTime) {
		// Same millisecond (or the clock went backwards): keep the previous time
		// component and bump the random half, so the id still increases.
		lastRandom = increment(lastRandom);
	} else {
		lastTime = now;
		lastRandom = randomDigits();
	}

	const time = encodeTime(lastTime);
	const random = lastRandom.map((d) => CROCKFORD[d]).join('');
	return time + random;
}
