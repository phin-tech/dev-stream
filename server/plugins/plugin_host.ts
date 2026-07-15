/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

/**
 * The worker-side half of the plugin sandbox. This file is the ONLY trusted
 * code that runs inside a plugin's isolate.
 *
 * The host spawns one worker per poll with permissions scoped to the plugin's
 * manifest, posts a single request, and terminates the worker as soon as it
 * answers (or times out). One-shot on purpose: no state leaks between polls,
 * and a plugin that wedged itself last time starts clean this time.
 *
 * The dynamic `import()` below is what the sandbox's read grant (the plugin's
 * own directory) exists to allow. Anything else the plugin tries — net outside
 * its allowlist, the filesystem, subprocesses — throws `NotCapable` in here,
 * which surfaces to the runner as an ordinary poll error.
 */

interface PollRequest {
	/** file:// URL of the plugin's entry module. */
	entry: string;
	config: Record<string, unknown>;
	cursor: string | null;
}

type PollReply =
	| { ok: true; posts: unknown[]; cursor: string | null }
	| { ok: false; message: string };

const reply = (message: PollReply) => (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent<PollRequest>) => {
	const { entry, config, cursor } = event.data;
	try {
		const mod = (await import(entry)) as { poll?: unknown };
		if (typeof mod.poll !== 'function') {
			throw new Error('entry module does not export a poll() function');
		}

		const result = (await mod.poll({ config, cursor })) as {
			posts?: unknown;
			cursor?: unknown;
		} | null;

		// Shape-check the envelope here so the host gets a clear complaint instead
		// of a structured-clone surprise. The posts themselves are validated by the
		// same insertPosts path every other producer goes through.
		const posts = Array.isArray(result?.posts) ? result.posts : [];
		const next = typeof result?.cursor === 'string' ? result.cursor : null;
		reply({ ok: true, posts, cursor: next });
	} catch (err) {
		reply({ ok: false, message: err instanceof Error ? err.message : String(err) });
	}
};
