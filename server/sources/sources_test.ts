import { assertEquals } from '@std/assert';
import { openDb } from '../db.ts';
import { Broadcaster } from '../events.ts';
import { clearPluginWorkers, registerPluginWorkers } from './registry.ts';
import { startSourceRunner } from './runner.ts';
import { describeSource, getSourceState, saveSourceConfig, setSourceTrust } from './store.ts';
import type { SourceWorker } from './types.ts';

const plugin = (slug: string): SourceWorker => ({
	slug,
	label: slug,
	origin: 'plugin',
	manifestHash: `${slug}-manifest`,
	permissions: { net: [], net_from_config: [], env: [] },
	defaultIntervalMs: 60_000,
	configFields: [{ key: 'token', label: 'Token', secret: true }],
	poll: ({ cursor }) => Promise.resolve({
		posts: [{ source: slug, kind: 'event', title: `${slug} event` }],
		cursor: cursor ?? 'next'
	})
});

Deno.test('a stored plugin secret is never returned to the client', () => {
	const db = openDb(':memory:');
	clearPluginWorkers();
	try {
		registerPluginWorkers([plugin('github')]);
		saveSourceConfig(db, 'github', { config: { token: 'secret' } });
		const status = describeSource(db, plugin('github'));
		assertEquals(status.config, {});
		assertEquals(status.configured, true);
	} finally {
		clearPluginWorkers();
		db.close();
	}
});

Deno.test('saving plugin settings without retyping a secret preserves it', () => {
	const db = openDb(':memory:');
	clearPluginWorkers();
	try {
		registerPluginWorkers([plugin('github')]);
		saveSourceConfig(db, 'github', { config: { token: 'secret' } });
		saveSourceConfig(db, 'github', { config: { token: '' } });
		assertEquals(getSourceState(db, 'github').config.token, 'secret');
	} finally {
		clearPluginWorkers();
		db.close();
	}
});

Deno.test('disabling a plugin source keeps credentials and watermark', () => {
	const db = openDb(':memory:');
	clearPluginWorkers();
	try {
		registerPluginWorkers([plugin('linear')]);
		saveSourceConfig(db, 'linear', { config: { token: 'secret' } });
		db.prepare('UPDATE sources SET cursor = ? WHERE slug = ?').run('watermark', 'linear');
		saveSourceConfig(db, 'linear', { enabled: false, config: {} });
		const state = getSourceState(db, 'linear');
		assertEquals(state.config.token, 'secret');
		assertEquals(state.cursor, 'watermark');
	} finally {
		clearPluginWorkers();
		db.close();
	}
});

Deno.test('posts from a trusted plugin use the normal ingestion path', async () => {
	const db = openDb(':memory:');
	clearPluginWorkers();
	try {
		registerPluginWorkers([plugin('testplug')]);
		setSourceTrust(db, 'testplug', { trusted: true });
		saveSourceConfig(db, 'testplug', { enabled: true, config: {} });
		const runner = startSourceRunner(db, new Broadcaster());
		try {
			assertEquals(await runner.pollNow('testplug'), { posts: 1 });
			assertEquals((db.prepare('SELECT title FROM posts').get() as { title: string }).title, 'testplug event');
		} finally {
			runner.stop();
		}
	} finally {
		clearPluginWorkers();
		db.close();
	}
});
