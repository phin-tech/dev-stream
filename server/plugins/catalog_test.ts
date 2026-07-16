import { assertEquals, assertThrows } from '@std/assert';
import { parseRegistry, versionAtLeast } from './catalog.ts';

const entry = {
	slug: 'github', label: 'GitHub', description: 'Notifications', version: '1.0.0',
	min_app_version: '0.1.0',
	source: { owner: 'phin-tech', repo: 'plugins', ref: 'a'.repeat(40), path: 'github' },
	manifest_sha256: 'b'.repeat(64)
};

Deno.test('registry parser validates pinned, unique plugin entries', () => {
	assertEquals(parseRegistry({ schema_version: 1, plugins: [entry] })[0], entry);
	assertThrows(() => parseRegistry({ schema_version: 1, plugins: [entry, entry] }), Error, 'duplicate');
	assertThrows(() => parseRegistry({ schema_version: 1, plugins: [{ ...entry, source: { ...entry.source, ref: 'main' } }] }));
});

Deno.test('compatibility comparison handles semantic version triples', () => {
	assertEquals(versionAtLeast('0.1.0', '0.1.0'), true);
	assertEquals(versionAtLeast('0.2.0', '0.1.9'), true);
	assertEquals(versionAtLeast('0.1.0', '0.2.0'), false);
});
