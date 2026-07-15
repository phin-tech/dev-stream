/**
 * The source-worker contract.
 *
 * A "source worker" is just a privileged client of the same ingestion path
 * everything else uses: it produces `PostInput`s and hands them to the same
 * validate-dedupe-broadcast code the HTTP API calls. It gets no special access to
 * the database, which is why adding one is cheap and why a bug in one cannot
 * corrupt the timeline.
 */

import type { PostInput } from '../../src/shared/types.ts';

/** One credential or option the settings UI should collect for a worker. */
export interface ConfigField {
	key: string;
	label: string;
	/** Never sent back to the client once stored; the UI shows "configured". */
	secret?: boolean;
	placeholder?: string;
	help?: string;
}

export interface PollContext {
	config: Record<string, unknown>;
	/**
	 * Where the last poll got to — an ISO timestamp watermark.
	 *
	 * Persisted, so a restart doesn't re-import everything (or miss what happened
	 * while the app was closed).
	 */
	cursor: string | null;
}

export interface PollResult {
	posts: PostInput[];
	/** The new watermark. Return the old cursor to leave it untouched. */
	cursor: string | null;
}

export interface SourceWorker {
	/** The `source` slug its posts carry, e.g. "github". */
	slug: string;
	label: string;
	defaultIntervalMs: number;
	configFields: ConfigField[];
	/**
	 * Fetch what's new since `cursor`.
	 *
	 * Throwing is fine and expected — a bad token, a rate limit, an outage. The
	 * runner records the error, surfaces it in the UI, and tries again next tick;
	 * it does not disable the source, because a transient 502 should not require
	 * the user to go and switch it back on.
	 */
	poll(ctx: PollContext): Promise<PollResult>;
}

/** What the settings page renders. Deliberately carries no secrets. */
export interface SourceStatus {
	slug: string;
	label: string;
	enabled: boolean;
	/** True when every required secret has a stored value. */
	configured: boolean;
	fields: ConfigField[];
	/** Non-secret config values only. */
	config: Record<string, unknown>;
	cursor: string | null;
	last_error: string | null;
	last_polled_at: string | null;
}
