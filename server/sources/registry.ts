/**
 * Every source worker the app knows about.
 *
 * Plugins are discovered from `~/.dev-stream/plugins` at startup, wrapped in a
 * permission-scoped worker adapter, and registered here — after which the
 * runner, store and settings page treat them identically.
 */

import type { SourceWorker } from './types.ts';

const plugins: SourceWorker[] = [];

/**
 * Registers discovered plugins. A slug collision drops the newcomer: the
 * incumbent's config and credentials already live on the `sources` row that
 * slug owns.
 */
export function registerPluginWorkers(workers: SourceWorker[]): void {
	for (const worker of workers) {
		if (findWorker(worker.slug)) {
			console.error(`[plugins] ignoring "${worker.slug}": that slug is already taken`);
			continue;
		}
		plugins.push(worker);
	}
}

/** Test isolation only. */
export function clearPluginWorkers(): void {
	plugins.length = 0;
}

export function getWorkers(): SourceWorker[] {
	return [...plugins];
}

export const findWorker = (slug: string): SourceWorker | undefined =>
	getWorkers().find((w) => w.slug === slug);
