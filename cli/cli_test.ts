import { assert, assertEquals, assertThrows } from '@std/assert';
import { parseRepo } from './context.ts';
import { hookToPost } from './hook.ts';
import { DEFAULT_RECIPES, mergeHooks } from './init.ts';

const CONTEXT = { project: 'dev-stream', repo: 'phin-tech/dev-stream', branch: 'main' };

// --- context ---------------------------------------------------------------

Deno.test('parseRepo handles the remote URL forms that exist in the wild', () => {
	assertEquals(parseRepo('git@github.com:phin-tech/dev-stream.git'), 'phin-tech/dev-stream');
	assertEquals(parseRepo('https://github.com/phin-tech/dev-stream.git'), 'phin-tech/dev-stream');
	assertEquals(parseRepo('https://github.com/phin-tech/dev-stream'), 'phin-tech/dev-stream');
	assertEquals(parseRepo('ssh://git@github.com/phin-tech/dev-stream.git'), 'phin-tech/dev-stream');
	// Self-hosted, with a nested group path.
	assertEquals(parseRepo('git@gitlab.com:group/sub/project.git'), 'group/sub/project');
	// Nonsense gives up quietly rather than inventing a repo name.
	assertEquals(parseRepo('not a url'), null);
	assertEquals(parseRepo(''), null);
});

// --- hook payload -> post --------------------------------------------------

Deno.test('an Edit becomes a readable card, not a log line', () => {
	const post = hookToPost(
		{
			hook_event_name: 'PostToolUse',
			session_id: 's1',
			tool_name: 'Edit',
			tool_input: { file_path: 'server/posts.ts' }
		},
		CONTEXT
	)!;

	assertEquals(post.title, 'Edited server/posts.ts');
	assertEquals(post.source, 'claude-code');
	assertEquals(post.kind, 'event');
	assertEquals(post.tags, ['hooks', 'edit']);
	assertEquals(post.meta?.project, 'dev-stream');
	assertEquals(post.meta?.session_id, 's1');
});

Deno.test('a Bash call carries its command and output', () => {
	const post = hookToPost(
		{
			hook_event_name: 'PostToolUse',
			tool_name: 'Bash',
			tool_input: { command: 'npm test' },
			tool_response: { stdout: '42 passing', stderr: '', exit_code: 0 }
		},
		CONTEXT
	)!;

	assertEquals(post.title, 'Ran: npm test');
	assert(post.body?.includes('42 passing'));
	// Fenced, so command output isn't reinterpreted as markdown.
	assert(post.body?.startsWith('```'));
	assertEquals(post.kind, 'event');
});

Deno.test('a failed tool call is an alert', () => {
	const post = hookToPost(
		{
			hook_event_name: 'PostToolUse',
			tool_name: 'Bash',
			tool_input: { command: 'npm test' },
			tool_response: { stdout: '', stderr: 'FAIL', exit_code: 1 }
		},
		CONTEXT
	)!;

	assertEquals(post.kind, 'alert');
	assert(post.tags?.includes('failed'));
});

Deno.test('repeated notifications about one prompt collapse into a single card', () => {
	const payload = {
		hook_event_name: 'Notification',
		session_id: 's1',
		notification_type: 'permission_prompt',
		message: 'Claude needs permission to run npm test'
	};
	const first = hookToPost(payload, CONTEXT)!;
	const second = hookToPost(payload, CONTEXT)!;

	assertEquals(first.kind, 'alert');
	// Same dedupe key => the second one updates the first rather than stacking.
	assertEquals(first.dedupe_key, second.dedupe_key);
	assert(first.dedupe_key?.includes('s1'));
});

Deno.test('Stop uses the reply\'s first line as the title and the rest as the body', () => {
	const post = hookToPost(
		{
			hook_event_name: 'Stop',
			last_assistant_message: 'Fixed the pagination bug.\n\nIt was an off-by-one in the cursor.'
		},
		CONTEXT
	)!;

	assertEquals(post.title, 'Fixed the pagination bug.');
	assert(post.body?.includes('off-by-one'));
	assertEquals(post.kind, 'note');
});

Deno.test('long titles are truncated rather than blowing past the API limit', () => {
	const post = hookToPost(
		{
			hook_event_name: 'PostToolUse',
			tool_name: 'Bash',
			tool_input: { command: 'echo ' + 'x'.repeat(500) }
		},
		CONTEXT
	)!;

	assert(post.title.length <= 160, `title was ${post.title.length} chars`);
	assert(post.title.endsWith('…'));
});

Deno.test('events we do not model stay silent', () => {
	// A feed that posts about everything is a feed nobody reads.
	assertEquals(hookToPost({ hook_event_name: 'PreToolUse', tool_name: 'Read' }, CONTEXT), null);
	assertEquals(hookToPost({ hook_event_name: 'Unknown' }, CONTEXT), null);
	assertEquals(hookToPost({}, CONTEXT), null);
	assertEquals(hookToPost(null, CONTEXT), null);
	// ...and an empty notification has nothing to say.
	assertEquals(hookToPost({ hook_event_name: 'Notification', message: '  ' }, CONTEXT), null);
});

// --- settings.json merge ---------------------------------------------------

Deno.test('init writes hooks for each recipe', () => {
	const merged = mergeHooks({}, '/usr/local/bin/dev-stream hook');

	for (const recipe of DEFAULT_RECIPES) {
		const entries = merged.hooks![recipe.event];
		assert(entries?.length === 1, `no hook written for ${recipe.event}`);
		assertEquals(entries[0].hooks[0].command, '/usr/local/bin/dev-stream hook');
		assertEquals(entries[0].matcher, recipe.matcher);
	}
});

Deno.test("init preserves the user's own settings and hooks", () => {
	const existing = {
		model: 'opus',
		hooks: {
			PostToolUse: [
				{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'my-own-linter' }] }
			]
		}
	};

	const merged = mergeHooks(existing, 'dev-stream hook');

	// This file belongs to the user; we are a guest in it.
	assertEquals(merged.model, 'opus');
	const commands = merged.hooks!.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command));
	assert(commands.includes('my-own-linter'), 'clobbered the user’s hook');
	assert(commands.includes('dev-stream hook'));
});

Deno.test('re-running init updates our entry instead of stacking a second one', () => {
	// The upgrade path: the binary moved, so the command string changes.
	const once = mergeHooks({}, '/old/path/dev-stream hook');
	const twice = mergeHooks(once, '/new/path/dev-stream hook');

	const commands = twice.hooks!.Stop.flatMap((e) => e.hooks.map((h) => h.command));
	assertEquals(commands, ['/new/path/dev-stream hook']); // exactly one, and it's current
});

Deno.test('hooks carry a timeout so they can never hang a Claude session', () => {
	const merged = mergeHooks({}, 'dev-stream hook');
	for (const entries of Object.values(merged.hooks!)) {
		for (const entry of entries) {
			for (const hook of entry.hooks) assert(typeof hook.timeout === 'number');
		}
	}
});
