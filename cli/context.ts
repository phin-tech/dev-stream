/**
 * Infers `project`, `repo` and `branch` from the working directory.
 *
 * This is what makes a hook recipe a one-liner. Nobody is going to hand-write
 * `--project` and `--repo` into a hook that fires on every edit, and a timeline
 * you can't filter by repo is not much of a timeline — so the CLI works them out.
 */

import { basename } from '@std/path';
import type { PostMeta } from '../src/shared/types.ts';

/** Cached: several posts in one process shouldn't shell out to git repeatedly. */
let cached: PostMeta | undefined;

async function git(args: string[], cwd: string): Promise<string | null> {
	try {
		const { success, stdout } = await new Deno.Command('git', {
			args,
			cwd,
			stdout: 'piped',
			stderr: 'null'
		}).output();
		if (!success) return null;
		const value = new TextDecoder().decode(stdout).trim();
		return value || null;
	} catch {
		// git isn't installed, or we lack permission to run it. Not fatal: the post
		// simply carries less metadata.
		return null;
	}
}

/**
 * Turns a git remote URL into `owner/name`.
 *
 * Handles the two forms in the wild — `git@host:owner/name.git` and
 * `https://host/owner/name.git` — and gives up quietly on anything else rather
 * than guessing.
 */
export function parseRepo(remote: string): string | null {
	const cleaned = remote.trim().replace(/\.git$/, '');

	const ssh = cleaned.match(/^[^@]+@[^:]+:(.+)$/);
	if (ssh) return ssh[1] || null;

	try {
		const url = new URL(cleaned);
		const path = url.pathname.replace(/^\//, '');
		return path || null;
	} catch {
		return null;
	}
}

/** Everything we can work out about where we are. Never throws. */
export async function inferContext(cwd: string = Deno.cwd()): Promise<PostMeta> {
	if (cached) return cached;

	const toplevel = await git(['rev-parse', '--show-toplevel'], cwd);
	const meta: PostMeta = {
		// The repo directory name, not the cwd's: a hook firing in a subdirectory
		// should still say it belongs to the same project.
		project: basename(toplevel ?? cwd)
	};

	if (toplevel) {
		const remote = await git(['remote', 'get-url', 'origin'], cwd);
		const repo = remote ? parseRepo(remote) : null;
		if (repo) meta.repo = repo;

		const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		if (branch && branch !== 'HEAD') meta.branch = branch; // 'HEAD' = detached
	}

	cached = meta;
	return meta;
}
