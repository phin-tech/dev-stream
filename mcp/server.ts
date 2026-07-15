/**
 * `dev-stream mcp` — a stdio MCP server over the local timeline.
 *
 * This is what makes the timeline agent-native. It is deliberately a *client* of
 * the same HTTP API as everything else, not a second path into the database:
 * posts made by an agent get the same validation, dedupe and SSE broadcast as a
 * post from curl, and the app doesn't have to be taught about MCP at all.
 *
 * Install: claude mcp add dev-stream -- dev-stream mcp
 */

// The `.js` suffix is required at RUNTIME (it is a real file under the SDK's
// `./*` wildcard export), but Deno's *type* resolver won't follow it to the
// adjacent .d.ts -- SDK 1.29 dropped the explicit `./server/mcp.js` export entry
// that used to carry the types. Dropping the suffix flips the problem: it
// type-checks and then fails to resolve at runtime. So: keep the suffix, and
// point the type resolver at the declarations by hand.
// @deno-types="../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts"
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// @deno-types="../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts"
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Post, PostPage, ViewWithUnread } from '../src/shared/types.ts';
import { APP_VERSION } from '../server/paths.ts';
import { discover, post as deliver } from '../cli/client.ts';

/** Agents ask open questions; without a ceiling one could pull the whole DB. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** A tool result. MCP wants content blocks; `isError` marks a failure to the model. */
const text = (body: string, isError = false) => ({
	content: [{ type: 'text' as const, text: body }],
	...(isError ? { isError: true } : {})
});

async function api<T>(path: string): Promise<T> {
	const config = await discover();
	if (!config) {
		throw new Error(
			'dev-stream is not running. Start the app — reads need the server, unlike posts, which spool.'
		);
	}

	const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
		headers: { authorization: `Bearer ${config.token}` }
	});
	if (!res.ok) {
		const detail = await res
			.json()
			.then((b: { error?: string }) => b.error)
			.catch(() => '');
		throw new Error(detail || `request failed with ${res.status}`);
	}
	return (await res.json()) as T;
}

/**
 * Renders posts for a model to read.
 *
 * Deliberately compact prose rather than raw JSON: an agent asking "what did I
 * ship this week?" wants to read the answer, and dumping full post objects with
 * ULIDs and every meta key burns context to no benefit.
 */
function renderPosts(posts: Post[]): string {
	if (posts.length === 0) return 'No posts matched.';

	return posts
		.map((p) => {
			const when = p.ts.replace('T', ' ').replace(/\..*/, 'Z');
			const where = [p.meta.project, p.meta.repo].filter(Boolean).join(' · ');
			const tags = p.tags.map((t) => `#${t}`).join(' ');
			const head = `[${when}] (${p.source}${p.kind !== 'event' ? `/${p.kind}` : ''}) ${p.title}`;
			const detail = [where, tags].filter(Boolean).join('  ');

			return [head, detail && `    ${detail}`, p.body && `    ${p.body.replace(/\n/g, '\n    ')}`]
				.filter(Boolean)
				.join('\n');
		})
		.join('\n\n');
}

/** The filter dimensions, shared by the search and view tools. */
const filterShape = {
	source: z.array(z.string()).optional().describe('Origin slugs, e.g. ["claude-code", "ci"].'),
	project: z.array(z.string()).optional(),
	repo: z.array(z.string()).optional().describe('e.g. ["phin-tech/dev-stream"].'),
	kind: z.array(z.string()).optional().describe('event | note | alert | pr | issue'),
	tag: z.array(z.string()).optional().describe('A post must carry ALL of these tags.'),
	since: z.string().optional().describe('ISO-8601. Inclusive lower bound on event time.'),
	until: z.string().optional().describe('ISO-8601. Inclusive upper bound on event time.')
};

function toQuery(filter: Record<string, unknown>, limit?: number): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filter)) {
		if (value === undefined || value === null) continue;
		for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
	}
	if (limit) params.set('limit', String(Math.min(limit, MAX_LIMIT)));
	return params.toString() ? `?${params}` : '';
}

