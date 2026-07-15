/**
 * Every source worker the app knows about.
 *
 * Adding an integration means writing a `SourceWorker` and adding it here. It
 * needs no schema change, no API route, and no UI work — the settings page renders
 * whatever `configFields` the worker declares.
 */

import type { SourceWorker } from './types.ts';
import { github } from './github.ts';
import { linear } from './linear.ts';

export const WORKERS: SourceWorker[] = [github, linear];

export const findWorker = (slug: string): SourceWorker | undefined =>
	WORKERS.find((w) => w.slug === slug);
