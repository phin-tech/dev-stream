/**
 * dev-stream desktop entrypoint.
 *
 * `deno desktop .` with no script auto-detects SvelteKit and runs its build
 * output, but that mode gives you nowhere to hang `win.bind()` handlers or a
 * second `Deno.serve()`. The docs' escape hatch is to pass an explicit script and
 * "import and start the framework yourself" -- this file. It composes three
 * things:
 *
 *   1. The SvelteKit server (Deno Deploy adapter build output in .deno-deploy/).
 *   2. The window, plus the bindings the UI needs from the OS side.
 *   3. The dev-stream backend: SQLite, the ingestion API, SSE (see server/).
 *
 * Run: `deno task desktop`  (npm run build && deno desktop main.ts)
 */

// Local, not @std: any remote import in the desktop graph silently kills
// win.bind(). See the header of server/vendored.ts.
import { dirname, fromFileUrl, resolve } from './server/vendored.ts';
// NOTE: ./server/serve.ts is NOT imported here. It reaches node:sqlite, whose mere
// evaluation kills win.bind() — it is loaded lazily further down, after the binds.
// The modules below are safe: none of them touch node:sqlite or a jsr: specifier.
import { diag, diagReset } from './server/diag.ts';
import { findRunningInstance, focusRunningInstance } from './server/instance.ts';
import { readOrCreateToken } from './server/config.ts';
import { createDesktopHandler } from './server/desktop_config.ts';
import { dbPath, home } from './server/paths.ts';
import type { ApiConfig } from './src/shared/types.ts';

// TEMPORARY: trace the win.bind() "No callback bound" bug. See server/diag.ts.
diagReset();
diag('main.ts module body START (all static imports above are now evaluated)');

// Nothing about `deno desktop`'s failure modes for a custom entrypoint is
// well-documented, and a throw in here otherwise surfaces as a blank window with
// no console output. Shout about everything.
globalThis.addEventListener('error', (e) => {
	console.error('[main] uncaught error:', e.error ?? e.message);
});
globalThis.addEventListener('unhandledrejection', (e) => {
	console.error('[main] unhandled rejection:', e.reason);
});

// --- Single-instance guard -------------------------------------------------
// Before we take a port or touch the database, ask whoever is on the recorded
// port whether they're already us. Two instances writing one SQLite file and
// racing for 4517 is the failure this avoids.
const running = await findRunningInstance();
if (running) {
	console.log(`[main] dev-stream is already running (pid ${running.info.pid}); focusing it`);
	await focusRunningInstance(running.port, await readOrCreateToken());
	Deno.exit(0);
}


// ═══════════════════════════════════════════════════════════════════════════
// ORDER IS LOAD-BEARING. Bind FIRST. Touch the database LAST.
//
// On Deno 2.9.2, `win.bind()` silently fails to register if certain modules have
// already been EVALUATED in the isolate. Every call from the page then rejects
// with "No callback bound for: <name>" — the binding looks registered, the window
// is the right one (executeJs reaches the very page that is failing), and the
// dispatcher simply never finds the callback.
//
// Bisected against the real app:
//
//   window + bind + Deno.serve, nothing else ............ bindings WORK
//   + `import "node:sqlite"` (even unused) ............... bindings BROKEN
//   + a `jsr:` import (even unused) ...................... bindings BROKEN
//   + an `npm:` import .................................. bindings WORK
//   + the SvelteKit handler (.deno-deploy) .............. bindings WORK
//   bind FIRST, then load node:sqlite lazily ............ bindings WORK  ← this
//
// (Related: denoland/deno#35647. Its fix, #35654, is listed in the 2.9.2
// changelog but is demonstrably not effective — the upstream repro still fails
// on 2.9.2. `"vendor": true` does not help either.)
//
// Two consequences, and BOTH are required:
//
//   1. This file, and everything it imports STATICALLY, must stay free of `jsr:`
//      and `node:sqlite`. That is why the path/hex/ulid helpers come from
//      ./server/vendored.ts instead of @std — see that file's header.
//
//   2. The backend (which does `import { DatabaseSync } from "node:sqlite"`) is
//      loaded through an opaque dynamic import below. The desktop build explicitly
//      includes `server/`, so the bundled app can still load it at runtime.
//
// Revisit all of this when `deno desktop` fixes the bug; it is the only reason
// the startup sequence is shaped this way.
// ═══════════════════════════════════════════════════════════════════════════

