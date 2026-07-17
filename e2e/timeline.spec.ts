import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function postFixture(input: Record<string, unknown>) {
	const [port, token] = await Promise.all([
		readFile('.dev-stream-e2e/port', 'utf8'),
		readFile('.dev-stream-e2e/token', 'utf8')
	]);
	const response = await fetch(`http://127.0.0.1:${port.trim()}/api/posts`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token.trim()}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(input)
	});
	expect(response.ok).toBe(true);
}

async function viewFixture(input: Record<string, unknown>) {
	const [port, token] = await Promise.all([
		readFile('.dev-stream-e2e/port', 'utf8'),
		readFile('.dev-stream-e2e/token', 'utf8')
	]);
	const response = await fetch(`http://127.0.0.1:${port.trim()}/api/views`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token.trim()}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(input)
	});
	expect(response.ok).toBe(true);
}

test('empty timeline shows the getting-started notice', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByText('Nothing here yet. Try')).toBeVisible();
	await expect(page.getByText('dev-stream post "hello"')).toBeVisible();
});

test('a live post appears without reloading the timeline', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText('Nothing here yet. Try')).toBeVisible();

	await postFixture({ source: 'e2e', title: 'Arrived over SSE', tags: ['live'] });

	await expect(page.getByRole('heading', { name: 'Arrived over SSE' })).toBeVisible();
});

