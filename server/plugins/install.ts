import { basename, join, normalize, relative, resolve } from '@std/path';
import { loadPlugin, type InstalledPlugin } from './manifest.ts';

export interface GitHubPluginLocation {
	owner: string;
	repo: string;
	ref: string;
	pluginPath: string;
}

export interface GitHubArchiveSource {
	fetch(request: {
		owner: string;
		repo: string;
		ref: string;
	}): Promise<ReadonlyMap<string, Uint8Array>>;
}

export interface InstallPluginOptions {
	pluginsRoot: string;
	source: GitHubArchiveSource;
}

interface GitHubContent {
	type: 'file' | 'dir';
	path: string;
	download_url: string | null;
}

/** Reads a public repository through GitHub's contents API. */
export class GitHubContentsSource implements GitHubArchiveSource {
	async fetch(request: { owner: string; repo: string; ref: string }): Promise<ReadonlyMap<string, Uint8Array>> {
		const files = new Map<string, Uint8Array>();
		const directories = [''];
		const root = `${request.repo}-${request.ref}`;

		while (directories.length > 0) {
			const path = directories.shift()!;
			const endpoint = new URL(
				`https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/contents/${path}`
			);
			if (request.ref !== 'HEAD') endpoint.searchParams.set('ref', request.ref);
			const response = await fetch(endpoint, {
				headers: { accept: 'application/vnd.github+json', 'user-agent': 'dev-stream' }
			});
			if (!response.ok) throw new Error(`GitHub returned ${response.status} while reading the plugin repository`);
			const entries = await response.json() as GitHubContent[];
			for (const entry of entries) {
				if (entry.type === 'dir') directories.push(entry.path);
				else if (entry.type === 'file' && entry.download_url) {
					const file = await fetch(entry.download_url);
					if (!file.ok) throw new Error(`GitHub returned ${file.status} while downloading ${entry.path}`);
					files.set(`${root}/${entry.path}`, new Uint8Array(await file.arrayBuffer()));
				}
			}
		}
		return files;
	}
}

export function parseGitHubPluginUrl(input: string): GitHubPluginLocation {
	if (input.split(/[/?#]/).some((part) => part === '.' || part === '..')) {
		throw new Error('plugin URL contains an unsafe path');
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error('plugin URL must be an HTTPS GitHub URL');
	}
	if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
		throw new Error('plugin URL must be an HTTPS github.com URL');
	}

	const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	if (parts.length < 2 || parts.some((part) => part === '.' || part === '..')) {
		throw new Error('plugin URL must identify a GitHub repository');
	}

	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/, '');
	if (!owner || !repo) throw new Error('plugin URL must identify a GitHub repository');
	if (parts.length === 2) return { owner, repo, ref: 'HEAD', pluginPath: '' };
	if (parts[2] !== 'tree' || !parts[3]) {
		throw new Error('plugin URL must identify a repository or directory');
	}

	return {
		owner,
		repo,
		ref: parts[3],
		pluginPath: parts.slice(4).join('/')
	};
}

export async function installPluginFromGitHub(
	input: string,
	options: InstallPluginOptions
): Promise<InstalledPlugin> {
	const location = parseGitHubPluginUrl(input);
	await Deno.mkdir(options.pluginsRoot, { recursive: true });
	const { owner, repo, ref } = location;
	const archive = await options.source.fetch({ owner, repo, ref });
	const entries = [...archive.entries()];
	if (entries.length === 0) throw new Error('GitHub archive is empty');

	const archiveRoot = entries[0][0].split('/')[0];
	const selectedRoot = [archiveRoot, location.pluginPath].filter(Boolean).join('/');
	const selectedPrefix = `${selectedRoot}/`;
	const selected = entries.filter(([path]) => path.startsWith(selectedPrefix));
	if (selected.length === 0) throw new Error('plugin directory does not exist in the GitHub archive');

	const stagingRoot = await Deno.makeTempDir({ dir: options.pluginsRoot, prefix: '.install-' });
	try {
		for (const [archivePath, contents] of selected) {
			const path = normalize(archivePath.slice(selectedPrefix.length));
			if (!path || path === '..' || path.startsWith(`..${Deno.build.os === 'windows' ? '\\' : '/'}`)) {
				throw new Error('GitHub archive contains an unsafe path');
			}
			const destination = resolve(join(stagingRoot, path));
			if (relative(stagingRoot, destination).startsWith('..')) {
				throw new Error('GitHub archive contains an unsafe path');
			}
			await Deno.mkdir(resolve(destination, '..'), { recursive: true });
			await Deno.writeFile(destination, contents);
		}

		const staged = await loadPlugin(stagingRoot);
		const target = join(options.pluginsRoot, staged.manifest.slug || basename(selectedRoot));
		await Deno.rename(stagingRoot, target);
		return await loadPlugin(target);
	} catch (error) {
		try {
			await Deno.remove(stagingRoot, { recursive: true });
		} catch (cleanupError) {
			if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
		}
		throw error;
	}
}
