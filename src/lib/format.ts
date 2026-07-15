/** Small presentation helpers shared by the feed's cards. */

/**
 * "just now", "4m", "3h", "2d", then a date.
 *
 * A timeline is read by scanning, so recency wants to be a glance, not a parse.
 * The absolute timestamp is still available as the element's `title`.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;

	const seconds = Math.round((now - then) / 1000);
	// Clock skew, or a post dated in the future by a client. Don't render "-3m".
	if (seconds < 0) return 'just now';
	if (seconds < 45) return 'just now';
	if (seconds < 90) return '1m';

	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;

	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;

	return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function absoluteTime(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then) ? iso : new Date(then).toLocaleString();
}

/** A stable per-day key (local time), for deciding where a daymark falls. */
export function dayKey(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;
	const d = new Date(then);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * A day heading for the time-rail: "Today", "Yesterday", then a date.
 *
 * The rail is a literal timeline; these punctuate it so a long scroll keeps its
 * bearings without every card repeating the date.
 */
export function dayLabel(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;

	if (dayKey(iso) === dayKey(new Date(now).toISOString())) return 'Today';
	if (dayKey(iso) === dayKey(new Date(now - 86_400_000).toISOString())) return 'Yesterday';

	const d = new Date(then);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric'
	});
}

/**
 * A stable colour per source slug.
 *
 * Sources are free-form -- anything can invent one -- so there is no fixed palette
 * to look them up in. Hashing the slug means "claude-code" is the same colour on
 * every machine and every launch, without anyone configuring anything.
 */
export function sourceColor(source: string): string {
	let hash = 0;
	for (let i = 0; i < source.length; i++) {
		hash = (hash * 31 + source.charCodeAt(i)) | 0;
	}
	// Fixed saturation/lightness so every source is legible against the card
	// background; only the hue varies.
	return `hsl(${Math.abs(hash) % 360} 55% 55%)`;
}

/** Kinds that deserve to stand out in a scan, and how they should read. */
export const KIND_TONE: Record<string, 'alert' | 'accent' | 'muted'> = {
	alert: 'alert',
	pr: 'accent',
	issue: 'accent',
	note: 'muted'
};
