/**
 * TEMPORARY startup tracer for the `win.bind()` "No callback bound" bug.
 *
 * Writes to `~/.dev-stream/startup.log` (or $DEV_STREAM_HOME) so we capture the
 * trace no matter how the app is launched — Finder/launchd sends stdout to
 * /dev/null, so console.log is useless for a double-clicked .app.
 *
 * Zero imports on purpose: this module must be safe to EVALUATE before the binds
 * (a `jsr:`/`node:sqlite` import here would itself trigger the very bug we are
 * chasing). Every call is best-effort and swallows its own errors so diagnostics
 * can never break startup.
 *
 * Delete this file (and its call sites) once the bug is understood.
 */

function logPath(): string {
	const override = Deno.env.get('DEV_STREAM_HOME');
	const base = override ?? `${Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.'}/.dev-stream`;
	return `${base}/startup.log`;
}

let dir = '';
function ensureDir(): void {
	if (dir) return;
	const override = Deno.env.get('DEV_STREAM_HOME');
	dir = override ?? `${Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.'}/.dev-stream`;
	try {
		Deno.mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
}

/** Truncate the log at the very start of a run. Call once from main.ts. */
export function diagReset(): void {
	try {
		ensureDir();
		Deno.writeTextFileSync(
			logPath(),
			`==== dev-stream startup ${new Date().toISOString()} pid=${Deno.pid} ====\n`
		);
	} catch {
		/* ignore */
	}
}

/** Append one timestamped line. `+Nms` is elapsed process time (monotonic). */
export function diag(msg: string): void {
	try {
		ensureDir();
		const line = `${new Date().toISOString()}  +${performance.now().toFixed(1)}ms  ${msg}\n`;
		Deno.writeTextFileSync(logPath(), line, { append: true });
	} catch {
		/* ignore */
	}
}
