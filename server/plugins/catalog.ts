import type { RegistryPlugin } from '../../src/shared/types.ts';

export const REGISTRY_URL =
	'https://raw.githubusercontent.com/phin-tech/dev-stream-plugins/main/registry.json';

const string = (value: unknown, field: string): string => {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`registry ${field} is required`);
	return value;
};

export function parseRegistry(value: unknown): RegistryPlugin[] {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('registry must be an object');
	const root = value as Record<string, unknown>;
	if (root.schema_version !== 1 || !Array.isArray(root.plugins)) throw new Error('unsupported plugin registry schema');
	const seen = new Set<string>();
	return root.plugins.map((raw, index) => {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`registry plugin ${index} must be an object`);
		const item = raw as Record<string, unknown>;
		const source = item.source as Record<string, unknown> | undefined;
		if (!source || typeof source !== 'object') throw new Error(`registry plugin ${index} source is required`);
		const plugin: RegistryPlugin = {
			slug: string(item.slug, 'slug'), label: string(item.label, 'label'),
			description: string(item.description, 'description'), version: string(item.version, 'version'),
			min_app_version: string(item.min_app_version, 'min_app_version'),
			source: { owner: string(source.owner, 'source.owner'), repo: string(source.repo, 'source.repo'),
				ref: string(source.ref, 'source.ref'), path: string(source.path, 'source.path') },
			manifest_sha256: string(item.manifest_sha256, 'manifest_sha256')
		};
		if (!/^[a-z0-9_-]+$/.test(plugin.slug) || !/^[0-9a-f]{40}$/.test(plugin.source.ref) ||
			!/^[0-9a-f]{64}$/.test(plugin.manifest_sha256)) throw new Error(`registry plugin ${plugin.slug} has invalid identity data`);
		if (seen.has(plugin.slug)) throw new Error(`registry contains duplicate slug: ${plugin.slug}`);
		seen.add(plugin.slug);
		return plugin;
	});
}

export function versionAtLeast(current: string, minimum: string): boolean {
	const parse = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10));
	const a = parse(current), b = parse(minimum);
	for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
	return true;
}

export async function fetchRegistry(url = REGISTRY_URL): Promise<RegistryPlugin[]> {
	const response = await fetch(url, { headers: { accept: 'application/json' } });
	if (!response.ok) throw new Error(`plugin registry returned ${response.status}`);
	return parseRegistry(await response.json());
}
