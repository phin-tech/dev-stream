import { defineConfig, devices } from '@playwright/test';

// webServer runs e2e/run-server.sh, which boots the real Deno backend against
// an isolated DEV_STREAM_HOME (.dev-stream-e2e) and hands its port/token to
// Vite as env vars -- see that script for why. reuseExistingServer is off in
// CI so a stale server never masks a real regression, and on locally so
// `task dev` (5173) and this (5174) can run side by side.
export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: 'html',
	use: {
		baseURL: 'http://localhost:5174',
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: './e2e/run-server.sh',
		url: 'http://localhost:5174',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
