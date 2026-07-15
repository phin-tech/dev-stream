/**
 * Wraps an installed plugin as a `SourceWorker`, so the registry, runner,
 * store and settings page treat every installed source consistently.
 *
 * Plugin code polls inside a one-shot worker whose permissions are exactly its
 * manifest's. The isolate cannot touch the database, the filesystem (beyond
 * its own directory), or any host it didn't declare — so the worst a plugin
 * holding the user's token can do is talk to the API that token belongs to.
 *
 * Honest limits: this is a permissions sandbox, not a hostile-code jail. The
 * isolate shares the process, so there is no per-plugin memory quota, and a
 * `run` grant hands out UNSANDBOXED subprocesses (which is why the settings
 * page shouts about it). Runaway CPU is handled the blunt way: a deadline and
 * `worker.terminate()`.
 */

import type { PollContext, PollResult, SourceWorker } from '../sources/types.ts';
import type { PostInput } from '../../src/shared/types.ts';
import { join, toFileUrl } from '../vendored.ts';
import type { InstalledPlugin } from './manifest.ts';

/**
 * Generous because a well-behaved poll can legitimately chase pagination or
 * per-item detail fetches. It exists to stop `while (true) {}`, not to police
 * slow APIs — the runner's `inFlight` set already prevents overlap.
 */
const POLL_TIMEOUT_MS = 120_000;

interface AdapterOptions {
	/** Overridable so the timeout path is testable without a two-minute test. */
	pollTimeoutMs?: number;
}

/** Resolves a manifest path against the plugin dir, leaving absolute ones alone. */
const resolvePath = (dir: string, path: string): string =>
	path.startsWith('/') || /^[a-zA-Z]:/.test(path) ? path : join(dir, path);

/**
 * Proves the runtime can construct permission-scoped workers AT ALL.
 *
 * On a runtime missing `--unstable-worker-options`, touching
 * `Worker.deno.permissions` ABORTS the process — not a catchable throw, not
 * even from inside another worker (verified on Deno 2.9.2). There is no
 * feature-detection API either. So the one thing we can control is *when* it
 * happens: at startup, right after a log line naming the fix, before the API
 * has bound a port — rather than mid-request the first time a plugin polls,
 * where it presents as the whole app vanishing under a settings click.
 *
 * Call this before registering any plugin worker. If it returns, every later
 * scoped spawn is safe.
 */
export function assertSandboxAvailable(): void {
	console.log(
		'[plugins] verifying the worker sandbox — if the process exits on the next line, ' +
			'this runtime is missing --unstable-worker-options (the deno.json tasks all pass it)'
	);
	const probe = new Worker(import.meta.resolve('./plugin_host.ts'), {
		type: 'module',
		name: 'plugin:sandbox-probe',
		deno: { permissions: 'none' }
	});
	probe.terminate();
	console.log('[plugins] worker sandbox available');
}

export function createPluginWorker(
	plugin: InstalledPlugin,
	options: AdapterOptions = {}
): SourceWorker {
	const { manifest } = plugin;
	const timeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;

	return {
		slug: manifest.slug,
		label: manifest.label,
		defaultIntervalMs: manifest.defaultIntervalMs,
		configFields: manifest.configFields,
		origin: 'plugin',
		permissions: manifest.permissions,
		manifestHash: plugin.hash,

		poll(ctx: PollContext): Promise<PollResult> {
			return pollInWorker(plugin, ctx, timeoutMs);
		}
	};
}

function buildNetAllowlist(plugin: InstalledPlugin, config: Record<string, unknown>): string[] {
	const hosts = new Set(plugin.manifest.permissions.net ?? []);

	// Self-hosted APIs: the manifest names the config KEY, the user's config
	// holds the URL, and only its host joins the allowlist. The plugin never
	// gets to widen its own net access — the user typed the value being trusted.
	for (const key of plugin.manifest.permissions.net_from_config ?? []) {
		const value = config[key];
		if (typeof value !== 'string' || !value.trim()) continue;
		try {
			hosts.add(new URL(value).host);
		} catch {
			// Not a URL; nothing to allow. The plugin's own fetch will fail loudly.
		}
	}
	return [...hosts];
}

function pollInWorker(
	plugin: InstalledPlugin,
	ctx: PollContext,
	timeoutMs: number
): Promise<PollResult> {
	const { manifest } = plugin;
	const net = buildNetAllowlist(plugin, ctx.config);
	const perms = manifest.permissions;

	const worker = new Worker(import.meta.resolve('./plugin_host.ts'), {
		type: 'module',
		name: `plugin:${manifest.slug}`,
		deno: {
			// Every key is spelled out because an omitted one INHERITS the host's
			// permission, and the host runs with broad --allow-net/read/write.
			permissions: {
				env: perms.env?.length ? [...perms.env] : false,
				ffi: false,
				// No remote code at runtime: a plugin is exactly the files on disk
				// that the user trusted, not whatever a CDN serves tomorrow.
				import: false,
				net: net.length ? net : false,
				// Its own directory is always readable — that is what lets the shim
				// import the entry module.
				read: [plugin.dir, ...(perms.read ?? []).map((p) => resolvePath(plugin.dir, p))],
				run: perms.run?.length ? [...perms.run] : false,
				sys: false,
				write: perms.write?.length
					? perms.write.map((p) => resolvePath(plugin.dir, p))
					: false
			}
		}
	});

	return new Promise<PollResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`poll exceeded ${Math.round(timeoutMs / 1000)}s and was terminated`));
		}, timeoutMs);

		worker.onmessage = (event) => {
			clearTimeout(timer);
			const data = event.data as
				| { ok: true; posts: unknown[]; cursor: string | null }
				| { ok: false; message: string };

			if (!data.ok) {
				reject(new Error(data.message));
				return;
			}

			// Force the slug: a plugin must not be able to post as "github" and
			// pollute another source's timeline, deliberately or by copy-paste.
			const posts = data.posts.map((p) => ({
				...(p as PostInput),
				source: manifest.slug
			}));
			resolve({ posts, cursor: data.cursor });
		};

		worker.onerror = (event) => {
			clearTimeout(timer);
			event.preventDefault(); // ours to report; don't also crash the host
			reject(new Error(event.message || 'plugin worker crashed'));
		};

		worker.postMessage({
			entry: toFileUrl(plugin.entryPath).href,
			config: ctx.config,
			cursor: ctx.cursor
		});
	}).finally(() => worker.terminate());
}
