import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { openDb } from '../db.ts';
import { Broadcaster } from '../events.ts';
import { ValidationError } from '../posts.ts';
import { startSourceRunner } from '../sources/runner.ts';
import { clearPluginWorkers, findWorker, registerPluginWorkers } from '../sources/registry.ts';
import { getSourceState, saveSourceConfig, setSourceTrust, describeSource, isTrusted } from '../sources/store.ts';
import { createPluginWorker } from './adapter.ts';
import { discoverPlugins, loadPlugin, ManifestError, parseManifest } from './manifest.ts';

/**
 * Writes a plugin directory the way a user would install one: a manifest.json
 * and an entry module. Returns the plugin dir.
 */
async function installPlugin(
	root: string,
	name: string,
	manifest: unknown,
	mod: string
): Promise<string> {
	const dir = `${root}/${name}`;
	await Deno.mkdir(dir, { recursive: true });
	await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, '\t'));
	await Deno.writeTextFile(`${dir}/mod.ts`, mod);
	return dir;
}

const MANIFEST = {
	slug: 'testplug',
	label: 'Test Plugin',
	entry: 'mod.ts',
	permissions: {}
};

/** A well-behaved plugin: no I/O at all, posts built from config. */
const WELL_BEHAVED = `
export function poll({ config, cursor }) {
	return {
		posts: [{
			source: 'github', // lies about its source; the adapter must correct it
			kind: 'event',
			title: 'hello from ' + (config.who ?? 'plugin'),
			ts: '2026-07-15T10:00:00Z',
			tags: ['test']
		}],
		cursor: '2026-07-15T10:00:00Z'
	};
}
`;

// --- manifest ----------------------------------------------------------------

Deno.test('manifest: defaults are filled and the interval is clamped', () => {
	const m = parseManifest('/p/x', JSON.stringify({ ...MANIFEST, defaultIntervalMs: 1 }));
	assertEquals(m.defaultIntervalMs, 15_000); // clamped, not rejected
	assertEquals(m.configFields, []);
	assertEquals(m.permissions.net, []);
});

Deno.test('manifest: bad shapes are rejected loudly', () => {
	const bad = (patch: Record<string, unknown>) =>
		assertThrows(
			() => parseManifest('/p/x', JSON.stringify({ ...MANIFEST, ...patch })),
			ManifestError
		);

	bad({ slug: 'Not A Slug' });
	bad({ entry: '../../outside.ts' }); // must not drag the read grant out of the dir
	bad({ permissions: { nett: ['typo.example.com'] } }); // unknown key = probably a typo
	bad({ permissions: { net: ['https://api.github.com'] } }); // scheme: not a bare host
	bad({ permissions: { net: ['api.github.com/path'] } });
});

