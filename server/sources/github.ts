/**
 * GitHub source worker.
 *
 * Polls the notifications API rather than the events API, because notifications
 * are already "things GitHub decided you care about" — reviews requested of you,
 * replies on your PRs, failing checks on your branches. The events firehose would
 * mostly be other people's noise.
 *
 * Webhooks are out of scope for V1: this app lives on localhost with no public
 * URL, so polling is the only option that works without a tunnel.
 */

import type { PostInput } from '../../src/shared/types.ts';
import type { PollContext, PollResult, SourceWorker } from './types.ts';

/** GitHub asks for 60s minimum on the notifications endpoint; honour it. */
const INTERVAL_MS = 60_000;

/** One page is plenty for a personal timeline, and bounds a first-run backfill. */
const PER_PAGE = 50;

interface Notification {
	id: string;
	updated_at: string;
	reason: string;
	repository: { full_name: string };
	subject: { title: string; url: string | null; type: string };
}

/** Extra detail fetched per item, so cards can show state rather than just a title. */
interface Subject {
	number?: number;
	html_url?: string;
	state?: string;
	merged?: boolean;
	draft?: boolean;
	user?: { login?: string };
	assignees?: { login?: string }[];
}

/**
 * `api.github.com/repos/o/r/pulls/12` -> `github.com/o/r/pull/12`.
 *
 * Used only as a fallback: we prefer the `html_url` GitHub gives us on the
 * subject, and fall back to rewriting when the subject fetch failed.
 */
export function toHtmlUrl(apiUrl: string | null): string | undefined {
	if (!apiUrl) return undefined;
	try {
		const url = new URL(apiUrl);
		if (!url.hostname.endsWith('github.com')) return undefined;
		const path = url.pathname
			.replace(/^\/repos\//, '/')
			.replace(/\/pulls\//, '/pull/')
			.replace(/\/issues\//, '/issues/');
		return `https://github.com${path}`;
	} catch {
		return undefined;
	}
}

/** The timeline's vocabulary, not GitHub's. */
function toKind(subjectType: string): string {
	switch (subjectType) {
		case 'PullRequest':
			return 'pr';
		case 'Issue':
			return 'issue';
		case 'CheckSuite':
			return 'alert'; // a failing build is the thing you most want to notice
		default:
			return 'event';
	}
}

/** A short past-tense line, so the feed reads like activity. */
function describe(notification: Notification, subject: Subject | null): string {
	const { title, type } = notification.subject;
	const number = subject?.number ? `#${subject.number} ` : '';

	if (type === 'PullRequest') {
		if (subject?.merged) return `Merged PR ${number}${title}`;
		if (subject?.state === 'closed') return `Closed PR ${number}${title}`;
		if (notification.reason === 'review_requested') return `Review requested: ${number}${title}`;
		return `PR ${number}${title}`;
	}
	if (type === 'Issue') {
		if (subject?.state === 'closed') return `Closed issue ${number}${title}`;
		return `Issue ${number}${title}`;
	}
	if (type === 'CheckSuite') return `Checks: ${title}`;
	return title;
}

async function request<T>(
	url: string,
	token: string,
	signal?: AbortSignal
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
	const res = await fetch(url, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'dev-stream'
		},
		signal
	});

	if (!res.ok) {
		// text(), not json() — an error page may not be JSON at all, and reading the
		// body then also cancelling it throws "Cannot cancel a locked ReadableStream",
		// turning a clean 401 into a confusing crash.
		const raw = await res.text().catch(() => '');
		let message = raw.slice(0, 200);
		try {
			message = (JSON.parse(raw) as { message?: string }).message ?? message;
		} catch {
			// not JSON; the raw text is the best we have
		}
		return { ok: false, status: res.status, message: message || res.statusText };
	}
	return { ok: true, data: (await res.json()) as T };
}

export const github: SourceWorker = {
	slug: 'github',
	label: 'GitHub',
	defaultIntervalMs: INTERVAL_MS,
	configFields: [
		{
			key: 'token',
			label: 'Personal access token',
			secret: true,
			placeholder: 'ghp_…',
			help: 'Needs the `notifications` and `repo` scopes.'
		},
		{
			key: 'repos',
			label: 'Repos (optional)',
			placeholder: 'owner/name, owner/other',
			help: 'Comma-separated. Leave empty to follow every notification.'
		}
	],

	async poll({ config, cursor }: PollContext): Promise<PollResult> {
		const token = typeof config.token === 'string' ? config.token.trim() : '';
		if (!token) throw new Error('no personal access token configured');

		const base = typeof config.api_base === 'string' ? config.api_base : 'https://api.github.com';

		const repos = String(config.repos ?? '')
			.split(',')
			.map((r) => r.trim())
			.filter(Boolean);

		const params = new URLSearchParams({ per_page: String(PER_PAGE) });
		// On the very first poll there is no watermark. Ask for the last 24h rather
		// than everything, or enabling the integration dumps a year of backlog into
		// the middle of the user's timeline.
		params.set('since', cursor ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

		const result = await request<Notification[]>(
			`${base}/notifications?${params}`,
			token,
			AbortSignal.timeout(15_000)
		);
		if (!result.ok) {
			throw new Error(
				result.status === 401
					? 'GitHub rejected the token (401). Check it has the `notifications` scope.'
					: `GitHub returned ${result.status}: ${result.message}`
			);
		}

		const notifications = repos.length
			? result.data.filter((n) => repos.includes(n.repository.full_name))
			: result.data;

		const posts: PostInput[] = [];
		let watermark = cursor;

		for (const notification of notifications) {
			// Fetched per item so a card can show state (merged? closed? by whom?)
			// rather than just a title. Genuinely not fatal: the try/catch is what
			// makes that true, since a network failure would otherwise reject out of
			// the whole poll and lose every other notification in this batch.
			let subject: Subject | null = null;
			if (notification.subject.url) {
				try {
					const detail = await request<Subject>(notification.subject.url, token);
					if (detail.ok) subject = detail.data;
				} catch (err) {
					console.error(`[github] could not fetch ${notification.subject.url}: ${err}`);
				}
			}

			const meta: Record<string, unknown> = {
				repo: notification.repository.full_name,
				reason: notification.reason
			};
			const url = subject?.html_url ?? toHtmlUrl(notification.subject.url);
			if (url) meta.url = url;
			if (subject?.number) meta.number = subject.number;
			if (subject?.user?.login) meta.author = subject.user.login;
			if (subject?.assignees?.length) {
				meta.assignees = subject.assignees.map((a) => a.login).filter(Boolean);
			}
			// A state the card can badge. `merged` is not a GitHub state, but it is
			// the distinction a human actually cares about.
			if (subject?.merged) meta.state = 'merged';
			else if (subject?.draft) meta.state = 'draft';
			else if (subject?.state) meta.state = subject.state;

			posts.push({
				source: 'github',
				kind: toKind(notification.subject.type),
				title: describe(notification, subject),
				ts: notification.updated_at,
				tags: ['github', notification.reason.replace(/_/g, '-')],
				meta,
				// Identity + version. The same thread re-notifying with the SAME
				// updated_at is the same event -- that happens whenever the cursor
				// boundary is inclusive, which GitHub's `since` is -- so re-polling
				// updates the card instead of duplicating it. A genuinely new update
				// carries a new updated_at, and so becomes a new card.
				dedupe_key: `github:${notification.id}:${notification.updated_at}`
			});

			if (!watermark || notification.updated_at > watermark) {
				watermark = notification.updated_at;
			}
		}

		return { posts, cursor: watermark };
	}
};
