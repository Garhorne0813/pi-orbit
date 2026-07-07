/**
 * Web mode: HTTP + WebSocket server for the coding agent.
 *
 * Provides REST API for session management, prompting, model selection,
 * and WebSocket streaming of AgentSessionEvent.
 *
 * Usage: pi --mode web [--port 3000] [--host 127.0.0.1] [--auth-token <token>]
 */

import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { createApp, createHttpServer } from "./server.ts";
import type { WebModeOptions, WebSessionEntry } from "./types.ts";

export interface RunWebModeOptions extends WebModeOptions {
	factory: CreateAgentSessionRuntimeFactory;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	agentDir: string;
}

/**
 * Run the coding agent in web mode.
 */
export async function runWebMode(defaultRuntime: AgentSessionRuntime, options: RunWebModeOptions): Promise<never> {
	const {
		port = parseInt(process.env.PI_WEB_PORT ?? "3000", 10),
		host = process.env.PI_WEB_HOST ?? "127.0.0.1",
		authToken,
		factory,
		sessionManager,
		modelRegistry,
		settingsManager,
		agentDir,
	} = options;

	const sessionMap = new Map<string, WebSessionEntry>();

	const { app, connectionManager } = createApp({
		authToken,
		sessionMap,
		sessionRoutesDeps: {
			sessionMap,
			factory,
			agentDir,
			defaultRuntime,
			sessionManager,
			settingsManager,
			modelRegistry,
		},
		modelRegistry,
	});

	const server = createHttpServer(app, sessionMap, connectionManager, authToken);

	// Graceful shutdown
	let shuttingDown = false;
	const cleanup = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`\n[web] Shutting down...`);
		for (const [id] of sessionMap) {
			connectionManager.removeSession(id);
		}
		await Promise.all(
			[...sessionMap.values()].map((entry) =>
				Promise.resolve(entry.runtime.dispose()).catch(() => {
					// Ignore disposal errors
				}),
			),
		);
		server.close();
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.on("SIGHUP", cleanup);

	// Handle both startup and runtime server errors
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.error(`[web] Port ${port} is already in use. Use --port to specify a different port.`);
		} else {
			console.error(`[web] Server error: ${err.message}`);
		}
		process.exit(1);
	});

	return new Promise<never>((_resolve, reject) => {
		server.listen(port, host, () => {
			console.error(`[web] Pi web server listening on http://${host}:${port}`);
			console.error(`[web] WebSocket endpoint: ws://${host}:${port}/ws`);
			console.error(`[web] Health check: http://${host}:${port}/api/health`);
			if (!authToken) {
				console.error(`[web] Warning: No auth token configured. API is open to all connections.`);
				console.error(`[web] Set --auth-token or PI_WEB_AUTH_TOKEN to enable authentication.`);
			}
		});
		server.once("error", reject);
	});
}
