import { assertEquals, assertRejects } from '@std/assert';
import {
	installPluginFromGitHub,
	parseGitHubPluginUrl,
	type GitHubArchiveSource
} from './install.ts';

Deno.test('github plugin URL: parses repository and tree URLs', () => {
	assertEquals(parseGitHubPluginUrl('https://github.com/phin-tech/dev-stream-plugins'), {
		owner: 'phin-tech',
		repo: 'dev-stream-plugins',
		ref: 'HEAD',
		pluginPath: ''
	});

	assertEquals(
		parseGitHubPluginUrl(
			'https://github.com/phin-tech/dev-stream-plugins/tree/main/plugins/github'
		),
		{
			owner: 'phin-tech',
			repo: 'dev-stream-plugins',
			ref: 'main',
			pluginPath: 'plugins/github'
		}
	);
});

Deno.test('github plugin URL: rejects unsupported and unsafe inputs', () => {
	for (const input of [
		'git@github.com:phin-tech/dev-stream-plugins.git',
		'https://example.com/phin-tech/dev-stream-plugins',
		'https://github.com/phin-tech',
		'https://github.com/phin-tech/dev-stream-plugins/tree/main/../linear'
	]) {
		assertRejects(
			async () => parseGitHubPluginUrl(input),
			Error
		);
	}
});

class MemoryArchiveSource implements GitHubArchiveSource {
	readonly requests: Array<{ owner: string; repo: string; ref: string }> = [];

	constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

	fetch(request: { owner: string; repo: string; ref: string }): Promise<ReadonlyMap<string, Uint8Array>> {
		this.requests.push(request);
		return Promise.resolve(this.files);
	}
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

Deno.test('github plugin install: selects one plugin and installs a loadable directory', async () => {
	const root = await Deno.makeTempDir();
	const source = new MemoryArchiveSource(
		new Map([
			[
				'dev-stream-plugins-main/plugins/github/manifest.json',
				bytes(JSON.stringify({
					slug: 'github',
					label: 'GitHub',
					entry: 'mod.ts',
					permissions: { net: ['api.github.com'] }
				}))
			],
			['dev-stream-plugins-main/plugins/github/mod.ts', bytes('export function poll() {}')],
			['dev-stream-plugins-main/plugins/linear/manifest.json', bytes('{}')]
		])
	);

	try {
		const installed = await installPluginFromGitHub(
			'https://github.com/phin-tech/dev-stream-plugins/tree/main/plugins/github',
			{ pluginsRoot: root, source }
		);

		assertEquals(source.requests, [{ owner: 'phin-tech', repo: 'dev-stream-plugins', ref: 'main' }]);
		assertEquals(installed.manifest.slug, 'github');
		assertEquals(installed.dir, `${root}/github`);
		assertEquals(await Deno.readTextFile(`${root}/github/mod.ts`), 'export function poll() {}');
		await assertRejects(() => Deno.stat(`${root}/linear`), Deno.errors.NotFound);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('github plugin install: invalid archives leave no partial plugin', async () => {
	const root = await Deno.makeTempDir();
	const source = new MemoryArchiveSource(
		new Map([
			['dev-stream-plugins-main/plugin/manifest.json', bytes('{"slug":"broken"}')],
			['dev-stream-plugins-main/plugin/mod.ts', bytes('export function poll() {}')]
		])
	);

	try {
		await assertRejects(
			() => installPluginFromGitHub(
				'https://github.com/phin-tech/dev-stream-plugins/tree/main/plugin',
				{ pluginsRoot: root, source }
			),
			Error
		);
		await assertRejects(() => Deno.stat(`${root}/broken`), Deno.errors.NotFound);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
