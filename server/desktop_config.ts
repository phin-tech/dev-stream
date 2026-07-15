import type { ApiConfig } from '../src/shared/types.ts';

export function createDesktopHandler(
	app: Deno.ServeHandler,
	config: Promise<ApiConfig>
): Deno.ServeHandler {
	return async (request, info) => {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/api/desktop-config') {
			return Response.json(await config);
		}
		return app(request, info);
	};
}
