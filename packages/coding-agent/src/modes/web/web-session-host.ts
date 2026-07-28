import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type {
	CreateRuntimeRequest,
	CreateSessionRequest,
	CreateSessionResponse,
	RuntimeDescriptor,
	SessionSummary,
	WebSessionEntry,
} from "./types.ts";
import { createWebExtensionUIContext } from "./ui-context.ts";
import type { ConnectionManager } from "./ws/connection-manager.ts";

export type WebRuntimeFactory = (cwd: string, sessionManager: SessionManager) => Promise<AgentSessionRuntime>;
export type WebSessionManagerFactory = (
	cwd: string,
	options?: { sessionDir?: string; sessionPath?: string },
) => SessionManager;

export interface WebSessionHostOptions {
	defaultRuntime: AgentSessionRuntime;
	connectionManager: ConnectionManager;
	createRuntime: WebRuntimeFactory;
	createSessionManager: WebSessionManagerFactory;
	maxRuntimes?: number;
	idleTimeoutMs?: number;
	evictionIntervalMs?: number;
	maxConcurrentTurns?: number;
	disposeTimeoutMs?: number;
}

export class RuntimeCapacityError extends Error {
	constructor() {
		super("Runtime capacity exceeded");
		this.name = "RuntimeCapacityError";
	}
}

export class WebSessionHost {
	readonly defaultRuntimeId = crypto.randomUUID();
	private readonly entries = new Map<string, WebSessionEntry>();
	private readonly defaultRuntime: AgentSessionRuntime;
	private readonly connectionManager: ConnectionManager;
	private readonly createRuntime: WebRuntimeFactory;
	private readonly createSessionManager: WebSessionManagerFactory;
	private readonly maxRuntimes: number;
	private readonly idleTimeoutMs: number;
	private readonly evictionIntervalMs: number;
	private readonly maxConcurrentTurns: number;
	private readonly disposeTimeoutMs: number;
	private readonly evictedRuntimeIds = new Set<string>();
	private readonly activeTurnRuntimeIds = new Set<string>();
	private creatingRuntimes = 0;
	private initialized = false;
	private disposed = false;
	private evictionTimer: NodeJS.Timeout | undefined;

	constructor(options: WebSessionHostOptions) {
		this.defaultRuntime = options.defaultRuntime;
		this.connectionManager = options.connectionManager;
		this.createRuntime = options.createRuntime;
		this.createSessionManager = options.createSessionManager;
		this.maxRuntimes = options.maxRuntimes ?? 64;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
		this.evictionIntervalMs = options.evictionIntervalMs ?? Math.min(this.idleTimeoutMs, 60_000);
		this.maxConcurrentTurns = options.maxConcurrentTurns ?? 4;
		this.disposeTimeoutMs = options.disposeTimeoutMs ?? 10_000;
		if (!Number.isInteger(this.maxRuntimes) || this.maxRuntimes < 1) throw new Error("maxRuntimes must be positive");
		if (this.idleTimeoutMs <= 0) throw new Error("idleTimeoutMs must be positive");
		if (!Number.isInteger(this.maxConcurrentTurns) || this.maxConcurrentTurns < 1) {
			throw new Error("maxConcurrentTurns must be positive");
		}
		if (!Number.isFinite(this.disposeTimeoutMs) || this.disposeTimeoutMs <= 0) {
			throw new Error("disposeTimeoutMs must be positive");
		}
	}

	/** @deprecated Use defaultRuntimeId for the runtime-host API. */
	get defaultSessionId(): string {
		return this.defaultRuntimeId;
	}

	get activeTurnCount(): number {
		return this.activeTurnRuntimeIds.size;
	}

	getHealth(): {
		runtimeCount: number;
		busyRuntimeCount: number;
		activeTurnCount: number;
		maxRuntimes: number;
		maxConcurrentTurns: number;
		atCapacity: boolean;
		bufferedEventCount: number;
	} {
		let busyRuntimeCount = 0;
		for (const runtimeId of this.entries.keys()) {
			if (this.describe(runtimeId)?.busy) busyRuntimeCount++;
		}
		return {
			runtimeCount: this.entries.size,
			busyRuntimeCount,
			activeTurnCount: this.activeTurnCount,
			maxRuntimes: this.maxRuntimes,
			maxConcurrentTurns: this.maxConcurrentTurns,
			atCapacity: this.entries.size + this.creatingRuntimes >= this.maxRuntimes,
			bufferedEventCount: this.connectionManager.bufferedEventCount,
		};
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		const now = Date.now();
		this.entries.set(this.defaultRuntimeId, {
			runtime: this.defaultRuntime,
			createdAt: now,
			lastActivityAt: now,
			system: true,
		});
		try {
			await this.connectionManager.trackSession(this.defaultRuntimeId, this.defaultRuntime, () =>
				this.bindWebExtensions(this.defaultRuntime, this.defaultRuntimeId),
			);
			this.initialized = true;
			this.startEvictionTimer();
		} catch (error) {
			this.entries.delete(this.defaultRuntimeId);
			throw error;
		}
	}

