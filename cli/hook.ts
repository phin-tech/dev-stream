/**
 * Turns a Claude Code hook payload into a post.
 *
 * Claude delivers hook events as JSON on stdin. Rather than make users wire up
 * `jq` in their settings.json, `dev-stream hook` reads that payload and does the
 * translation — so the recipe is one line per event and needs no dependencies.
 *
 * Payload shapes: https://code.claude.com/docs/en/hooks
 */

import type { PostInput, PostMeta } from '../src/shared/types.ts';

/** Long tool output is for the transcript, not the timeline. */
const MAX_BODY = 2000;
const MAX_TITLE = 160;

/** The fields we rely on. Everything else in the payload is passed through. */
interface HookPayload {
	hook_event_name?: string;
	session_id?: string;
	cwd?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: Record<string, unknown>;
	message?: string;
	notification_type?: string;
	prompt?: string;
	last_assistant_message?: string;
	source?: string;
	reason?: string;
}

function truncate(text: string, max: number): string {
	const clean = text.trim();
	return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + '…';
}

/** The first line, which for a command or a message is the informative part. */
function firstLine(text: string): string {
	return text.split('\n').find((line) => line.trim()) ?? '';
}

/**
 * A human-readable one-liner for a tool call.
 *
 * The point of the timeline is that it reads like activity, not like a log dump:
 * "Edited server/posts.ts" beats `{"tool":"Edit","file_path":"..."}`.
 */
function describeTool(tool: string, input: Record<string, unknown>): string {
	const file = typeof input.file_path === 'string' ? input.file_path : undefined;

	switch (tool) {
		case 'Edit':
		case 'MultiEdit':
			return file ? `Edited ${file}` : 'Edited a file';
		case 'Write':
			return file ? `Wrote ${file}` : 'Wrote a file';
		case 'Read':
			return file ? `Read ${file}` : 'Read a file';
		case 'NotebookEdit':
			return file ? `Edited notebook ${file}` : 'Edited a notebook';
		case 'Bash': {
			const command = typeof input.command === 'string' ? input.command : '';
			return command ? `Ran: ${truncate(firstLine(command), MAX_TITLE - 6)}` : 'Ran a command';
		}
		case 'Task': {
			const description = typeof input.description === 'string' ? input.description : '';
			return description ? `Agent: ${description}` : 'Ran an agent';
		}
		case 'WebFetch':
		case 'WebSearch': {
			const target = (input.url ?? input.query) as string | undefined;
			return target ? `${tool}: ${truncate(String(target), MAX_TITLE - 12)}` : tool;
		}
		default:
			return `Used ${tool}`;
	}
}

/** Bash is the one tool whose output is usually worth reading in the feed. */
function bashBody(response: Record<string, unknown> | undefined): string | undefined {
	if (!response) return undefined;

	const stdout = typeof response.stdout === 'string' ? response.stdout : '';
	const stderr = typeof response.stderr === 'string' ? response.stderr : '';
	const output = [stdout, stderr].filter((s) => s.trim()).join('\n');
	if (!output.trim()) return undefined;

	// Fenced, so ANSI-free command output renders as a block rather than being
	// mangled by markdown (a line starting with `#` is not a heading here).
	return '```\n' + truncate(output, MAX_BODY) + '\n```';
}

/**
 * Maps a payload to a post, or null to stay silent.
 *
 * Returning null matters: a hook that posts about everything makes a feed nobody
 * reads. A failed tool call, for instance, is worth an alert; a successful `Read`
 * is not worth a card at all.
 */
export function hookToPost(payload: unknown, context: PostMeta): PostInput | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const event = payload as HookPayload;

	const meta: PostMeta = { ...context };
	if (event.session_id) meta.session_id = event.session_id;
	if (event.hook_event_name) meta.hook_event = event.hook_event_name;

	const base = { source: 'claude-code', meta } satisfies Partial<PostInput>;

	switch (event.hook_event_name) {
		case 'PostToolUse': {
			const tool = event.tool_name ?? 'a tool';
			meta.tool = tool;

			const response = event.tool_response;
			// Claude reports a failed tool call in the response rather than by
			// skipping the hook, so this is where an alert comes from.
			const failed =
				response !== undefined &&
				((typeof response.exit_code === 'number' && response.exit_code !== 0) ||
					response.success === false ||
					typeof response.error === 'string');

			return {
				...base,
				kind: failed ? 'alert' : 'event',
				title: describeTool(tool, event.tool_input ?? {}),
				body: tool === 'Bash' ? bashBody(response) : undefined,
				tags: failed ? ['hooks', tool.toLowerCase(), 'failed'] : ['hooks', tool.toLowerCase()]
			};
		}

		case 'Stop': {
			const message = event.last_assistant_message?.trim();
			return {
				...base,
				kind: 'note',
				// The first line of the reply is the summary often enough to be worth
				// using as the title; the rest becomes the body.
				title: message ? truncate(firstLine(message), MAX_TITLE) : 'Claude finished responding',
				body: message ? truncate(message, MAX_BODY) : undefined,
				tags: ['hooks', 'stop']
			};
		}

		case 'Notification': {
			const message = event.message?.trim();
			if (!message) return null;
			return {
				...base,
				kind: 'alert',
				title: truncate(message, MAX_TITLE),
				tags: ['hooks', 'notification'],
				// Claude notifies repeatedly while waiting for the same permission
				// prompt; without this the feed fills with identical cards.
				dedupe_key: event.session_id
					? `claude-notification:${event.session_id}:${event.notification_type ?? 'generic'}`
					: undefined
			};
		}

		case 'UserPromptSubmit': {
			const prompt = event.prompt?.trim();
			if (!prompt) return null;
			return {
				...base,
				kind: 'note',
				title: truncate(firstLine(prompt), MAX_TITLE),
				body: prompt.length > MAX_TITLE ? truncate(prompt, MAX_BODY) : undefined,
				tags: ['hooks', 'prompt']
			};
		}

		case 'SessionStart':
			return {
				...base,
				kind: 'event',
				title: `Claude session started (${event.source ?? 'startup'})`,
				tags: ['hooks', 'session']
			};

		case 'SessionEnd':
			return {
				...base,
				kind: 'event',
				title: `Claude session ended (${event.reason ?? 'unknown'})`,
				tags: ['hooks', 'session']
			};

		default:
			// An event we don't model yet. Silence beats a card that says nothing.
			return null;
	}
}
