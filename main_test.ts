import { assert } from '@std/assert';

Deno.test('desktop startup serves the UI before creating the bound window', async () => {
	const source = await Deno.readTextFile(new URL('./main.ts', import.meta.url));
	const serve = source.indexOf('Deno.serve(createDesktopHandler(svelteHandler, apiConfig))');
	const window = source.indexOf('new Deno.BrowserWindow');

	assert(serve >= 0, 'desktop entrypoint must start the UI server');
	assert(window >= 0, 'desktop entrypoint must create a window');
	assert(
		serve < window,
		'first Deno.serve() must establish the webview target before BrowserWindow bindings are registered'
	);
});

Deno.test('desktop entrypoint keeps SQLite outside its statically analyzed module graph', async () => {
	const source = await Deno.readTextFile(new URL('./main.ts', import.meta.url));
	const config = await Deno.readTextFile(new URL('./deno.json', import.meta.url));

	assert(
		!source.includes("import('./server/serve.ts')"),
		'backend import must not expose node:sqlite to the desktop entrypoint module graph'
	);
	assert(
		config.includes('--include server'),
		'compiled desktop builds must explicitly include the dynamically loaded backend'
	);
});
