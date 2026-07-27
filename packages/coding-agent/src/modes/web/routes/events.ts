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
}
