import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// All SvelteKit/Svelte config intentionally lives in svelte.config.js, NOT
// here. Passing ANY object to `sveltekit(...)` (even just compilerOptions)
// causes SvelteKit to completely ignore svelte.config.js -- not just the
// `kit` block -- per @sveltejs/kit/src/exports/vite/index.js. We need
// svelte.config.js to be the source of truth for adapter config so that
// `deno desktop`'s framework auto-detection (which inspects
// svelte.config.{js,ts}, see https://docs.deno.com/runtime/desktop/frameworks/)
// finds the @deno/svelte-adapter setup, so `sveltekit()` must be called bare.
export default defineConfig({
	plugins: [sveltekit()]
});
