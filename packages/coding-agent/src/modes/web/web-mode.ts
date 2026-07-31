/** Web mode process adapter. */

import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { WebAccessPolicy } from "./middleware/auth.ts";
import { createApp, WebServerHost } from "./server.ts";
import type { WebModeOptions, WebProjectTrustController } from "./types.ts";
import { WebSessionHost, type WebSessionManagerFactory } from "./web-session-host.ts";
import { ConnectionManager } from "./ws/connection-manager.ts";

export interface RunWebModeOptions extends WebModeOptions {
	factory: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	createSessionManager?: WebSessionManagerFactory;
	projectTrustController?: WebProjectTrustController;
}

export interface ResolvedWebModeOptions {
	port: number;
	host: string;
	authToken: string | undefined;
	appManaged: boolean;
	corsOrigin: string | null;
	maxRuntimes: number;
	idleTimeoutMs: number;
	maxConcurrentTurns: number;
	requestBodyLimitBytes: number;
	disposeTimeoutMs: number;
	shutdownTimeoutMs: number;
}

export function resolveWebModeOptions(
	options: WebModeOptions,
	environment: NodeJS.ProcessEnv = process.env,
): ResolvedWebModeOptions {
	const rawPort = options.port ?? Number(environment.PI_ORBIT_PORT ?? "3000");
	if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
		throw new Error(`Invalid web port: ${environment.PI_ORBIT_PORT ?? String(rawPort)}`);
	}
	const rawToken = options.authToken ?? environment.PI_ORBIT_AUTH_TOKEN;
	const authToken = rawToken && rawToken.length > 0 ? rawToken : undefined;
	const appManaged = options.appManaged ?? isEnabled(environment.PI_ORBIT_APP_MANAGED);
	const host = options.host ?? environment.PI_ORBIT_HOST ?? "127.0.0.1";
	const corsOrigin = options.corsOrigin ?? environment.PI_ORBIT_CORS_ORIGIN ?? null;
	if (appManaged && authToken === undefined) {
		throw new Error("Authentication is required in app-managed web mode");
	}
	if (!isLoopbackHost(host) && authToken === undefined) {
		throw new Error("Authentication is required for non-loopback web hosts");
	}
	if (!isLoopbackHost(host) && (corsOrigin === null || corsOrigin === "*")) {
		throw new Error("An explicit CORS origin is required for non-loopback web hosts");
	}
	const maxRuntimes = options.maxRuntimes ?? Number(environment.PI_ORBIT_MAX_RUNTIMES ?? "64");
	const idleTimeoutMs = options.idleTimeoutMs ?? Number(environment.PI_ORBIT_IDLE_TIMEOUT_MS ?? String(30 * 60_000));
	const maxConcurrentTurns = options.maxConcurrentTurns ?? Number(environment.PI_ORBIT_MAX_CONCURRENT_TURNS ?? "4");
	const requestBodyLimitBytes =
		options.requestBodyLimitBytes ?? Number(environment.PI_ORBIT_REQUEST_BODY_LIMIT_BYTES ?? String(4 * 1024 * 1024));
	const disposeTimeoutMs =
		options.disposeTimeoutMs ?? Number(environment.PI_ORBIT_RUNTIME_DISPOSE_TIMEOUT_MS ?? "10000");
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? Number(environment.PI_ORBIT_SHUTDOWN_TIMEOUT_MS ?? "15000");
	if (!Number.isInteger(maxRuntimes) || maxRuntimes < 1) {
		throw new Error(`Invalid maximum runtime count: ${maxRuntimes}`);
	}
	if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
		throw new Error(`Invalid runtime idle timeout: ${idleTimeoutMs}`);
	}
	if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1) {
		throw new Error(`Invalid maximum concurrent turn count: ${maxConcurrentTurns}`);
	}
	if (!Number.isInteger(requestBodyLimitBytes) || requestBodyLimitBytes < 1) {
		throw new Error(`Invalid request body limit: ${requestBodyLimitBytes}`);
	}
	if (!Number.isFinite(disposeTimeoutMs) || disposeTimeoutMs <= 0) {
		throw new Error(`Invalid runtime dispose timeout: ${disposeTimeoutMs}`);
	}
	if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
		throw new Error(`Invalid shutdown timeout: ${shutdownTimeoutMs}`);
	}
	return {
		port: rawPort,
		host,
		authToken,
		appManaged,
		corsOrigin,
		maxRuntimes,
		idleTimeoutMs,
		maxConcurrentTurns,
		requestBodyLimitBytes,
		disposeTimeoutMs,
		shutdownTimeoutMs,
	};
}

function isEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function createDefaultWebSessionManagerFactory(defaultSessionManager: SessionManager): WebSessionManagerFactory {
	return (cwd, runtimeOptions) => {
		if (runtimeOptions?.sessionPath) {
			return SessionManager.open(runtimeOptions.sessionPath, runtimeOptions.sessionDir, runtimeOptions.cwdOverride);
		}
		if (runtimeOptions?.sessionDir) return SessionManager.create(cwd, runtimeOptions.sessionDir);
		return defaultSessionManager.isPersisted()
			? SessionManager.create(cwd, defaultSessionManager.getSessionDir())
			: SessionManager.inMemory(cwd);
	};
}

export async function runWebMode(defaultRuntime: AgentSessionRuntime, options: RunWebModeOptions): Promise<never> {
	const config = resolveWebModeOptions(options);
	const connectionManager = new ConnectionManager();
	const defaultSessionManager = defaultRuntime.session.sessionManager;
	const createSessionManager =
		options.createSessionManager ?? createDefaultWebSessionManagerFactory(defaultSessionManager);
	const sessionHost = new WebSessionHost({
		defaultRuntime,
		connectionManager,
		createSessionManager,
		createRuntime: (cwd, sessionManager, environment) =>
			createAgentSessionRuntime(options.factory, {
				cwd,
				agentDir: options.agentDir,
				sessionManager,
				environment,
			}),
		maxRuntimes: config.maxRuntimes,
		idleTimeoutMs: config.idleTimeoutMs,
		maxConcurrentTurns: config.maxConcurrentTurns,
		disposeTimeoutMs: config.disposeTimeoutMs,
		projectTrustController: options.projectTrustController,
	});
	await sessionHost.initialize();

	const accessPolicy = new WebAccessPolicy(config.authToken);
	const serverHost = new WebServerHost(
		createApp({
			sessionHost,
			connectionManager,
			accessPolicy,
			corsOrigin: config.corsOrigin,
			requestBodyLimitBytes: config.requestBodyLimitBytes,
			projectTrustController: options.projectTrustController,
		}),
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
		await waitForShutdown(Promise.all([serverHost.close(), sessionHost.dispose()]), config.shutdownTimeoutMs);
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
		console.error(`[web] Pi Orbit server listening on http://${config.host}:${address.port}`);
		console.error(`[web] WebSocket endpoint: ws://${config.host}:${address.port}/ws`);
		console.error(`[web] Health check: http://${config.host}:${address.port}/api/health`);
		if (!accessPolicy.authenticationEnabled) {
			console.error("[web] Warning: No auth token configured. API is open to all connections.");
			console.error("[web] Set --auth-token or PI_ORBIT_AUTH_TOKEN to enable authentication.");
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

async function waitForShutdown(shutdown: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	await Promise.race([
		shutdown,
		new Promise<void>((resolve) => {
			timeout = setTimeout(() => {
				console.error(`[web] Shutdown timed out after ${timeoutMs}ms`);
				resolve();
			}, timeoutMs);
			timeout.unref();
		}),
	]);
	if (timeout) clearTimeout(timeout);
}
