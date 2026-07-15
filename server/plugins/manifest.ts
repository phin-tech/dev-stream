/**
 * Plugin manifests.
 *
 * A plugin is a directory under `~/.dev-stream/plugins/<name>/` holding a
 * `manifest.json` and the entry module it names. The manifest is a separate
 * JSON file rather than an export of the module ON PURPOSE: the settings page
 * must be able to show what a plugin is and what access it wants before any of
 * its code has ever run. Plugin code only executes inside a worker whose
 * permissions are exactly the manifest's, and only after the user trusted it.
 *
 * Trust binds to the manifest's content hash. Any edit to manifest.json —
 * adding a host, requesting `run` — changes the hash and silently revokes
 * trust, so a plugin update cannot widen its own sandbox without the user
 * being asked again. (Code changes with an unchanged manifest do NOT re-prompt:
 * trust is a grant of *capabilities*, and whatever the code becomes, it stays
 * inside them.)
 */

import type { ConfigField } from '../sources/types.ts';
import type { PluginPermissions } from '../../src/shared/types.ts';
import { encodeHex, join, resolve } from '../vendored.ts';

/** `manifest.json`, after validation and defaulting. */
export interface PluginManifest {
	slug: string;
	label: string;
	/** Entry module, relative to the plugin directory. Must export `poll()`. */
	entry: string;
	defaultIntervalMs: number;
	configFields: ConfigField[];
	permissions: PluginPermissions;
}

/** A plugin found on disk, ready to be wrapped in a worker adapter. */
export interface InstalledPlugin {
	/** Absolute path of the plugin directory. */
	dir: string;
	/** Absolute path of the entry module. */
	entryPath: string;
	manifest: PluginManifest;
	/** sha256 of manifest.json's bytes — the thing trust is granted to. */
	hash: string;
}

/**
 * Polling more often than this would mostly hammer someone's API; a plugin
 * that asks for less gets clamped rather than rejected.
 */
const MIN_INTERVAL_MS = 15_000;
const DEFAULT_INTERVAL_MS = 120_000;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class ManifestError extends Error {}

function fail(dir: string, message: string): never {
	throw new ManifestError(`${dir}/manifest.json: ${message}`);
}

function stringArray(dir: string, value: unknown, key: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
		fail(dir, `permissions.${key} must be an array of non-empty strings`);
	}
	return (value as string[]).map((v) => v.trim());
}

/**
 * Hosts go straight into the worker's net allowlist, so reject anything that
 * isn't a bare host[:port] — a scheme or a path here means the author
 * misunderstood the field, and silently "allowing" it would allow nothing.
 */
function hostArray(dir: string, value: unknown, key: string): string[] {
	const hosts = stringArray(dir, value, key);
	for (const host of hosts) {
		if (host.includes('/') || host.includes('@') || /^[a-z]+:/i.test(host)) {
			fail(dir, `permissions.${key}: "${host}" must be a bare host, like "api.github.com"`);
		}
	}
	return hosts;
}

function parsePermissions(dir: string, raw: unknown): PluginPermissions {
	if (raw === undefined) return {};
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		fail(dir, 'permissions must be an object');
	}
	const p = raw as Record<string, unknown>;

	const known = ['net', 'net_from_config', 'read', 'write', 'run', 'env'];
	// An unknown permission key is far more likely a typo ("nett") than an
	// extension — and a typo here would silently grant *less* than the plugin
	// needs while showing the user *less* than it wanted. Loud beats lenient.
	for (const key of Object.keys(p)) {
		if (!known.includes(key)) fail(dir, `unknown permission "${key}"`);
	}

	return {
		net: hostArray(dir, p.net, 'net'),
		net_from_config: stringArray(dir, p.net_from_config, 'net_from_config'),
		read: stringArray(dir, p.read, 'read'),
		write: stringArray(dir, p.write, 'write'),
		run: stringArray(dir, p.run, 'run'),
		env: stringArray(dir, p.env, 'env')
	};
}