Deno.test('discovery: missing root is fine, broken plugins are skipped', async () => {
	const root = await Deno.makeTempDir();
	try {
		assertEquals(await discoverPlugins(`${root}/nope`), []);

		await installPlugin(root, 'good', MANIFEST, WELL_BEHAVED);
		await installPlugin(root, 'broken', { slug: 'BAD SLUG' }, '');
		await Deno.mkdir(`${root}/not-a-plugin`); // no manifest.json: silently ignored

		const found = await discoverPlugins(root);
		assertEquals(found.map((p) => p.manifest.slug), ['testplug']);
		assert(found[0].hash.length === 64, 'sha256 hex');
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('registry: an installed plugin can provide the github slug', async () => {
	const root = await Deno.makeTempDir();
	try {
		const dir = await installPlugin(root, 'imposter', { ...MANIFEST, slug: 'github' }, WELL_BEHAVED);
		const plugin = await loadPlugin(dir);
		registerPluginWorkers([createPluginWorker(plugin)]);

		assertEquals(findWorker('github')?.origin, 'plugin');
	} finally {
		clearPluginWorkers();
		await Deno.remove(root, { recursive: true });
	}
});

// --- trust ---------------------------------------------------------------------

Deno.test('trust: gate, grant, manifest-change revocation, explicit revocation', async () => {
	const root = await Deno.makeTempDir();
	const db = openDb(':memory:');
	try {
		const dir = await installPlugin(root, 'tp', MANIFEST, WELL_BEHAVED);
		const worker = createPluginWorker(await loadPlugin(dir));
		registerPluginWorkers([worker]);

		// Untrusted: config may be saved, enabling must be refused.
		saveSourceConfig(db, 'testplug', { config: { who: 'sam' } });
		assertThrows(
			() => saveSourceConfig(db, 'testplug', { enabled: true, config: {} }),
			ValidationError,
			'trusted'
		);

		// Grant, then enabling works.
		const status = setSourceTrust(db, 'testplug', { trusted: true });
		assertEquals(status.trusted, true);
		saveSourceConfig(db, 'testplug', { enabled: true, config: {} });

		// The user edits manifest.json (say, adds a host): the stored grant no
		// longer matches, so trust silently evaporates.
		await Deno.writeTextFile(
			`${dir}/manifest.json`,
			JSON.stringify({ ...MANIFEST, permissions: { net: ['api.github.com'] } })
		);
		const updated = createPluginWorker(await loadPlugin(dir));
		assert(worker.manifestHash !== updated.manifestHash);
		assertEquals(isTrusted(updated, getSourceState(db, 'testplug')), false);
		assertEquals(describeSource(db, updated).trusted, false);

		// Explicit revocation also switches the source off.
		setSourceTrust(db, 'testplug', { trusted: true });
		const revoked = setSourceTrust(db, 'testplug', { trusted: false });
		assertEquals(revoked.trusted, false);
		assertEquals(revoked.enabled, false);
	} finally {
		clearPluginWorkers();
		db.close();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('runner: an untrusted plugin is never polled, even via pollNow', async () => {
	const root = await Deno.makeTempDir();
	const db = openDb(':memory:');
	try {
		const dir = await installPlugin(root, 'tp', MANIFEST, WELL_BEHAVED);
		registerPluginWorkers([createPluginWorker(await loadPlugin(dir))]);

		const runner = startSourceRunner(db, new Broadcaster());
		try {
			const result = await runner.pollNow('testplug');
			assertEquals(result.posts, 0);
			assert(result.error?.includes('not trusted'));
		} finally {
			runner.stop();
		}
	} finally {
		clearPluginWorkers();
		db.close();
		await Deno.remove(root, { recursive: true });
	}
});

// --- the sandbox ---------------------------------------------------------------

Deno.test('adapter: a poll round-trips through the worker, slug forced', async () => {
	const root = await Deno.makeTempDir();
	try {
		const dir = await installPlugin(root, 'tp', MANIFEST, WELL_BEHAVED);
		const worker = createPluginWorker(await loadPlugin(dir));

		const result = await worker.poll({ config: { who: 'sam' }, cursor: null });

		assertEquals(result.posts.length, 1);
		assertEquals(result.posts[0].title, 'hello from sam');
		// It claimed to be github; the adapter must not let it pollute another
		// source's timeline.
		assertEquals(result.posts[0].source, 'testplug');
		assertEquals(result.cursor, '2026-07-15T10:00:00Z');
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('sandbox: net outside the allowlist is refused', async () => {
	const root = await Deno.makeTempDir();
	const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, () =>
		Response.json([{ never: 'reached' }])
	);
	try {
		const dir = await installPlugin(
			root,
			'tp',
			MANIFEST, // note: asks for NO net access at all
			`export async function poll({ config }) {
				await fetch(config.api_base);
				return { posts: [], cursor: null };
			}`
		);
		const worker = createPluginWorker(await loadPlugin(dir));

		const err = await assertRejects(
			() => worker.poll({ config: { api_base: `http://127.0.0.1:${server.addr.port}/` }, cursor: null }),
			Error
		);
		// Deno's NotCapable message names the missing permission.
		assert(/net/i.test(err.message), `expected a net permission error, got: ${err.message}`);
	} finally {
		await server.shutdown();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('sandbox: net_from_config admits exactly the configured host', async () => {
	const root = await Deno.makeTempDir();
	const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, () =>
		Response.json({ ok: true })
	);
	try {
		const dir = await installPlugin(
			root,
			'tp',
			{ ...MANIFEST, permissions: { net_from_config: ['api_base'] } },
			`export async function poll({ config, cursor }) {
				const res = await fetch(config.api_base);
				const body = await res.json();
				return {
					posts: [{ source: 'tp', kind: 'event', title: 'fetched ok=' + body.ok, ts: '2026-07-15T10:00:00Z' }],
					cursor
				};
			}`
		);
		const worker = createPluginWorker(await loadPlugin(dir));

		const result = await worker.poll({
			config: { api_base: `http://127.0.0.1:${server.addr.port}/` },
			cursor: '2026-07-15T09:00:00Z'
		});
		assertEquals(result.posts[0].title, 'fetched ok=true');
		assertEquals(result.cursor, '2026-07-15T09:00:00Z');
	} finally {
		await server.shutdown();
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('sandbox: reads outside the plugin dir are refused, its own dir is fine', async () => {
	const root = await Deno.makeTempDir();
	try {
		const dir = await installPlugin(
			root,
			'tp',
			MANIFEST,
			`export async function poll() {
				// Its own directory: fine (that's how it was imported at all).
				await Deno.readTextFile(new URL('./manifest.json', import.meta.url));
				// Anything else: NotCapable.
				let denied = false;
				try { await Deno.readTextFile('${root}/../secret'); } catch (e) { denied = e.name === 'NotCapable'; }
				if (!denied) throw new Error('the sandbox let a read escape the plugin dir');
				return { posts: [], cursor: null };
			}`
		);
		const worker = createPluginWorker(await loadPlugin(dir));
		const result = await worker.poll({ config: {}, cursor: null });
		assertEquals(result.posts, []);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('sandbox: a plugin that never returns is terminated at the deadline', async () => {
	const root = await Deno.makeTempDir();
	try {
		const dir = await installPlugin(
			root,
			'tp',
			MANIFEST,
			`export function poll() { return new Promise(() => {}); }`
		);
		const worker = createPluginWorker(await loadPlugin(dir), { pollTimeoutMs: 300 });

		const err = await assertRejects(() => worker.poll({ config: {}, cursor: null }), Error);
		assert(err.message.includes('terminated'), err.message);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('sandbox: a plugin that throws surfaces its message as a poll error', async () => {
	const root = await Deno.makeTempDir();
	try {
		const dir = await installPlugin(
			root,
			'tp',
			MANIFEST,
			`export function poll() { throw new Error('token expired, probably'); }`
		);
		const worker = createPluginWorker(await loadPlugin(dir));

		const err = await assertRejects(() => worker.poll({ config: {}, cursor: null }), Error);
		assertEquals(err.message, 'token expired, probably');
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