let resolveConfig: (config: ApiConfig) => void;
const apiConfig = new Promise<ApiConfig>((resolve) => {
	resolveConfig = resolve;
});

// The SvelteKit build output is loaded through a COMPUTED specifier, which
// TypeScript cannot follow -- and that is the point.
//
// `.deno-deploy/handler.ts` imports SvelteKit's bundled server JS, which carries
// JSDoc types like `@type {import('./promise.js').PromiseWithResolvers}` pointing
// at source files the bundler never emitted. A static import drags all of that
// into the type graph and `deno desktop` (which type-checks its entrypoint)
// refuses to launch with 13 TS2307s in generated code we do not own. Hiding the
// specifier keeps the check honest about OUR code -- notably it still checks the
// win.bind() calls against lib.deno.desktop -- while ignoring the bundle.
//
// The cost: `deno compile` can no longer see this dependency statically, so the
// compiled app must be built with `--include .deno-deploy` (see `deno task
// build:app`). If the app ever launches to a blank window, that flag is the
// first thing to check.
const deployDir = new URL('./.deno-deploy/', import.meta.url);

type PrepareServer = (
	svelteData: unknown,
	deployConfig: unknown,
	cwd: string
) => Deno.ServeHandler;

diag('all binds registered; about to dynamic-import .deno-deploy handler');
const [{ default: rawDeployConfig }, { default: rawSvelteData }, { prepareServer }] = (await Promise.all([
	import(new URL('deploy.json', deployDir).href, { with: { type: 'json' } }),
	import(new URL('svelte.json', deployDir).href, { with: { type: 'json' } }),
	import(new URL('handler.ts', deployDir).href)
])) as [{ default: unknown }, { default: unknown }, { prepareServer: PrepareServer }];

// NOT Deno.cwd(). This is the root SvelteKit resolves its static assets against
// (`<root>/.deno-deploy/static/...`), and the working directory is not ours to
// assume: launching the bundle from Finder or with `open` gives the process a cwd
// of `/`, so every CSS and JS asset 404s and the window paints blank while the
// HTML itself — which is embedded in the server bundle, not read from disk —
// still returns 200. It only works when run from a terminal sitting in the repo.
//
// import.meta.url is stable in both worlds: the project directory when run from
// source, and the embedded VFS root inside the compiled app.
const appRoot = dirname(fromFileUrl(import.meta.url));

diag('.deno-deploy handler imported; calling prepareServer');
const svelteHandler = prepareServer(rawSvelteData, rawDeployConfig, appRoot);
diag('svelteHandler ready');

// Every binding is registered by this point. Only NOW is it safe to bring in the
// backend, whose `node:sqlite` import would have killed them all had it been
// evaluated first (see the block comment above).
//
// The SvelteKit server must also be the FIRST Deno.serve() in the process: inside
// `deno desktop` the first call is hijacked to the runtime's own port (via
// DENO_SERVE_ADDRESS) and ignores whatever you pass. The startup window navigates
// there once the listener is ready. The API's own Deno.serve(), inside
// startBackend(), is therefore the second, and gets the port it actually asks for.
diag('calling Deno.serve(desktopHandler) — first serve, hijacked to runtime port');
Deno.serve(createDesktopHandler(svelteHandler, apiConfig));
diag('Deno.serve returned');

diag('creating BrowserWindow');
const win = new Deno.BrowserWindow({ title: 'dev-stream', width: 1100, height: 800 });
diag('BrowserWindow created');

diag('about to win.bind("openExternal")');
win.bind('openExternal', async (url: unknown) => {
	if (typeof url !== 'string') return { ok: false, error: 'a url is required' };

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, error: 'not a valid url' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, error: `refusing to open a ${parsed.protocol} url` };
	}

	try {
		const { success } = await new Deno.Command('open', { args: [parsed.href] }).output();
		return { ok: success };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
});

