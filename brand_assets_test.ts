import { assert, assertStringIncludes } from '@std/assert';

Deno.test('favicon uses the dev-stream identity instead of the framework default', async () => {
	const favicon = await Deno.readTextFile(
		new URL('./src/lib/assets/favicon.svg', import.meta.url)
	);

	assertStringIncludes(favicon, 'id="dev-stream-logo-title">dev-stream logo</title>');
	assertStringIncludes(favicon, 'aria-labelledby="dev-stream-logo-title"');
	assert(!favicon.includes('svelte-logo'), 'favicon must not retain the default Svelte identity');
});