	get(sessionId: string): WebSessionEntry | undefined {
		return this.entries.get(sessionId);
	}

	describe(runtimeId: string): RuntimeDescriptor | undefined {
		const entry = this.entries.get(runtimeId);
		if (!entry) return undefined;
		const session = entry.runtime.session;
		return {
			runtimeId,
			piSessionId: session.sessionId,
			sessionPath: session.sessionFile ?? null,
			cwd: entry.runtime.cwd,
			createdAt: entry.createdAt,
			lastActivityAt: entry.lastActivityAt,
			busy: session.isStreaming || session.isCompacting || session.pendingMessageCount > 0,
			model: session.model?.id ?? null,
			thinking: session.thinkingLevel ?? null,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
		};
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

	listRuntimes(): RuntimeDescriptor[] {
		return [...this.entries.keys()].flatMap((runtimeId) => {
			const descriptor = this.describe(runtimeId);
			return descriptor ? [descriptor] : [];
		});
	}

	async createHostedRuntime(request: CreateRuntimeRequest): Promise<RuntimeDescriptor> {
		if (this.disposed) throw new Error("Web session host is disposed");
		await this.acquireRuntimeSlot();
		let runtime: AgentSessionRuntime | undefined;
		let runtimeId: string | undefined;
		try {
			const sessionManager = this.createSessionManager(request.cwd, {
				sessionDir: request.sessionDir,
				sessionPath: request.sessionPath,
			});
			const createdRuntime = await this.createRuntime(request.cwd, sessionManager);
			runtime = createdRuntime;
			if (request.model !== undefined) {
				const separator = request.model.indexOf("/");
				if (separator <= 0 || separator === request.model.length - 1) {
					throw new Error("Model must use the provider/modelId format");
				}
				const provider = request.model.slice(0, separator);
				const modelId = request.model.slice(separator + 1);
				const model = (await createdRuntime.services.modelRuntime.getAvailable()).find(
					(candidate: Model<Api>) => candidate.provider === provider && candidate.id === modelId,
				);
				if (!model) throw new Error(`Model not found: ${request.model}`);
				await createdRuntime.session.setModel(model);
			}
			if (request.thinking !== undefined) {
				if (!isValidThinkingLevel(request.thinking)) throw new Error(`Invalid thinking level: ${request.thinking}`);
				createdRuntime.session.setThinkingLevel(request.thinking);
			}
			const createdRuntimeId = crypto.randomUUID();
			runtimeId = createdRuntimeId;
			const now = Date.now();
			this.entries.set(createdRuntimeId, { runtime: createdRuntime, createdAt: now, lastActivityAt: now });
			await this.connectionManager.trackSession(
				createdRuntimeId,
				createdRuntime,
				() => this.bindWebExtensions(createdRuntime, createdRuntimeId),
				() => this.markActivity(createdRuntimeId),
			);
			const descriptor = this.describe(createdRuntimeId);
			if (!descriptor) throw new Error("Runtime registration failed");
			return descriptor;
		} catch (error) {
			if (runtimeId) {
				this.entries.delete(runtimeId);
				this.connectionManager.removeSession(runtimeId);
			}
			if (runtime) await this.disposeRuntime(runtimeId ?? "unregistered", runtime);
			throw error;
		} finally {
			this.creatingRuntimes--;
		}
	}

	async resumeRuntime(
		runtimeId: string,
		request: { sessionPath: string; piSessionId?: string; cwdOverride?: string },
	): Promise<RuntimeDescriptor | undefined> {
		const entry = this.entries.get(runtimeId);
		if (!entry) return undefined;
		if (request.piSessionId !== undefined) {
			const target = SessionManager.open(request.sessionPath, undefined, request.cwdOverride);
			if (target.getSessionId() !== request.piSessionId) {
				throw new Error(
					`Pi session ID mismatch: expected ${request.piSessionId}, received ${target.getSessionId()}`,
				);
			}
		}
		await entry.runtime.switchSession(request.sessionPath, { cwdOverride: request.cwdOverride });
		entry.lastActivityAt = Date.now();
		return this.describe(runtimeId);
	}

	markActivity(runtimeId: string): void {
		const entry = this.entries.get(runtimeId);
		if (entry) entry.lastActivityAt = Date.now();
	}

	tryAcquireAgentTurn(runtimeId: string): boolean {
		if (this.activeTurnRuntimeIds.has(runtimeId)) return false;
		if (this.activeTurnRuntimeIds.size >= this.maxConcurrentTurns) return false;
		this.activeTurnRuntimeIds.add(runtimeId);
		return true;
	}

	releaseAgentTurn(runtimeId: string): void {
		this.activeTurnRuntimeIds.delete(runtimeId);
	}

	async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
		if (this.disposed) throw new Error("Web session host is disposed");
		await this.acquireRuntimeSlot();
		let runtime: AgentSessionRuntime | undefined;
		let sessionId: string | undefined;
		try {
			const cwd = request.cwd ?? process.cwd();
			const sessionManager = this.createSessionManager(cwd);
			if (request.name !== undefined) {
				const name = request.name.trim();
				if (!name) throw new Error("Session name must be non-empty");
				sessionManager.appendSessionInfo(name);
			}

			const createdRuntime = await this.createRuntime(cwd, sessionManager);
			runtime = createdRuntime;
			const createdSessionId = crypto.randomUUID();
			sessionId = createdSessionId;
			const now = Date.now();
			this.entries.set(createdSessionId, { runtime: createdRuntime, createdAt: now, lastActivityAt: now });
			await this.connectionManager.trackSession(
				createdSessionId,
				createdRuntime,
				() => this.bindWebExtensions(createdRuntime, createdSessionId),
				() => this.markActivity(createdSessionId),
			);
			return { sessionId: createdSessionId };
		} catch (error) {
			if (sessionId) {
				this.entries.delete(sessionId);
				this.connectionManager.removeSession(sessionId);
			}
			if (runtime) await this.disposeRuntime(sessionId ?? "unregistered", runtime);
			throw error;
		} finally {
			this.creatingRuntimes--;
		}
	}

