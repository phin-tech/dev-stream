import adapter from '@deno/svelte-adapter';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// NOTE: as of SvelteKit 2.62+, `sv create` scaffolds adapter config into
// vite.config.ts via the `sveltekit()` plugin's `kit` option instead of this
// file. We intentionally configure the adapter here instead, because
// `deno desktop`'s framework auto-detection looks for the presence of
// `svelte.config.{js,ts}` to recognize a SvelteKit project (see
// https://docs.deno.com/runtime/desktop/frameworks/) and then looks for this
// adapter's `.deno-deploy/server.ts` build output. Keeping the adapter config
// here (rather than only in vite.config.ts) keeps the "source of truth" for
// SvelteKit config in the file `deno desktop` actually inspects.
/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
