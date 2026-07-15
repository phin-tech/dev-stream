import { assertEquals } from '@std/assert';
import { createDesktopHandler } from './desktop_config.ts';

const info: Deno.ServeHandlerInfo<Deno.NetAddr> = {
	remoteAddr: { transport: 'tcp', hostname: '127.0.0.1', port: 45679 },
	completed: Promise.resolve()
};

Deno.test('desktop config route returns the resolved API configuration', async () => {
	const handler = createDesktopHandler(
		() => new Response('app'),
		Promise.resolve({ port: 4517, token: 'desktop-token' })
	);

	const response = await handler(new Request('http://127.0.0.1:45678/api/desktop-config'), info);

	assertEquals(response.status, 200);
	assertEquals(await response.json(), { port: 4517, token: 'desktop-token' });
});

Deno.test('desktop config handler delegates unrelated requests to the app', async () => {
	const handler = createDesktopHandler(
		() => new Response('app', { status: 418 }),
		Promise.resolve({ port: 4517, token: 'desktop-token' })
	);

	const response = await handler(new Request('http://127.0.0.1:45678/'), info);

	assertEquals(response.status, 418);
	assertEquals(await response.text(), 'app');
});
