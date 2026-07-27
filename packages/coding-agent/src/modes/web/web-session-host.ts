import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import type { CreateSessionRequest, CreateSessionResponse, SessionSummary, WebSessionEntry } from "./types.ts";
import type { ConnectionManager } from "./ws/connection-manager.ts";

export type WebRuntimeFactory = (cwd: string, sessionManager: SessionManager) => Promise<AgentSessionRuntime>;
export type WebSessionManagerFactory = (cwd: string) => SessionManager;

export interface WebSessionHostOptions {
	defaultRuntime: AgentSessionRuntime;
	connectionManager: ConnectionManager;
	createRuntime: WebRuntimeFactory;
	createSessionManager: WebSessionManagerFactory;
}

export class WebSessionHost {
	readonly defaultSessionId = crypto.randomUUID();
	private readonly entries = new Map<string, WebSessionEntry>();
	private readonly defaultRuntime: AgentSessionRuntime;
	private readonly connectionManager: ConnectionManager;
	private readonly createRuntime: WebRuntimeFactory;
	private readonly createSessionManager: WebSessionManagerFactory;
	private initialized = false;
	private disposed = false;

	constructor(options: WebSessionHostOptions) {
		this.defaultRuntime = options.defaultRuntime;
		this.connectionManager = options.connectionManager;
		this.createRuntime = options.createRuntime;
		this.createSessionManager = options.createSessionManager;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.entries.set(this.defaultSessionId, {
			runtime: this.defaultRuntime,
			createdAt: Date.now(),
			system: true,
		});
		try {
			await this.connectionManager.trackSession(this.defaultSessionId, this.defaultRuntime, () =>
				this.bindWebExtensions(this.defaultRuntime, this.defaultSessionId),
			);
			this.initialized = true;
		} catch (error) {
			this.entries.delete(this.defaultSessionId);
			throw error;
		}
	}

	get(sessionId: string): WebSessionEntry | undefined {
		return this.entries.get(sessionId);
	}

	list(): SessionSummary[] {
		return [...this.entries].map(([id, entry]) => ({
			id,
			name: entry.runtime.session.sessionManager.getSessionName() ?? undefined,
			cwd: entry.runtime.cwd,
			createdAt: entry.createdAt,
			model: entry.runtime.session.model?.id,
		}));
	}

	async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
		if (this.disposed) throw new Error("Web session host is disposed");
		const cwd = request.cwd ?? process.cwd();
		const sessionManager = this.createSessionManager(cwd);
		if (request.name !== undefined) {
			const name = request.name.trim();
			if (!name) throw new Error("Session name must be non-empty");
			sessionManager.appendSessionInfo(name);
		}

		const runtime = await this.createRuntime(cwd, sessionManager);
		const sessionId = crypto.randomUUID();
		try {
			await this.connectionManager.trackSession(sessionId, runtime, () =>
				this.bindWebExtensions(runtime, sessionId),
			);
			this.entries.set(sessionId, { runtime, createdAt: Date.now() });
			return { sessionId };
		} catch (error) {
			await runtime.dispose().catch(() => {});
			throw error;
		}
	}

	async removeSession(sessionId: string): Promise<"removed" | "protected" | "not_found"> {
		const entry = this.entries.get(sessionId);
		if (!entry) return "not_found";
		if (entry.system) return "protected";

		this.entries.delete(sessionId);
		this.connectionManager.removeSession(sessionId);
		await entry.runtime.dispose();
		return "removed";
	}

	async restartSession(sessionId: string): Promise<"restarted" | "not_found"> {
		const entry = this.entries.get(sessionId);
		if (!entry) return "not_found";

		const sessionManager = this.createSessionManager(entry.runtime.cwd);
		const name = entry.runtime.session.sessionName;
		if (name) sessionManager.appendSessionInfo(name);
		const replacement = await this.createRuntime(entry.runtime.cwd, sessionManager);

		this.connectionManager.removeSession(sessionId);
		try {
			await this.connectionManager.trackSession(sessionId, replacement, () =>
				this.bindWebExtensions(replacement, sessionId),
			);
		} catch (error) {
			await replacement.dispose().catch(() => {});
			await this.connectionManager.trackSession(sessionId, entry.runtime, () =>
				this.bindWebExtensions(entry.runtime, sessionId),
			);
			throw error;
		}

		this.entries.set(sessionId, { ...entry, runtime: replacement });
		await entry.runtime.dispose().catch((error: unknown) => {
			console.error(`[web] Session ${sessionId} restart cleanup failed:`, error);
		});
		return "restarted";
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const entries = [...this.entries];
		this.entries.clear();
		for (const [sessionId] of entries) {
			this.connectionManager.removeSession(sessionId);
		}
		await Promise.all(entries.map(([, entry]) => entry.runtime.dispose().catch(() => {})));
	}

	private bindWebExtensions(runtime: AgentSessionRuntime, sessionId: string): Promise<void> {
		return runtime.session.bindExtensions({
			mode: "web",
			commandContextActions: {
				waitForIdle: () => runtime.session.agent.waitForIdle(),
				newSession: async (options) => runtime.newSession(options),
				fork: async (entryId, options) => runtime.fork(entryId, options),
				navigateTree: async (targetId, options) => runtime.session.navigateTree(targetId, options),
				switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => runtime.session.reload(),
			},
			onError: (error) => {
				console.error(`[web] Session ${sessionId} extension error:`, error.error);
			},
		});
	}
}