test('Escape closes a card action menu', async ({ page }) => {
	await postFixture({ source: 'ci', title: 'Menu test', tags: ['deploy'] });
	await page.goto('/');
	const card = page.getByRole('article').filter({
		has: page.getByRole('heading', { name: 'Menu test' })
	});
	await card.getByRole('button', { name: '⋯' }).click();
	await expect(page.getByRole('button', { name: 'Mute source ci' })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(page.getByRole('button', { name: 'Mute source ci' })).toBeHidden();
});

test('Escape cancels naming a view without clearing its filter', async ({ page }) => {
	await postFixture({ source: 'agent', title: 'Saved view test' });
	await page.goto('/');
	await page.getByRole('button', { name: 'Source' }).click();
	await page.getByRole('checkbox', { name: 'agent 1' }).check();
	await page.getByRole('button', { name: '+ Save this filter' }).click();
	await page.getByRole('textbox', { name: 'View name' }).fill('Agent notes');

	await page.keyboard.press('Escape');

	await expect(page.getByRole('textbox', { name: 'View name' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Source (1)' })).toBeVisible();
});

test('desktop timeline keeps controls and compact posts within a dense vertical rhythm', async ({ page }) => {
	await postFixture({
		source: 'ci',
		title: 'Deploy completed',
		meta: { project: 'dev-stream', repo: 'phin-tech/dev-stream' },
		tags: ['deploy', 'release']
	});
	await page.goto('/');
	const filterBar = page.locator('.bar');
	const card = page.getByRole('article').filter({
		has: page.getByRole('heading', { name: 'Deploy completed' })
	});
	const project = card.getByRole('button', { name: 'dev-stream', exact: true });
	const repo = card.getByRole('button', { name: 'phin-tech/dev-stream', exact: true });

	await expect(filterBar).toHaveCSS('padding-top', '8px');
	await expect(filterBar).toHaveCSS('padding-bottom', '8px');
	await expect(card).toHaveCSS('padding-top', '10px');
	await expect(card).toHaveCSS('padding-bottom', '10px');
	await expect(card).toHaveCSS('margin-bottom', '0px');
	await expect(card).toHaveCSS('border-radius', '0px');
	await expect(card).toHaveCSS('border-top-width', '0px');
	await expect(card).toHaveCSS('border-right-width', '0px');
	await expect(card).toHaveCSS('border-bottom-width', '1px');
	await expect(project).toHaveCSS('border-width', '0px');
	await expect(project).toHaveCSS('padding-left', '0px');
	await expect(repo).toHaveCSS('border-width', '0px');
});

test('main page chrome uses a compact aligned application shell', async ({ page }) => {
	await postFixture({ source: 'agent', title: 'Shell alignment test' });
	await page.goto('/');

	const titleBar = page.getByRole('navigation');
	const sidebar = page.getByRole('complementary');
	const sidebarToggle = page.getByRole('button', { name: 'Collapse views sidebar' });
	const navLinks = page.locator('.nav-links');
	const search = page.getByRole('searchbox', { name: 'Search the timeline…' });
	const post = page.getByRole('article').filter({
		has: page.getByRole('heading', { name: 'Shell alignment test' })
	});

	await expect(titleBar).toHaveCSS('height', '48px');
	await expect(navLinks).toHaveCSS('margin-left', '0px');
	await expect(navLinks).toHaveCSS('margin-right', '0px');
	await expect(sidebar).toHaveCSS('padding-top', '12px');
	await expect(sidebarToggle).toHaveCSS('width', '44px');
	await expect(sidebarToggle).toHaveCSS('height', '44px');

	const searchBox = await search.boundingBox();
	const postBox = await post.boundingBox();
	expect(searchBox).not.toBeNull();
	expect(postBox).not.toBeNull();
	expect(postBox!.x).toBe(searchBox!.x);
});

test('main page chrome uses restrained material and interruptible shell motion', async ({ page }) => {
	await page.goto('/');
	const titleBar = page.getByRole('navigation');
	const sidebarToggleIcon = page.locator('.sidebar-toggle span');
	const search = page.getByRole('searchbox', { name: 'Search the timeline…' });

	await expect(titleBar).toHaveCSS('backdrop-filter', 'none');
	await expect(titleBar).toHaveCSS('position', 'relative');
	await expect(sidebarToggleIcon).toHaveCSS('transition-property', 'transform');
	await expect(sidebarToggleIcon).toHaveCSS('transition-duration', '0.2s');
	await expect(search).toHaveCSS('font-family', 'system-ui');
});

test('reduced motion removes sidebar geometry animation', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');

	await expect(page.locator('.sidebar-toggle span')).toHaveCSS('transition-duration', '1e-05s');
});

test('collapsed rail exposes every saved search with its unread count', async ({ page }) => {
	await viewFixture({ name: 'Agent notes', filter: { source: ['agent'] } });
	await viewFixture({ name: 'CI activity', filter: { source: ['ci'] } });
	await postFixture({ source: 'agent', title: 'Agent rail item' });
	await postFixture({ source: 'ci', title: 'CI rail item' });
	await page.goto('/');

	await expect(page.getByRole('button', { name: 'Pin' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Collapse views sidebar' }).click();

	const rail = page.getByRole('complementary');
	await expect(rail.getByRole('button', { name: 'Timeline' })).toBeVisible();
	const agentView = rail.getByRole('button', { name: 'Agent notes, 1 unread' });
	await expect(agentView).toBeVisible();
	await expect(rail.getByRole('button', { name: 'CI activity, 1 unread' })).toBeVisible();

	await agentView.hover();
	const tooltip = page.getByRole('tooltip');
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText('Agent notes');
	await expect(tooltip).toContainText('1 unread');
	const railItem = page.locator('.row:has(button[aria-label="Agent notes, 1 unread"])');
	await expect(railItem).toHaveCSS('background-color', 'oklch(0.27 0.036 255)');
});

test('Things-inspired shell replaces hard section rules with inset surfaces', async ({ page }) => {
	await postFixture({ source: 'agent', title: 'Inset surface test' });
	await page.goto('/');

	const titleBar = page.getByRole('navigation');
	const sidebar = page.getByRole('complementary');
	const controls = page.locator('.control-surface');
	const filterBar = page.locator('.bar');
	const unreadBar = page.locator('.read-bar');
	const timeline = page.getByRole('main');
	const post = page.getByRole('article').filter({
		has: page.getByRole('heading', { name: 'Inset surface test' })
	});

	await expect(titleBar).toHaveCSS('border-bottom-width', '0px');
	await expect(sidebar).toHaveCSS('border-right-width', '0px');
	await expect(controls).toHaveCSS('margin', '12px 12px 8px');
	await expect(controls).toHaveCSS('border-radius', '12px');
	await expect(controls).toHaveCSS('overflow', 'visible');
	await expect(controls).toHaveCSS('z-index', '20');
	await expect(filterBar).toHaveCSS('border-bottom-width', '0px');
	await expect(unreadBar).toHaveCSS('border-bottom-width', '0px');
	await expect(timeline).toHaveCSS('margin', '0px 12px 12px');
	await expect(timeline).toHaveCSS('border-radius', '16px');
	await post.hover();
	await expect(post).toHaveCSS('border-radius', '10px');
});

test('filter dropdown renders above the timeline canvas', async ({ page }) => {
	for (const source of ['agent', 'ci', 'github', 'monitor', 'hackernews']) {
		await postFixture({ source, title: `Dropdown stacking test: ${source}` });
	}
	await page.goto('/');
	await page.getByRole('button', { name: 'Source' }).click();

	const menu = page.locator('.menu');
	await expect(menu).toBeVisible();
	const topmostIsMenu = await menu.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		return topmost === element || Boolean(topmost?.closest('.menu'));
	});
	expect(topmostIsMenu).toBe(true);
});

test('saved-view deletion is protected behind a secondary action menu', async ({ page }) => {
	await viewFixture({ name: 'Do not delete accidentally', filter: { source: ['agent'] } });
	await page.goto('/');

	await expect(page.getByRole('button', { name: 'Delete this view' })).toHaveCount(0);
	const actions = page.getByRole('button', { name: 'View actions for Do not delete accidentally' });
	await expect(actions).toBeVisible();
	await actions.click();
	await expect(page.getByRole('button', { name: 'Delete view' })).toBeVisible();

	await page.getByRole('button', { name: 'Collapse views sidebar' }).click();
	await expect(actions).toBeHidden();
	await expect(page.getByRole('button', { name: 'Delete view' })).toBeHidden();
});

test('keyboard shortcut help and command palette are discoverable from the keyboard', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Timeline' })).toBeVisible();

	await page.keyboard.press('?');
	await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
	await expect(page.getByText('G G')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();

	await page.keyboard.press('Meta+k');
	const palette = page.getByRole('dialog', { name: 'Command palette' });
	await expect(palette).toBeVisible();
	await expect(palette.getByRole('textbox', { name: 'Search commands' })).toBeFocused();
});

test('command palette selection moves with arrows or j/k and Enter runs the command', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Timeline' })).toBeVisible();
	await page.keyboard.press('Meta+k');
	const palette = page.getByRole('dialog', { name: 'Command palette' });

	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('j');
	await expect(palette.getByRole('option', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/settings$/);
});

test('timeline Vim commands select posts, protect text entry, and focus search', async ({ page }) => {
	await postFixture({ source: 'keyboard', title: 'Keyboard navigation target' });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Keyboard navigation target' })).toBeVisible();
	await page.keyboard.press('j');
	await expect(page.locator('article.selected')).toHaveCount(1);

	await page.keyboard.press('/');
	const search = page.getByRole('searchbox', { name: 'Search the timeline…' });
	await expect(search).toBeFocused();
	await page.keyboard.type('jk');
	await expect(search).toHaveValue('jk');
});

test('filter chains drive picker selection and return focus to the timeline', async ({ page }) => {
	await postFixture({ source: 'agent', title: 'Agent filter target', tags: ['keyboard'] });
	await postFixture({ source: 'ci', title: 'CI filter target', tags: ['build'] });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'CI filter target' })).toBeVisible();

	await page.keyboard.press('f');
	await page.keyboard.press('s');
	const sourceTrigger = page.getByRole('button', { name: 'Source' });
	await expect(sourceTrigger).toHaveAttribute('aria-expanded', 'true');
	const agent = page.getByRole('checkbox', { name: 'agent' });
	const ci = page.getByRole('checkbox', { name: 'ci' });
	await expect(agent).toBeFocused();
	await page.keyboard.press('j');
	await expect(ci).toBeFocused();
	await page.keyboard.press('Space');
	await expect(ci).toBeChecked();
	await page.keyboard.press('Enter');
	await expect(sourceTrigger).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('main')).toBeFocused();
	await expect(page.getByRole('heading', { name: 'Agent filter target' })).toBeHidden();

	await page.keyboard.press('f');
	await page.keyboard.press('c');
	await expect(page.getByRole('heading', { name: 'Agent filter target' })).toBeVisible();
});

