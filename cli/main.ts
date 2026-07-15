/**
 * The `dev-stream` CLI.
 *
 * A thin client of the same HTTP API that the UI, the MCP server and any stray
 * curl use. It exists because a hook line in settings.json should be readable,
 * and because piping a command's output into your timeline should be one pipe.
 *
 *   dev-stream post "Deployed to prod" --tag deploy
 *   npm test | dev-stream post --source ci --title "Tests"
 *   dev-stream tail
 *   dev-stream init claude
 */

import { parseArgs } from '@std/cli/parse-args';
import type { PostInput, StreamEvent } from '../src/shared/types.ts';
import { APP_VERSION } from '../server/paths.ts';
import { discover, post } from './client.ts';
import { inferContext } from './context.ts';
import { hookToPost } from './hook.ts';
import { initClaude } from './init.ts';

const HELP = `dev-stream ${APP_VERSION} — a timeline for your machine

USAGE
  dev-stream post [message] [options]   post to the timeline
  dev-stream tail [options]             follow the timeline live
  dev-stream hook                       read a Claude Code hook payload on stdin
  dev-stream init claude [--global]     install the Claude Code hook recipes
  dev-stream mcp                        run as an MCP server (stdio)
  dev-stream status                     is the app running, and where?

POST OPTIONS
  --title <text>        card title (defaults to the message, or stdin's first line)
  --body <text>         markdown body (defaults to piped stdin)
  --source <slug>       origin, e.g. ci, deploy, cron          [default: cli]
  --kind <kind>         event | note | alert | pr | issue      [default: event]
  --tag <tag>           repeatable
  --project <name>      defaults to the git repo directory name
  --repo <owner/name>   defaults to the git 'origin' remote
  --meta <key=value>    repeatable, arbitrary metadata
  --dedupe-key <key>    re-posting this key soon updates the card instead
  --json                read a post object (or array) from stdin instead

TAIL OPTIONS
  --source <slug>       only this source (repeatable)

Posts are written to the local API, or spooled to ~/.dev-stream/spool when the
app isn't running — so a hook never blocks and never loses an event.

MCP:  claude mcp add dev-stream -- dev-stream mcp
`;

function fail(message: string): never {
	console.error(`dev-stream: ${message}`);
	Deno.exit(1);
}

async function readStdin(): Promise<string> {
	// Deliberately not read when stdin is a terminal: `dev-stream post "x"` in an
	// interactive shell must not hang waiting for input that will never come.
	if (Deno.stdin.isTerminal()) return '';
	const chunks: Uint8Array[] = [];
	for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
	return new TextDecoder().decode(
		chunks.reduce((acc, c) => {
			const merged = new Uint8Array(acc.length + c.length);
			merged.set(acc);
			merged.set(c, acc.length);
			return merged;
		}, new Uint8Array())
	);
}

const asList = (value: unknown): string[] =>
	value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String);

async function cmdPost(args: string[]): Promise<void> {
	const flags = parseArgs(args, {
		string: ['title', 'body', 'source', 'kind', 'project', 'repo', 'tag', 'meta', 'dedupe-key'],
		boolean: ['json'],
		collect: ['tag', 'meta']
	});

	const stdin = await readStdin();

	// --json: the caller has already built the post(s). Used by anything that
	// wants the full model without a flag for every field.
	if (flags.json) {
		if (!stdin.trim()) fail('--json expects a post object or array on stdin');
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdin);
		} catch (err) {
			fail(`--json: stdin is not valid JSON (${err})`);
		}
		const posts = (Array.isArray(parsed) ? parsed : [parsed]) as PostInput[];
		const delivery = await post(posts);
		report(delivery.via, posts.length, delivery.detail);
		return;
	}

	const message = flags._.map(String).join(' ').trim();

	// Title precedence: --title, then the positional message, then stdin's first
	// line. That makes `npm test | dev-stream post --source ci` do something
	// sensible with no title at all.
	const firstLine = stdin.split('\n').find((line) => line.trim())?.trim() ?? '';
	const title = flags.title?.trim() || message || firstLine;
	if (!title) fail('nothing to post: pass a message, --title, or pipe something in');

	// The body is the piped input, unless the piped input *was* the title.
	const body = flags.body ?? (stdin.trim() && stdin.trim() !== title ? stdin.trimEnd() : undefined);

	const meta = await inferContext();
	if (flags.project) meta.project = flags.project;
	if (flags.repo) meta.repo = flags.repo;

	for (const pair of asList(flags.meta)) {
		const index = pair.indexOf('=');
		if (index <= 0) fail(`--meta expects key=value, got "${pair}"`);
		meta[pair.slice(0, index)] = pair.slice(index + 1);
	}

	const delivery = await post([
		{
			source: flags.source ?? 'cli',
			kind: flags.kind ?? 'event',
			title,
			body,
			tags: asList(flags.tag),
			meta,
			dedupe_key: flags['dedupe-key']
		}
	]);

	report(delivery.via, 1, delivery.detail);
}

function report(via: 'api' | 'spool', count: number, detail?: string): void {
	const noun = count === 1 ? 'post' : 'posts';
	if (via === 'api') console.log(`posted ${count} ${noun}`);
	// Not an error: spooling is the designed behaviour when the app is closed.
	// But say so, or a user will think their post vanished.
	else console.log(`dev-stream isn't running — spooled ${count} ${noun} to ${detail}`);
}

