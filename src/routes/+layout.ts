/**
 * SSR is off for the whole app, deliberately.
 *
 * Every page depends on things that only exist inside the webview: the `bindings`
 * global (a ReferenceError on the server), the API token it hands back, and
 * `EventSource`. There is also nothing to gain -- this is a local desktop window,
 * not a site with a first-paint budget or a crawler to satisfy.
 *
 * The SvelteKit server still serves the shell; it just doesn't try to render
 * pages that cannot exist outside the window.
 */
export const ssr = false;
export const prerender = false;