test('search Enter hands focus back to the first matching timeline item', async ({ page }) => {
	await postFixture({ source: 'agent', title: 'Unique searchable activity' });
	await postFixture({ source: 'ci', title: 'Unrelated activity' });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Unrelated activity' })).toBeVisible();

	await page.keyboard.press('/');
	const search = page.getByRole('searchbox', { name: 'Search the timeline…' });
	await page.keyboard.type('Unique searchable');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('main')).toBeFocused();
	await expect(page.locator('article.selected')).toHaveCount(1);
	await expect(page.getByRole('heading', { name: 'Unique searchable activity' })).toBeVisible();
});

test('Space previews a selected post while Enter opens persistent details', async ({ page }) => {
	await postFixture({
		source: 'keyboard',
		title: 'Two-level keyboard action',
		summary: 'A compact preview',
		body: 'Full details that persist after Quick Look closes.'
	});
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Two-level keyboard action' })).toBeVisible();
	await page.keyboard.press('j');
	await expect(page.locator('article.selected')).toHaveCount(1);

	await page.keyboard.press('Space');
	const quickLook = page.getByRole('dialog', { name: 'Quick Look: Two-level keyboard action' });
	await expect(quickLook).toBeVisible();
	await expect(quickLook.getByText('Full details that persist after Quick Look closes.')).toBeVisible();
	await page.keyboard.press('Space');
	await expect(quickLook).toBeHidden();

	await page.keyboard.press('Enter');
	const post = page.getByRole('article').filter({
		has: page.getByRole('heading', { name: 'Two-level keyboard action' })
	});
	await expect(post).toHaveClass(/expanded/);
	await expect(post.getByText('Full details that persist after Quick Look closes.')).toBeVisible();
});