/**
 * `dev-stream hook` — the Claude Code adapter.
 *
 * ALWAYS exits 0. A non-zero exit from a hook is shown to the user as an error
 * inside their Claude session; a timeline that can't post is not worth
 * interrupting someone's work over.
 */
async function cmdHook(): Promise<void> {
	try {
		const stdin = await readStdin();
		if (!stdin.trim()) return;

		const payload = JSON.parse(stdin);
		const context = await inferContext(
			typeof payload?.cwd === 'string' ? payload.cwd : Deno.cwd()
		);

		const item = hookToPost(payload, context);
		if (item) await post([item]);
	} catch (err) {
		// Visible if the user goes looking (Claude surfaces stderr), but harmless.
		console.error(`dev-stream hook: ${err}`);
	}
}

async function cmdTail(args: string[]): Promise<void> {
	const flags = parseArgs(args, { string: ['source'], collect: ['source'] });
	const sources = new Set(asList(flags.source));

	const config = await discover();
	if (!config) fail('dev-stream is not running (no ~/.dev-stream/port)');

	const res = await fetch(`http://127.0.0.1:${config.port}/api/events`, {
		headers: { authorization: `Bearer ${config.token}` }
	});
	if (!res.ok || !res.body) fail(`could not subscribe: ${res.status}`);

	console.error(`# following http://127.0.0.1:${config.port} — ctrl-c to stop`);

	// A hand-rolled SSE reader rather than EventSource: this way the token goes in
	// a header instead of the URL, keeping it out of the process list.
	let buffer = '';
	const decoder = new TextDecoder();
	for await (const chunk of res.body) {
		buffer += decoder.decode(chunk, { stream: true });

		// Frames are separated by a blank line; a partial frame stays in the buffer.
		let boundary: number;
		while ((boundary = buffer.indexOf('\n\n')) !== -1) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);

			const data = frame
				.split('\n')
				.find((line) => line.startsWith('data: '))
				?.slice(6);
			if (!data) continue; // a heartbeat comment

			const event = JSON.parse(data) as StreamEvent;
			if (event.type !== 'post') continue;
			if (sources.size > 0 && !sources.has(event.post.source)) continue;

			const time = new Date(event.post.ts).toLocaleTimeString();
			const tags = event.post.tags.map((t) => `#${t}`).join(' ');
			console.log(
				`${time}  ${event.post.source.padEnd(12)} ${event.post.title}${tags ? '  ' + tags : ''}`
			);
		}
	}
}

async function cmdStatus(): Promise<void> {
	const config = await discover();
	if (!config) {
		console.log('dev-stream is not running. Posts will be spooled until it starts.');
		return;
	}

	try {
		const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
			signal: AbortSignal.timeout(1000)
		});
		const info = await res.json();
		console.log(`dev-stream ${info.version} running on 127.0.0.1:${info.port} (pid ${info.pid})`);
	} catch {
		// The port file outlives an ungraceful exit, so a stale one is expected.
		console.log(`~/.dev-stream/port says ${config.port}, but nothing is answering there.`);
	}
}

async function main(): Promise<void> {
	const [command, ...rest] = Deno.args;

	switch (command) {
		case 'post':
			return await cmdPost(rest);
		case 'hook':
			return await cmdHook();
		case 'tail':
			return await cmdTail(rest);
		case 'status':
			return await cmdStatus();
		case 'mcp': {
			// Imported lazily: the MCP SDK is a heavy dependency, and `dev-stream
			// hook` runs on every tool call in a Claude session -- it must not pay
			// to load a server it will never start.
			const { runMcpServer } = await import('../mcp/server.ts');
			return await runMcpServer();
		}
		case 'init': {
			if (rest[0] !== 'claude') fail("only 'dev-stream init claude' is supported");
			const flags = parseArgs(rest.slice(1), { boolean: ['global'] });
			const result = await initClaude(flags.global);
			console.log(
				`${result.created ? 'Created' : 'Updated'} ${result.path}\n` +
					`Hooks installed for: ${result.events.join(', ')}\n\n` +
					`Claude Code sessions in ${flags.global ? 'any project' : 'this project'} will now post to your timeline.`
			);
			return;
		}
		case '--version':
		case 'version':
			console.log(APP_VERSION);
			return;
		case undefined:
		case '--help':
		case '-h':
		case 'help':
			console.log(HELP);
			return;
		default:
			fail(`unknown command "${command}" (try --help)`);
	}
}

/**
 * One place where every command's failure becomes a readable line.
 *
 * Without this, any thrown error escapes as an uncaught rejection and Deno prints
 * a stack trace full of `/var/folders/.../deno-compile-dev-stream/...` paths — for
 * something as ordinary as a rejected token. A CLI should say what went wrong.
 */
try {
	await main();
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);

	if (message.toLowerCase().includes('unauthorized')) {
		// Almost always means the server on the recorded port is not the one that
		// owns ~/.dev-stream/token: a stale port file, or a second dev-stream
		// running against a different DEV_STREAM_HOME.
		fail(
			`the server rejected the token in ~/.dev-stream/token.\n` +
				`  Something else is answering on the port dev-stream recorded.\n` +
				`  Try: dev-stream status  (and restart the app if it looks wrong)`
		);
	}

	fail(message);
}
