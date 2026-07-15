/**
 * Markdown rendering for post bodies.
 *
 * Post bodies are UNTRUSTED. Anything on the machine can POST to the local API --
 * that is the product's whole premise -- so a body could contain a `<script>` or
 * an `onerror=` handler, and rendering it with {@html} would execute it inside a
 * webview that holds the API token and OS-level bindings. Every body goes through
 * DOMPurify; nothing reaches {@html} that hasn't.
 */

import { browser } from '$app/environment';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
	gfm: true,
	// Post bodies are log lines and hook output as often as they are prose; a lone
	// newline should show up as one.
	breaks: true
});

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Markdown -> sanitized HTML, safe to hand to `{@html}`. */
export function renderMarkdown(md: string): string {
	// DOMPurify needs a real DOM. SSR is disabled app-wide (see +layout.ts) so
	// this shouldn't happen -- but the failure mode if it ever did would be
	// serving unsanitized HTML, so degrade to escaped plain text instead.
	if (!browser) return escapeHtml(md);

	const html = marked.parse(md, { async: false }) as string;

	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [
			'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
			'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
			'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'
		],
		ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
		// http(s) and images only. Blocks `javascript:` hrefs, and `data:` URLs,
		// which can carry an SVG with script in it.
		ALLOWED_URI_REGEXP: /^https?:\/\//i,
		// Defence in depth: DOMPurify strips these anyway, but a body that somehow
		// smuggled one through would be executing in a privileged context.
		FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
		FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick']
	});
}
