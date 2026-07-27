/** Web mode process adapter. */

import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { WebAccessPolicy } from "./middleware/auth.ts";
import { createApp, WebServerHost } from "./server.ts";
import type { WebModeOptions } from "./types.ts";
import { WebSessionHost, type WebSessionManagerFactory } from "./web-session-host.ts";
import { ConnectionManager } from "./ws/connection-manager.ts";

export interface RunWebModeOptions extends WebModeOptions {
	factory: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	createSessionManager?: WebSessionManagerFactory;
}

export interface ResolvedWebModeOptions {
	port: number;
	host: string;
	authToken: string | undefined;
	corsOrigin: string;
}

export function resolveWebModeOptions(
	options: WebModeOptions,
	environment: NodeJS.ProcessEnv = process.env,
): ResolvedWebModeOptions {
	const rawPort = options.port ?? Number(environment.PI_WEB_PORT ?? "3000");
	if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
		throw new Error(`Invalid web port: ${environment.PI_WEB_PORT ?? String(rawPort)}`);
	}
	const rawToken = options.authToken ?? environment.PI_WEB_AUTH_TOKEN;
	return {
		port: rawPort,
		host: options.host ?? environment.PI_WEB_HOST ?? "127.0.0.1",
		authToken: rawToken && rawToken.length > 0 ? rawToken : undefined,
		corsOrigin: options.corsOrigin ?? environment.PI_WEB_CORS_ORIGIN ?? "*",
	};
}

export async function runWebMode(defaultRuntime: AgentSessionRuntime, options: RunWebModeOptions): Promise<never> {
	const config = resolveWebModeOptions(options);
	const connectionManager = new ConnectionManager();
	const defaultSessionManager = defaultRuntime.session.sessionManager;
	const createSessionManager =
		options.createSessionManager ??
		((cwd: string) =>
			defaultSessionManager.isPersisted()
				? SessionManager.create(cwd, defaultSessionManager.getSessionDir())
				: SessionManager.inMemory(cwd));
	const sessionHost = new WebSessionHost({
		defaultRuntime,
		connectionManager,
		createSessionManager,
		createRuntime: (cwd, sessionManager) =>
			createAgentSessionRuntime(options.factory, {
				cwd,
				agentDir: options.agentDir,
				sessionManager,
			}),
	});
	await sessionHost.initialize();

	const accessPolicy = new WebAccessPolicy(config.authToken);
	const serverHost = new WebServerHost(
		createApp({ sessionHost, connectionManager, accessPolicy, corsOrigin: config.corsOrigin }),
	);
	let shuttingDown = false;
	let removeServerErrorHandler = () => {};
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const cleanup = async (exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		removeServerErrorHandler();
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		console.error("\n[web] Shutting down...");
		await serverHost.close();
		await sessionHost.dispose();
		process.exit(exitCode);
	};
	const requestCleanup = (exitCode: number): void => {
		void cleanup(exitCode).catch((error: unknown) => {
			console.error("[web] Shutdown error:", error);
			process.exit(1);
		});
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		const handler = () => requestCleanup(0);
		signalHandlers.set(signal, handler);
		process.on(signal, handler);
	}

	try {
		const address = await serverHost.start(config.port, config.host);
		removeServerErrorHandler = serverHost.onError((error) => {
			console.error(`[web] Server error: ${error.message}`);
			requestCleanup(1);
		});
		console.error(`[web] Pi web server listening on http://${config.host}:${address.port}`);
		console.error(`[web] WebSocket endpoint: ws://${config.host}:${address.port}/ws`);
		console.error(`[web] Health check: http://${config.host}:${address.port}/api/health`);
		if (!accessPolicy.authenticationEnabled) {
			console.error("[web] Warning: No auth token configured. API is open to all connections.");
			console.error("[web] Set --auth-token or PI_WEB_AUTH_TOKEN to enable authentication.");
		}
	} catch (error) {
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		await serverHost.close();
		await sessionHost.dispose();
		const serverError = error as NodeJS.ErrnoException;
		if (serverError.code === "EADDRINUSE") {
			console.error(`[web] Port ${config.port} is already in use. Use --port to specify a different port.`);
		} else {
			console.error(`[web] Server error: ${serverError.message}`);
		}
		process.exit(1);
	}

	return new Promise<never>(() => {});
}