function parseConfigFields(dir: string, raw: unknown): ConfigField[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) fail(dir, 'configFields must be an array');

	return raw.map((item, i) => {
		if (typeof item !== 'object' || item === null) fail(dir, `configFields[${i}] must be an object`);
		const f = item as Record<string, unknown>;
		if (typeof f.key !== 'string' || !f.key.trim()) fail(dir, `configFields[${i}].key is required`);
		if (typeof f.label !== 'string' || !f.label.trim()) {
			fail(dir, `configFields[${i}].label is required`);
		}
		const field: ConfigField = { key: f.key, label: f.label };
		if (f.secret !== undefined) field.secret = Boolean(f.secret);
		if (typeof f.placeholder === 'string') field.placeholder = f.placeholder;
		if (typeof f.help === 'string') field.help = f.help;
		return field;
	});
}

/** Validates raw manifest JSON. Throws `ManifestError` with a path-prefixed message. */
export function parseManifest(dir: string, rawJson: string): PluginManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(rawJson);
	} catch (err) {
		fail(dir, `not valid JSON: ${err instanceof Error ? err.message : err}`);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		fail(dir, 'must be a JSON object');
	}
	const m = raw as Record<string, unknown>;

	if (typeof m.slug !== 'string' || !SLUG_PATTERN.test(m.slug)) {
		fail(dir, 'slug is required: lowercase letters, digits, "-", "_"');
	}
	if (typeof m.label !== 'string' || !m.label.trim()) fail(dir, 'label is required');

	if (typeof m.entry !== 'string' || !m.entry.trim()) fail(dir, 'entry is required');
	// The entry must live inside the plugin's own directory: it is what the
	// sandbox is granted read access to, and `../../anything` would drag that
	// grant outside the plugin.
	const entryPath = resolve(join(dir, m.entry));
	if (!entryPath.startsWith(resolve(dir) + '/') && entryPath !== resolve(dir)) {
		fail(dir, `entry "${m.entry}" escapes the plugin directory`);
	}

	let interval = DEFAULT_INTERVAL_MS;
	if (m.defaultIntervalMs !== undefined) {
		if (typeof m.defaultIntervalMs !== 'number' || !Number.isFinite(m.defaultIntervalMs)) {
			fail(dir, 'defaultIntervalMs must be a number');
		}
		interval = Math.max(MIN_INTERVAL_MS, Math.floor(m.defaultIntervalMs));
	}

	return {
		slug: m.slug,
		label: m.label,
		entry: m.entry,
		defaultIntervalMs: interval,
		configFields: parseConfigFields(dir, m.configFields),
		permissions: parsePermissions(dir, m.permissions)
	};
}

/** sha256 of the manifest file's exact bytes. What the trust grant binds to. */
export async function hashManifest(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return encodeHex(new Uint8Array(digest));
}

/** Loads and validates one plugin directory. */
export async function loadPlugin(dir: string): Promise<InstalledPlugin> {
	const manifestPath = join(dir, 'manifest.json');
	const bytes = await Deno.readFile(manifestPath);
	const manifest = parseManifest(dir, new TextDecoder().decode(bytes));

	const entryPath = resolve(join(dir, manifest.entry));
	try {
		await Deno.stat(entryPath);
	} catch {
		fail(dir, `entry "${manifest.entry}" does not exist`);
	}

	return { dir: resolve(dir), entryPath, manifest, hash: await hashManifest(bytes) };
}

/**
 * Scans the plugins directory. A missing directory is the normal case (no
 * plugins installed); a broken plugin is skipped with a complaint rather than
 * taking every other plugin down with it.
 */
export async function discoverPlugins(root: string): Promise<InstalledPlugin[]> {
	let entries: Deno.DirEntry[] = [];
	try {
		entries = await Array.fromAsync(Deno.readDir(root));
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) return [];
		throw err;
	}

	const plugins: InstalledPlugin[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory) continue;
		try {
			plugins.push(await loadPlugin(join(root, entry.name)));
		} catch (err) {
			if (err instanceof Deno.errors.NotFound) continue; // no manifest.json: not a plugin
			console.error(`[plugins] skipping ${entry.name}: ${err instanceof Error ? err.message : err}`);
		}
	}
	return plugins;
}
