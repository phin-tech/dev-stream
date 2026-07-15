/**
 * Linear source worker.
 *
 * Polls issues by `updatedAt`, which is both the cursor and the natural unit of
 * "something happened": a status change, an assignment, a comment all bump it.
 */

import type { PostInput } from '../../src/shared/types.ts';
import type { PollContext, PollResult, SourceWorker } from './types.ts';

const INTERVAL_MS = 120_000;
const PAGE_SIZE = 50;

const QUERY = `
	query DevStream($since: DateTimeOrDuration!, $first: Int!) {
		issues(
			filter: { updatedAt: { gt: $since } }
			first: $first
			orderBy: updatedAt
		) {
			nodes {
				id
				identifier
				title
				url
				updatedAt
				priority
				state { name type }
				assignee { displayName }
				team { key name }
				project { name }
			}
		}
	}
`;

interface Issue {
	id: string;
	identifier: string;
	title: string;
	url: string;
	updatedAt: string;
	priority?: number;
	state?: { name?: string; type?: string };
	assignee?: { displayName?: string } | null;
	team?: { key?: string; name?: string } | null;
	project?: { name?: string } | null;
}

interface GraphQLResponse {
	data?: { issues?: { nodes?: Issue[] } };
	errors?: { message: string }[];
}

/**
 * Linear's state *type* is the stable enum (`started`, `completed`, `canceled`);
 * the state *name* is whatever the team renamed it to ("In Review", "Shipped").
 * Show the name, but reason about the type.
 */
function describe(issue: Issue): string {
	const state = issue.state?.type;
	const label = `${issue.identifier}: ${issue.title}`;

	if (state === 'completed') return `Completed ${label}`;
	if (state === 'canceled') return `Cancelled ${label}`;
	if (state === 'started') return `Started ${label}`;
	return label;
}

export const linear: SourceWorker = {
	slug: 'linear',
	label: 'Linear',
	defaultIntervalMs: INTERVAL_MS,
	configFields: [
		{
			key: 'api_key',
			label: 'API key',
			secret: true,
			placeholder: 'lin_api_…',
			help: 'Linear → Settings → API → Personal API keys.'
		},
		{
			key: 'teams',
			label: 'Teams (optional)',
			placeholder: 'ENG, DES',
			help: 'Comma-separated team keys. Leave empty to follow every team.'
		}
	],

	async poll({ config, cursor }: PollContext): Promise<PollResult> {
		const key = typeof config.api_key === 'string' ? config.api_key.trim() : '';
		if (!key) throw new Error('no API key configured');

		const endpoint =
			typeof config.api_base === 'string' ? config.api_base : 'https://api.linear.app/graphql';

		const teams = String(config.teams ?? '')
			.split(',')
			.map((t) => t.trim().toUpperCase())
			.filter(Boolean);

		// Same reasoning as GitHub: a first poll with no watermark should not
		// import the team's entire history into the middle of the timeline.
		const since = cursor ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		const res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				// Linear personal API keys go in Authorization *without* a Bearer
				// prefix. With one, it 400s in a way that looks like a bad query.
				authorization: key,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ query: QUERY, variables: { since, first: PAGE_SIZE } }),
			signal: AbortSignal.timeout(15_000)
		});

		if (!res.ok) {
			await res.body?.cancel();
			throw new Error(
				res.status === 401 || res.status === 400
					? `Linear rejected the API key (${res.status}).`
					: `Linear returned ${res.status}.`
			);
		}

		const body = (await res.json()) as GraphQLResponse;
		// GraphQL answers 200 with an `errors` array, so a non-ok status is not the
		// only failure mode -- and silently returning zero posts would look like
		// "nothing happened" rather than "your key is wrong".
		if (body.errors?.length) {
			throw new Error(`Linear: ${body.errors.map((e) => e.message).join('; ')}`);
		}

		const issues = body.data?.issues?.nodes ?? [];
		const filtered = teams.length
			? issues.filter((i) => i.team?.key && teams.includes(i.team.key.toUpperCase()))
			: issues;

		const posts: PostInput[] = [];
		let watermark = cursor;

		for (const issue of filtered) {
			const meta: Record<string, unknown> = { url: issue.url };
			if (issue.project?.name) meta.project = issue.project.name;
			if (issue.team?.key) meta.team = issue.team.key;
			if (issue.assignee?.displayName) meta.author = issue.assignee.displayName;
			if (issue.state?.name) meta.state = issue.state.name;
			if (issue.state?.type) meta.state_type = issue.state.type;
			meta.identifier = issue.identifier;

			posts.push({
				source: 'linear',
				kind: 'issue',
				title: describe(issue),
				ts: issue.updatedAt,
				tags: ['linear', ...(issue.team?.key ? [issue.team.key.toLowerCase()] : [])],
				meta,
				// Identity + version, exactly as with GitHub: re-polling the boundary
				// item updates its card; a real change makes a new one.
				dedupe_key: `linear:${issue.id}:${issue.updatedAt}`
			});

			if (!watermark || issue.updatedAt > watermark) watermark = issue.updatedAt;
		}

		return { posts, cursor: watermark };
	}
};