	getMissingRuntimeCode(runtimeId: string): "runtime_evicted" | "runtime_not_found" {
		return this.evictedRuntimeIds.has(runtimeId) ? "runtime_evicted" : "runtime_not_found";
	}

	async evictIdleRuntimes(now = Date.now()): Promise<string[]> {
		const evicted: string[] = [];
		for (const [runtimeId, entry] of this.entries) {
			if (entry.system || now - entry.lastActivityAt < this.idleTimeoutMs) continue;
			const session = entry.runtime.session;
			if (!session.sessionManager.isPersisted() || !session.sessionFile || !existsSync(session.sessionFile))
				continue;
			if (session.isStreaming || session.isCompacting || session.pendingMessageCount > 0) continue;
			this.connectionManager.publishRuntimeEvicted(runtimeId);
			this.rememberEvictedRuntime(runtimeId);
			await this.removeSession(runtimeId);
			evicted.push(runtimeId);
		}
		return evicted;
	}

	private rememberEvictedRuntime(runtimeId: string): void {
		this.evictedRuntimeIds.add(runtimeId);
		if (this.evictedRuntimeIds.size <= 1_024) return;
		const oldest = this.evictedRuntimeIds.values().next().value;
		if (oldest !== undefined) this.evictedRuntimeIds.delete(oldest);
	}

	async removeSession(sessionId: string): Promise<"removed" | "protected" | "not_found"> {
		const entry = this.entries.get(sessionId);
		if (!entry) return "not_found";
		if (entry.system) return "protected";

		this.entries.delete(sessionId);
		this.releaseAgentTurn(sessionId);
		this.connectionManager.removeSession(sessionId);
		await this.disposeRuntime(sessionId, entry.runtime);
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
			await this.connectionManager.trackSession(
				sessionId,
				replacement,
				() => this.bindWebExtensions(replacement, sessionId),
				() => this.markActivity(sessionId),
			);
		} catch (error) {
			await this.disposeRuntime(sessionId, replacement);
			await this.connectionManager.trackSession(
				sessionId,
				entry.runtime,
				() => this.bindWebExtensions(entry.runtime, sessionId),
				() => this.markActivity(sessionId),
			);
			throw error;
		}

		this.entries.set(sessionId, { ...entry, runtime: replacement });
		await this.disposeRuntime(sessionId, entry.runtime);
		return "restarted";
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.evictionTimer) clearInterval(this.evictionTimer);
		const entries = [...this.entries];
		this.entries.clear();
		for (const [sessionId] of entries) {
			this.connectionManager.removeSession(sessionId);
		}
		await Promise.all(entries.map(([runtimeId, entry]) => this.disposeRuntime(runtimeId, entry.runtime)));
	}

	private async disposeRuntime(runtimeId: string, runtime: AgentSessionRuntime): Promise<void> {
		let timeout: NodeJS.Timeout | undefined;
		await Promise.race([
			runtime.dispose().catch((error: unknown) => {
				console.error(`[web] Runtime ${runtimeId} dispose failed:`, error);
			}),
			new Promise<void>((resolve) => {
				timeout = setTimeout(() => {
					console.error(`[web] Runtime ${runtimeId} dispose timed out after ${this.disposeTimeoutMs}ms`);
					resolve();
				}, this.disposeTimeoutMs);
				timeout.unref();
			}),
		]);
		if (timeout) clearTimeout(timeout);
	}

	private async acquireRuntimeSlot(): Promise<void> {
		await this.evictIdleRuntimes();
		if (this.entries.size + this.creatingRuntimes >= this.maxRuntimes) throw new RuntimeCapacityError();
		this.creatingRuntimes++;
	}

	private startEvictionTimer(): void {
		this.evictionTimer = setInterval(() => {
			void this.evictIdleRuntimes().catch((error: unknown) => {
				console.error("[web] Idle runtime eviction failed:", error);
			});
		}, this.evictionIntervalMs);
		this.evictionTimer.unref();
	}

	private bindWebExtensions(runtime: AgentSessionRuntime, sessionId: string): Promise<void> {
		return runtime.session.bindExtensions({
			uiContext: createWebExtensionUIContext(sessionId, this.connectionManager),
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