diag('about to win.bind("revealInFinder")');
win.bind('revealInFinder', async (path: unknown) => {
	if (typeof path !== 'string' || !path) return { ok: false, error: 'a path is required' };

	const resolved = resolve(path);
	if (resolved !== resolve(dbPath()) && !resolved.startsWith(resolve(home()) + '/')) {
		return { ok: false, error: 'refusing to reveal a path outside ~/.dev-stream' };
	}

	try {
		const command = new Deno.Command('open', { args: ['-R', resolved] });
		const { success } = await command.output();
		return { ok: success };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
});

// Keep node:sqlite out of the desktop entrypoint's statically analyzed graph.
diag('about to dynamic-import ./server/serve.ts (pulls node:sqlite)');
const backendModule = './server/serve.ts';
const { startBackend } = await import(backendModule);
diag('serve.ts imported; calling startBackend');

const backend = await startBackend({
	// A second launch POSTs /api/window/focus instead of opening a duplicate.
	onFocusRequest: () => win.focus(),
	async openExternal(url: string) {
		const { success, stderr } = await new Deno.Command('open', { args: [url] }).output();
		if (!success) throw new Error(new TextDecoder().decode(stderr) || 'macOS could not open the URL');
	}
});
diag('startBackend resolved');

resolveConfig!(backend.config);
diag('apiConfig promise resolved with backend config');

console.log(`[main] dev-stream ready -- API on http://127.0.0.1:${backend.config.port}`);

// ═══ TEMPORARY diagnostic probe (delete with server/diag.ts) ═══════════════
// Runs JS *inside win's page* via executeJs to get ground truth:
//   (A) does the PRE-navigation binding (getApiConfig) resolve from the page?
//   (B) does a binding registered AFTER navigation resolve?
// If (A) fails but (B) works, binds registered before the webview navigates to
// the served URL do not survive that navigation.
{
	// deno desktop's executeJs isn't in the older lib typings; reach it loosely.
	const w = win as unknown as {
		executeJs(code: string): Promise<unknown>;
		bind(name: string, fn: (...a: unknown[]) => unknown): void;
	};
	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
	(async () => {
		await wait(2500); // give the served page time to load and call getApiConfig
		try {
			diag(`PROBE typeof win.executeJs=${typeof w.executeJs}`);
			diag(`PROBE win location.href=${JSON.stringify(await w.executeJs('String(location.href)'))}`);
			diag(`PROBE typeof bindings in page=${JSON.stringify(await w.executeJs('typeof bindings'))}`);

			// (A) call the binding that was registered BEFORE Deno.serve/navigation
			await w.executeJs(
				"window.__a='pending';(async()=>{try{const r=await bindings.getApiConfig();window.__a='OK '+JSON.stringify(r);}catch(e){window.__a='ERR '+String((e&&e.message)||e);}})();'k'"
			);
			await wait(1200);
			diag(`PROBE (A) getApiConfig [bound pre-nav] => ${JSON.stringify(await w.executeJs('String(window.__a)'))}`);

			// (B) register a fresh binding NOW (post-navigation) and call it
			w.bind('probePostNav', () => {
				diag('>>> probePostNav HANDLER INVOKED');
				return { ok: true };
			});
			await wait(400);
			await w.executeJs(
				"window.__b='pending';(async()=>{try{const r=await bindings.probePostNav();window.__b='OK '+JSON.stringify(r);}catch(e){window.__b='ERR '+String((e&&e.message)||e);}})();'k'"
			);
			await wait(1200);
			diag(`PROBE (B) probePostNav [bound post-nav] => ${JSON.stringify(await w.executeJs('String(window.__b)'))}`);
			diag('PROBE done');
		} catch (e) {
			diag(`PROBE fatal: ${String(e)}`);
		}
	})();
}
// ═══════════════════════════════════════════════════════════════════════════

win.addEventListener('close', async () => {
	await backend.shutdown();
	Deno.exit(0);
});
