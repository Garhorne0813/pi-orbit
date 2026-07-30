/** Server-Sent Events adapter for web mode session events. */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { WebSessionHost } from "../web-session-host.ts";
import type { ConnectionManager, WebSocketLike } from "../ws/connection-manager.ts";

export interface EventRoutesDeps {
	sessionHost: WebSessionHost;
	connectionManager: ConnectionManager;
}

export function registerEventRoutes(app: Hono, deps: EventRoutesDeps): void {
	app.get("/api/sessions/:id/events", (context) => {
		const sessionId = context.req.param("id");
		if (!deps.sessionHost.get(sessionId)) return context.json({ error: "Session not found" } as const, 404);

		return streamSSE(context, async (stream) => {
			let finish = () => {};
			const closed = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const client: WebSocketLike = {
				send: (data) => {
					void stream.writeSSE({ event: "session_event", data }).catch(() => finish());
				},
				close: () => {
					void stream.close();
					finish();
				},
			};
			stream.onAbort(finish);
			deps.connectionManager.register(sessionId, client);
			try {
				await stream.writeSSE({ event: "connected", data: JSON.stringify({ sessionId }) });
				await closed;
			} finally {
				deps.connectionManager.unregister(sessionId, client);
			}
		});
	});

	app.get("/api/runtimes/:runtimeId/events", (context) => {
		const runtimeId = context.req.param("runtimeId");
		const descriptor = deps.sessionHost.describe(runtimeId);
		if (!descriptor) {
			const code = deps.sessionHost.getMissingRuntimeCode(runtimeId);
			return context.json(
				{ error: code === "runtime_evicted" ? "Runtime was evicted" : "Runtime not found", code },
				code === "runtime_evicted" ? 410 : 404,
			);
		}
		const rawLastEventId = context.req.header("Last-Event-ID") ?? context.req.query("after");
		const afterSequence = rawLastEventId === undefined ? undefined : Number(rawLastEventId);
		if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
			return context.json({ error: "Invalid event sequence" } as const, 400);
		}
		const bufferedMessages: string[] = [];
		let send = (data: string): void => {
			bufferedMessages.push(data);
		};
		let closeRequested = false;
		let close = () => {
			closeRequested = true;
		};
		const client: WebSocketLike = {
			send: (data) => send(data),
			close: () => close(),
		};
		const registration = deps.connectionManager.register(runtimeId, client, {
			eventFormat: "envelope",
			afterSequence,
		});
		if (!registration.ok) {
			return context.json(
				{
					error:
						registration.code === "event_replay_gap"
							? "Requested event sequence is no longer buffered"
							: "Requested event sequence is ahead of the runtime",
					code: registration.code,
					oldestSequence: registration.oldestSequence,
					latestSequence: registration.latestSequence,
				} as const,
				409,
			);
		}

		return streamSSE(context, async (stream) => {
			let finish = () => {};
			const closed = new Promise<void>((resolve) => {
				finish = resolve;
			});
			let writeQueue = Promise.resolve();
			const enqueue = (data: string) => {
				const envelope = JSON.parse(data) as { sequence: number };
				writeQueue = writeQueue
					.then(() => stream.writeSSE({ event: "runtime_event", id: String(envelope.sequence), data }))
					.catch(() => finish());
			};
			stream.onAbort(finish);
			try {
				await stream.writeSSE({ event: "connected", data: JSON.stringify(descriptor) });
				send = enqueue;
				for (const message of bufferedMessages.splice(0)) enqueue(message);
				close = () => {
					void writeQueue.finally(async () => {
						await stream.close();
						finish();
					});
				};
				if (closeRequested) close();
				await closed;
			} finally {
				deps.connectionManager.unregister(runtimeId, client);
			}
		});
	});
}
