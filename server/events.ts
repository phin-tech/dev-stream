/**
 * Server-sent events: how the timeline goes live.
 *
 * `deno desktop` bindings are request/response only -- no streaming -- so pushes
 * to the webview ride an ordinary SSE connection from the same local API every
 * other client uses, rather than anything webview-specific. That also means the
 * CLI's `dev-stream tail` (Phase 3) gets live updates for free.
 */

import type { StreamEvent } from '../src/shared/types.ts';

/** Without traffic, an idle SSE socket gets reaped by the OS or the webview. */
const HEARTBEAT_MS = 15_000;

export class Broadcaster {
	readonly #clients = new Set<(chunk: string) => void>();

	get clientCount(): number {
		return this.#clients.size;
	}

	/** Fan out to every open stream. Never throws: a dead client isn't a write error. */
	publish(event: StreamEvent): void {
		const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
		for (const send of this.#clients) {
			try {
				send(chunk);
			} catch {
				// The stream is already torn down; its cancel() handler will
				// have removed it. Dropping the frame is the correct outcome.
			}
		}
	}

	/** An SSE `Response` for one subscriber. */
	subscribe(hello: StreamEvent, signal: AbortSignal): Response {
		const encoder = new TextEncoder();
		// Not `number`: @types/node is in scope (the SvelteKit side pulls it in),
		// which types setInterval as returning a Timeout object rather than an id.
		let heartbeat: ReturnType<typeof setInterval> | undefined;

		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
				this.#clients.add(send);

				const close = () => {
					this.#clients.delete(send);
					if (heartbeat !== undefined) clearInterval(heartbeat);
					try {
						controller.close();
					} catch {
						// Already closed -- the client vanished mid-frame.
					}
				};

				// The client going away (webview reload, curl ^C) surfaces as the
				// request's abort signal, not as an enqueue error, so this is the
				// only reliable place to clean up.
				signal.addEventListener('abort', close, { once: true });

				// A comment frame: valid SSE, ignored by EventSource, and enough
				// to keep the connection from being considered idle.
				heartbeat = setInterval(() => {
					try {
						send(': heartbeat\n\n');
					} catch {
						close();
					}
				}, HEARTBEAT_MS);

				// Tells the client it is connected *and* which server it reached,
				// so a reconnect against a restarted app is detectable.
				send(`event: ${hello.type}\ndata: ${JSON.stringify(hello)}\n\n`);
			},
			cancel: () => {
				if (heartbeat !== undefined) clearInterval(heartbeat);
			}
		});

		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
				// Belt and braces for any proxy between us and the webview.
				'x-accel-buffering': 'no'
			}
		});
	}
}
