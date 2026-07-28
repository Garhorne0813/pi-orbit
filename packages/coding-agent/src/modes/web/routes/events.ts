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
		if (afterSequence !== undefined) {
			const replay = deps.connectionManager.getReplayWindow(runtimeId, afterSequence);
			if (replay.gap) {
				return context.json(
					{
						error: "Requested event sequence is no longer buffered",
						code: "event_replay_gap",
						oldestSequence: replay.oldestSequence,
						latestSequence: replay.latestSequence,
					} as const,
					409,
				);
			}
		}

		return streamSSE(context, async (stream) => {
			let finish = () => {};
			const closed = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const client: WebSocketLike = {
				send: (data) => {
					const envelope = JSON.parse(data) as { sequence: number };
					void stream
						.writeSSE({ event: "runtime_event", id: String(envelope.sequence), data })
						.catch(() => finish());
				},
				close: () => {
					void stream.close();
					finish();
				},
			};
			stream.onAbort(finish);
			deps.connectionManager.register(runtimeId, client, { eventFormat: "envelope", afterSequence });
			try {
				await stream.writeSSE({ event: "connected", data: JSON.stringify(descriptor) });
				await closed;
			} finally {
				deps.connectionManager.unregister(runtimeId, client);
			}
		});
	});
}
