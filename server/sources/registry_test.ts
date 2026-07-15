import { assertEquals } from '@std/assert';
import { clearPluginWorkers, findWorker, getWorkers, registerPluginWorkers } from './registry.ts';
import type { SourceWorker } from './types.ts';

const worker = (slug: string, label: string): SourceWorker => ({
	slug,
	label,
	origin: 'plugin',
	manifestHash: `${slug}-hash`,
	permissions: { net: [], net_from_config: [], env: [] },
	defaultIntervalMs: 60_000,
	configFields: [],
	poll: () => Promise.resolve({ posts: [], cursor: null })
});

Deno.test('registry: source workers come only from installed plugins', () => {
	clearPluginWorkers();
	try {
		assertEquals(getWorkers(), []);
		assertEquals(findWorker('github'), undefined);
		assertEquals(findWorker('linear'), undefined);

		const github = worker('github', 'GitHub');
		const linear = worker('linear', 'Linear');
		registerPluginWorkers([github, linear]);

		assertEquals(getWorkers(), [github, linear]);
		assertEquals(findWorker('github'), github);
		assertEquals(findWorker('linear'), linear);
	} finally {
		clearPluginWorkers();
	}
});

Deno.test('registry: duplicate plugin slugs keep the first discovered worker', () => {
	clearPluginWorkers();
	try {
		const first = worker('github', 'First');
		const duplicate = worker('github', 'Duplicate');
		registerPluginWorkers([first, duplicate]);

		assertEquals(getWorkers(), [first]);
		assertEquals(findWorker('github'), first);
	} finally {
		clearPluginWorkers();
	}
});