test('macOS navigation shortcuts open settings, timeline, and saved views', async ({ page }) => {
	await viewFixture({ name: 'Keyboard view', filter: { source: ['keyboard-view'] } });
	await postFixture({ source: 'keyboard-view', title: 'Saved shortcut target' });
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

	await page.keyboard.press('Meta+,');
	await expect(page).toHaveURL(/\/settings$/);
	await page.keyboard.press('Meta+0');
	await expect(page).toHaveURL(/\/$/);

	await page.keyboard.press('Meta+1');
	await expect(page.getByText('Saved shortcut target')).toBeVisible();
});

test('Help tab documents macOS and Vim commands from the application shell', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'Help' }).click();

	await expect(page).toHaveURL(/\/help$/);
	await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'App' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Timeline navigation' })).toBeVisible();
	await expect(page.getByText('⌘K', { exact: true })).toBeVisible();
	await expect(page.getByText('G G', { exact: true })).toBeVisible();
	await expect(page.getByText('Saved views 1–9')).toBeVisible();
});

test('Command B toggles the views sidebar', async ({ page }) => {
	await page.goto('/');
	const sidebar = page.getByRole('complementary');
	await expect(page.getByRole('button', { name: 'Collapse views sidebar' })).toBeVisible();

	await page.keyboard.press('Meta+b');
	await expect(sidebar).toHaveClass(/collapsed/);
	await expect(page.getByRole('button', { name: 'Expand views sidebar' })).toBeVisible();

	await page.keyboard.press('Meta+b');
	await expect(sidebar).not.toHaveClass(/collapsed/);
});

test('G L opens the selected post primary link', async ({ page }) => {
	await postFixture({
		source: 'keyboard-link',
		title: 'Keyboard link target',
		meta: { url: 'https://example.com/keyboard-target' }
	});
	let openedUrl = '';
	await page.route('**/api/open-external', async (route) => {
		openedUrl = route.request().postDataJSON().url;
		await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
	});
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Keyboard link target' })).toBeVisible();

	await page.keyboard.press('j');
	await page.keyboard.press('g');
	await page.keyboard.press('l');
	await expect.poll(() => openedUrl).toBe('https://example.com/keyboard-target');
});

test('archive removes a post from the timeline and Archive can restore it', async ({ page }) => {
	await postFixture({ source: 'archive-test', title: 'Archive keyboard target' });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Archive keyboard target' })).toBeVisible();

	await page.keyboard.press('j');
	await page.keyboard.press('a');
	await expect(page.getByRole('heading', { name: 'Archive keyboard target' })).toBeHidden();

	await page.getByRole('button', { name: 'Archive' }).click();
	const archived = page.getByRole('article').filter({
		has: page.getByRole('heading', { name: 'Archive keyboard target' })
	});
	await expect(archived).toBeVisible();
	await archived.getByRole('button', { name: '⋯' }).click();
	await archived.getByRole('button', { name: 'Restore' }).click();
	await expect(archived).toBeHidden();
});