export function createMcpServer(): McpServer {
	const server = new McpServer({ name: 'dev-stream', version: APP_VERSION });

	server.registerTool(
		'post_to_timeline',
		{
			title: 'Post to the dev-stream timeline',
			description:
				'Add an entry to the user\'s local activity timeline. Use this to record something ' +
				'notable you did or found — a deploy, a fix, a decision, a warning worth surfacing. ' +
				'If the app is not running the post is spooled and appears when it next starts, so ' +
				'this never fails for being offline.',
			inputSchema: {
				title: z.string().describe('One line, in past tense. This is the card headline.'),
				body: z.string().optional().describe('Optional markdown detail.'),
				kind: z
					.enum(['event', 'note', 'alert', 'pr', 'issue'])
					.optional()
					.describe('alert stands out visually. Defaults to event.'),
				tags: z.array(z.string()).optional(),
				project: z.string().optional(),
				repo: z.string().optional().describe('owner/name'),
				source: z
					.string()
					.optional()
					.describe('Origin slug. Defaults to "agent" — override to attribute it elsewhere.'),
				dedupe_key: z
					.string()
					.optional()
					.describe('Re-posting the same key within 10 minutes updates that card instead of adding one.')
			}
		},
		async (args) => {
			const meta: Record<string, unknown> = {};
			if (args.project) meta.project = args.project;
			if (args.repo) meta.repo = args.repo;

			try {
				const delivery = await deliver([
					{
						source: args.source ?? 'agent',
						kind: args.kind ?? 'event',
						title: args.title,
						body: args.body,
						tags: args.tags ?? [],
						meta,
						dedupe_key: args.dedupe_key
					}
				]);

				return text(
					delivery.via === 'api'
						? 'Posted to the timeline.'
						: 'dev-stream is not running; the post was spooled and will appear when it starts.'
				);
			} catch (err) {
				return text(`Could not post: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	server.registerTool(
		'search_timeline',
		{
			title: 'Search the dev-stream timeline',
			description:
				"Read the user's activity timeline: what they shipped, what broke, what Claude did, " +
				'what happened in a repo. Combine full-text `query` with filters; everything is ANDed. ' +
				'Results are newest-first.',
			inputSchema: {
				query: z.string().optional().describe('Full-text search over title, body and tags.'),
				...filterShape,
				limit: z.number().int().positive().optional().describe(`Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`)
			}
		},
		async ({ query, limit, ...filter }) => {
			try {
				const qs = toQuery({ ...filter, q: query }, limit ?? DEFAULT_LIMIT);
				const page = await api<PostPage>(`/api/posts${qs}`);
				return text(renderPosts(page.posts));
			} catch (err) {
				return text(`Could not search: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	server.registerTool(
		'list_views',
		{
			title: 'List saved dev-stream views',
			description:
				'The filters the user has saved and named. Useful for discovering what they care ' +
				'about before searching — a view named "Deploys" tells you how they think about their work.',
			inputSchema: {}
		},
		async () => {
			try {
				const { views } = await api<{ views: ViewWithUnread[] }>('/api/views');
				if (views.length === 0) return text('No saved views.');

				return text(
					views
						.map((v) => {
							const filter = JSON.stringify(v.filter);
							const unread = v.unread > 0 ? ` — ${v.unread} unread` : '';
							return `${v.name}${v.pinned ? ' (pinned)' : ''}: ${filter}${unread}`;
						})
						.join('\n')
				);
			} catch (err) {
				return text(`Could not list views: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	server.registerTool(
		'get_view_posts',
		{
			title: 'Read the posts in a saved view',
			description: 'Runs a saved view by name and returns its posts, newest first.',
			inputSchema: {
				view: z.string().describe('The view name, as returned by list_views.'),
				limit: z.number().int().positive().optional().describe(`Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`)
			}
		},
		async ({ view, limit }) => {
			try {
				const { views } = await api<{ views: ViewWithUnread[] }>('/api/views');
				// Case-insensitive: the model is repeating a name a human chose, and
				// failing on capitalization would be a needlessly sharp edge.
				const match = views.find((v) => v.name.toLowerCase() === view.toLowerCase());
				if (!match) {
					const names = views.map((v) => v.name).join(', ') || 'none';
					return text(`No view named "${view}". Available: ${names}`, true);
				}

				// A view IS a filter, so running it is the same query as any other.
				const qs = toQuery({ ...match.filter }, limit ?? DEFAULT_LIMIT);
				const page = await api<PostPage>(`/api/posts${qs}`);
				return text(renderPosts(page.posts));
			} catch (err) {
				return text(`Could not read the view: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	return server;
}

/** Starts the server on stdio. Blocks until the client disconnects. */
export async function runMcpServer(): Promise<void> {
	// stdout is the MCP transport: a stray console.log would corrupt the protocol
	// stream. Anything diagnostic must go to stderr.
	const server = createMcpServer();
	await server.connect(new StdioServerTransport());
}
