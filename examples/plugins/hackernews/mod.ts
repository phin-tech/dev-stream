/**
 * Hacker News source plugin — the reference example.
 *
 * Deliberately zero-auth and self-contained (no imports at all), so it shows
 * the plugin contract with nothing else in the way. It polls Algolia's HN
 * search API for new stories since the cursor, optionally filtered by query
 * and score.
 *
 * The sandbox this runs in can reach `hn.algolia.com` (declared in
 * manifest.json) and nothing else: no filesystem, no env, no subprocesses.
 */

interface Hit {
	objectID: string;
	title: string;
	url: string | null;
	author: string;
	created_at: string;
	points: number | null;
	num_comments: number | null;
}

interface PollContext {
	config: Record<string, unknown>;
	cursor: string | null;
}

export async function poll({ config, cursor }: PollContext) {
	const query = String(config.query ?? '').trim();
	const minPoints = Number.parseInt(String(config.min_points ?? ''), 10);

	// First poll: last 24h, not all of Hacker News.
	const since = cursor ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);

	const params = new URLSearchParams({
		tags: 'story',
		hitsPerPage: '30',
		numericFilters: `created_at_i>${sinceEpoch}`
	});
	if (query) params.set('query', query);

	const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${params}`, {
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`Hacker News search returned ${res.status}`);
	}

	const body = (await res.json()) as { hits?: Hit[] };
	const hits = (body.hits ?? []).filter(
		(hit) => hit.title && (Number.isNaN(minPoints) || (hit.points ?? 0) >= minPoints)
	);

	let watermark = cursor;
	const posts = hits.map((hit) => {
		if (!watermark || hit.created_at > watermark) watermark = hit.created_at;

		const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
		return {
			source: 'hackernews',
			kind: 'event',
			title: hit.title,
			ts: hit.created_at,
			tags: ['hackernews', ...(query ? [query.toLowerCase()] : [])],
			meta: {
				url: hit.url ?? discussion,
				author: hit.author,
				links: [
					...(hit.url ? [{ label: 'Story', url: hit.url }] : []),
					{ label: `HN (${hit.num_comments ?? 0} comments)`, url: discussion }
				]
			},
			// Identity only (no version half): re-seeing the same story inside the
			// dedupe window updates its card rather than duplicating it.
			dedupe_key: `hackernews:${hit.objectID}`
		};
	});

	return { posts, cursor: watermark };
}
