/** HTTP and WebSocket adapters for web mode. */

import type { AddressInfo } from "node:net";
import { createAdaptorServer, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type WebSocket, WebSocketServer } from "ws";
import { VERSION } from "../../config.ts";
import { WebCommandError, WebCommandHandler } from "./commands.ts";
import type { WebAccessPolicy } from "./middleware/auth.ts";
import { createSessionRateLimit, type RateLimitOptions } from "./middleware/rate-limit.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerModelRoutes } from "./routes/model.ts";
import { registerPromptRoutes } from "./routes/prompt.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerToolRoutes } from "./routes/tools.ts";
import type { HealthResponse } from "./types.ts";
import { isWsClientMessage } from "./types.ts";
import type { WebSessionHost } from "./web-session-host.ts";
import type { ConnectionManager } from "./ws/connection-manager.ts";

export interface CreateAppOptions {
	sessionHost: WebSessionHost;
	connectionManager: ConnectionManager;
	accessPolicy: WebAccessPolicy;
	commands?: WebCommandHandler;
	promptRateLimit?: RateLimitOptions;
	corsOrigin?: string;
}

export function createApp(options: CreateAppOptions): Hono {
	const { sessionHost, connectionManager, accessPolicy } = options;
	const commands = options.commands ?? new WebCommandHandler(sessionHost);
	const app = new Hono();

	app.use(
		"*",
		cors({
			origin: options.corsOrigin ?? "*",
			allowHeaders: ["Content-Type", "Authorization"],
			allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
		}),
	);
	app.get("/api/health", (context) => context.json<HealthResponse>({ status: "ok", version: VERSION }));
	app.use("/api/*", accessPolicy.createHttpMiddleware());

	registerSessionRoutes(app, { sessionHost });
	registerEventRoutes(app, { sessionHost, connectionManager });
	app.use(
		"/api/sessions/:id/prompt",
		createSessionRateLimit(options.promptRateLimit ?? { limit: 30, windowMs: 60_000 }),
	);
	registerPromptRoutes(app, { commands });
	registerModelRoutes(app, { commands, sessionHost });
	registerToolRoutes(app, { commands });

	app.use("/ws", accessPolicy.createWebSocketMiddleware());
	app.use("/ws", async (context, next) => {
		const sessionId = context.req.query("session_id");
		if (!sessionId) return context.json({ error: "Missing session_id" } as const, 400);
		if (!sessionHost.get(sessionId)) return context.json({ error: "Session not found" } as const, 404);
		await next();
	});
	app.get(
		"/ws",
		upgradeWebSocket((context) => {
			const sessionId = context.req.query("session_id");
			if (!sessionId) throw new Error("Validated WebSocket request is missing session_id");
			return {
				onOpen: (_event, websocket) => {
					try {
						connectionManager.register(sessionId, websocket);
					} catch {
						websocket.close(1011, "Session not available");
					}
				},
				onMessage: (event, websocket) => {
					if (typeof event.data !== "string") {
						websocket.close(1003, "Text messages only");
						return;
					}
					let data: unknown;
					try {
						data = JSON.parse(event.data);
					} catch {
						websocket.send(JSON.stringify({ type: "command_error", error: "Invalid JSON command" }));
						return;
					}
					if (!isWsClientMessage(data)) {
						websocket.send(JSON.stringify({ type: "command_error", error: "Invalid command" }));
						return;
					}
					if (data.type === "extension_ui_response") {
						if (!connectionManager.resolveUIResponse(sessionId, data)) {
							websocket.send(JSON.stringify({ type: "command_error", error: "Unknown extension UI request" }));
						}
						return;
					}
					void commands.execute(sessionId, data).catch((error: unknown) => {
						websocket.send(JSON.stringify(formatWebSocketCommandError(error)));
					});
				},
				onClose: (_event, websocket) => {
					connectionManager.unregister(sessionId, websocket);
				},
				onError: (_event, websocket) => {
					connectionManager.unregister(sessionId, websocket);
				},
			};
		}),
	);

	app.onError((error, context) => {
		console.error("[web] Request error:", error);
		return context.json({ error: "Internal server error" } as const, 500);
	});

	return app;
}

function formatWebSocketCommandError(error: unknown): Record<string, unknown> {
	const commandError = error instanceof WebCommandError ? error : undefined;
	return {
		type: "command_error",
		error: commandError?.message ?? "Command failed",
		details: commandError?.details,
	};
}

export class WebServerHost {
	private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
	private readonly server;
	private readonly heartbeatIntervalMs: number;
	private readonly responsiveClients = new WeakSet<WebSocket>();
	private started = false;
	private closing: Promise<void> | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;

	constructor(app: Hono, options: { heartbeatIntervalMs?: number } = {}) {
		this.server = createAdaptorServer({ fetch: app.fetch, websocket: { server: this.websocketServer } });
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
		this.websocketServer.on("connection", (client) => {
			this.responsiveClients.add(client);
			client.on("pong", () => this.responsiveClients.add(client));
		});
	}

	start(port: number, host: string): Promise<AddressInfo> {
		if (this.started) return Promise.reject(new Error("Web server is already started"));
		this.started = true;
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				this.started = false;
				reject(error);
			};
			this.server.once("error", onError);
			this.server.listen(port, host, () => {
				this.server.off("error", onError);
				const address = this.server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Web server did not expose a TCP address"));
					return;
				}
				this.startHeartbeat();
				resolve(address);
			});
		});
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = this.closeOnce();
		return this.closing;
	}

	onError(listener: (error: Error) => void): () => void {
		this.server.on("error", listener);
		return () => this.server.off("error", listener);
	}

	private async closeOnce(): Promise<void> {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		for (const client of this.websocketServer.clients) {
			client.terminate();
		}
		if (this.started) {
			await new Promise<void>((resolve, reject) => {
				this.server.close((error?: Error) => (error ? reject(error) : resolve()));
			});
			this.started = false;
		}
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			for (const client of this.websocketServer.clients) {
				if (!this.responsiveClients.has(client)) {
					client.terminate();
					continue;
				}
				this.responsiveClients.delete(client);
				try {
					client.ping();
				} catch {
					client.terminate();
				}
			}
		}, this.heartbeatIntervalMs);
		this.heartbeatTimer.unref();
	}
}
