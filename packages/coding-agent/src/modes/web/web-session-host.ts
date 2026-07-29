import * as crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ReplacedSessionContext } from "../../core/extensions/index.ts";
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

export type WebRuntimeFactory = (
	cwd: string,
	sessionManager: SessionManager,
	runtimeEnvironment?: NodeJS.ProcessEnv,
) => Promise<AgentSessionRuntime>;
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

export class RuntimeBusyError extends Error {
	constructor() {
		super("Runtime is busy");
		this.name = "RuntimeBusyError";
	}
}

export class SessionInUseError extends Error {
	readonly runtimeId: string;
	readonly piSessionId: string;

	constructor(runtimeId: string, piSessionId: string) {
		super("Pi session is already in use");
		this.name = "SessionInUseError";
		this.runtimeId = runtimeId;
		this.piSessionId = piSessionId;
	}
}

interface RuntimeSessionIdentity {
	piSessionId: string;
	sessionPath: string | null;
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
	private readonly activeRuntimeOperations = new Map<string, "turn" | "exclusive">();
	private readonly sessionPathOwners = new Map<string, string>();
	private readonly piSessionOwners = new Map<string, string>();
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
		this.claimSessionOwnership(this.defaultRuntimeId, this.identityOf(this.defaultRuntime));
		try {
			await this.connectionManager.trackSession(this.defaultRuntimeId, this.defaultRuntime, () =>
				this.bindWebExtensions(this.defaultRuntime, this.defaultRuntimeId),
			);
			this.initialized = true;
			this.startEvictionTimer();
		} catch (error) {
			this.entries.delete(this.defaultRuntimeId);
			this.releaseSessionOwnership(this.defaultRuntimeId, this.identityOf(this.defaultRuntime));
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
		const model = session.model;
		return {
			runtimeId,
			piSessionId: session.sessionId,
			sessionPath: session.sessionFile ?? null,
			cwd: entry.runtime.cwd,
			createdAt: entry.createdAt,
			lastActivityAt: entry.lastActivityAt,
			busy:
				this.isRuntimeOperating(runtimeId) ||
				session.isStreaming ||
				session.isCompacting ||
				session.pendingMessageCount > 0,
			model: model ? { provider: model.provider, id: model.id } : null,
			qualifiedModel: model ? `${model.provider}/${model.id}` : null,
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
		const runtimeId = crypto.randomUUID();
		let claimedIdentity: RuntimeSessionIdentity | undefined;
		try {
			const sessionManager = this.createSessionManager(request.cwd, {
				sessionDir: request.sessionDir,
				sessionPath: request.sessionPath,
			});
			claimedIdentity = this.identityOfSessionManager(sessionManager);
			this.claimSessionOwnership(runtimeId, claimedIdentity);
			const runtimeEnvironment = request.runtimeEnv
				? Object.fromEntries(
						Object.entries(request.runtimeEnv).map(([key, value]) => [key, value === null ? undefined : value]),
					)
				: undefined;
			const createdRuntime = await this.createRuntime(request.cwd, sessionManager, runtimeEnvironment);
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
			const now = Date.now();
			this.entries.set(runtimeId, { runtime: createdRuntime, createdAt: now, lastActivityAt: now });
			await this.connectionManager.trackSession(
				runtimeId,
				createdRuntime,
				() => this.bindWebExtensions(createdRuntime, runtimeId),
				() => this.markActivity(runtimeId),
			);
			const descriptor = this.describe(runtimeId);
			if (!descriptor) throw new Error("Runtime registration failed");
			return descriptor;
		} catch (error) {
			this.entries.delete(runtimeId);
			this.connectionManager.removeSession(runtimeId);
			if (claimedIdentity) this.releaseSessionOwnership(runtimeId, claimedIdentity);
			if (runtime) await this.disposeRuntime(runtimeId, runtime);
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
		if (!this.tryAcquireRuntimeOperation(runtimeId)) throw new RuntimeBusyError();
		const previousIdentity = this.identityOf(entry.runtime);
		let targetIdentity: RuntimeSessionIdentity | undefined;
		let switched = false;
		try {
			const target = SessionManager.open(request.sessionPath, undefined, request.cwdOverride);
			if (request.piSessionId !== undefined && target.getSessionId() !== request.piSessionId) {
				throw new Error(
					`Pi session ID mismatch: expected ${request.piSessionId}, received ${target.getSessionId()}`,
				);
			}
			targetIdentity = this.identityOfSessionManager(target);
			this.claimSessionOwnership(runtimeId, targetIdentity);
			const result = await entry.runtime.switchSession(request.sessionPath, { cwdOverride: request.cwdOverride });
			if (!result.cancelled) {
				switched = true;
				this.replaceSessionOwnership(runtimeId, previousIdentity, this.identityOf(entry.runtime));
			}
		} finally {
			if (!switched && targetIdentity) {
				this.releaseSessionOwnershipDifference(runtimeId, targetIdentity, previousIdentity);
			}
			this.releaseRuntimeOperation(runtimeId);
		}
		return this.describe(runtimeId);
	}

	async switchSession(
		runtimeId: string,
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean } | undefined> {
		return this.switchSessionWithLease(runtimeId, sessionPath, options, false);
	}

	private async switchSessionWithLease(
		runtimeId: string,
		sessionPath: string,
		options: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> } | undefined,
		allowWithinTurn: boolean,
	): Promise<{ cancelled: boolean } | undefined> {
		const entry = this.entries.get(runtimeId);
		if (!entry) return undefined;
		const ownsLease = this.acquireLifecycleOperation(runtimeId, allowWithinTurn);
		const previousIdentity = this.identityOf(entry.runtime);
		let targetIdentity: RuntimeSessionIdentity | undefined;
		let switched = false;
		try {
			const targetManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
			targetIdentity = this.identityOfSessionManager(targetManager);
			this.claimSessionOwnership(runtimeId, targetIdentity);
			const result = await entry.runtime.switchSession(sessionPath, options);
			if (!result.cancelled) {
				switched = true;
				this.replaceSessionOwnership(runtimeId, previousIdentity, this.identityOf(entry.runtime));
			}
			return result;
		} finally {
			if (!switched && targetIdentity) {
				this.releaseSessionOwnershipDifference(runtimeId, targetIdentity, previousIdentity);
			}
			if (ownsLease) this.releaseRuntimeOperation(runtimeId);
		}
	}

	async forkSession(
		runtimeId: string,
		entryId: string,
		options?: Parameters<AgentSessionRuntime["fork"]>[1],
	): Promise<{ cancelled: boolean; selectedText?: string } | undefined> {
		return this.forkSessionWithLease(runtimeId, entryId, options, false);
	}

	private async forkSessionWithLease(
		runtimeId: string,
		entryId: string,
		options: Parameters<AgentSessionRuntime["fork"]>[1],
		allowWithinTurn: boolean,
	): Promise<{ cancelled: boolean; selectedText?: string } | undefined> {
		const entry = this.entries.get(runtimeId);
		if (!entry) return undefined;
		const ownsLease = this.acquireLifecycleOperation(runtimeId, allowWithinTurn);
		const previousIdentity = this.identityOf(entry.runtime);
		try {
			const result = await entry.runtime.fork(entryId, options);
			if (!result.cancelled) {
				this.replaceSessionOwnership(runtimeId, previousIdentity, this.identityOf(entry.runtime));
			}
			return result;
		} finally {
			if (ownsLease) this.releaseRuntimeOperation(runtimeId);
		}
	}

	async newSession(
		runtimeId: string,
		options?: Parameters<AgentSessionRuntime["newSession"]>[0],
	): Promise<{ cancelled: boolean } | undefined> {
		return this.newSessionWithLease(runtimeId, options, false);
	}

	private async newSessionWithLease(
		runtimeId: string,
		options: Parameters<AgentSessionRuntime["newSession"]>[0],
		allowWithinTurn: boolean,
	): Promise<{ cancelled: boolean } | undefined> {
		const entry = this.entries.get(runtimeId);
		if (!entry) return undefined;
		const ownsLease = this.acquireLifecycleOperation(runtimeId, allowWithinTurn);
		const previousIdentity = this.identityOf(entry.runtime);
		try {
			const result = await entry.runtime.newSession(options);
			if (!result.cancelled) {
				this.replaceSessionOwnership(runtimeId, previousIdentity, this.identityOf(entry.runtime));
			}
			return result;
		} finally {
			if (ownsLease) this.releaseRuntimeOperation(runtimeId);
		}
	}

	async runExclusiveRuntimeAction<T>(
		runtimeId: string,
		action: (runtime: AgentSessionRuntime) => Promise<T>,
	): Promise<T> {
		return this.runRuntimeActionWithLease(runtimeId, action, false);
	}

	private async runRuntimeActionWithLease<T>(
		runtimeId: string,
		action: (runtime: AgentSessionRuntime) => Promise<T>,
		allowWithinTurn: boolean,
	): Promise<T> {
		const entry = this.entries.get(runtimeId);
		if (!entry) throw new RuntimeBusyError();
		const ownsLease = this.acquireLifecycleOperation(runtimeId, allowWithinTurn);
		try {
			return await action(entry.runtime);
		} finally {
			if (ownsLease) this.releaseRuntimeOperation(runtimeId);
		}
	}

	private acquireLifecycleOperation(runtimeId: string, allowWithinTurn: boolean): boolean {
		if (allowWithinTurn && this.activeRuntimeOperations.get(runtimeId) === "turn") return false;
		if (!this.tryAcquireRuntimeOperation(runtimeId)) throw new RuntimeBusyError();
		return true;
	}

	markActivity(runtimeId: string): void {
		const entry = this.entries.get(runtimeId);
		if (entry) entry.lastActivityAt = Date.now();
	}

	tryAcquireRuntimeOperation(runtimeId: string, kind: "turn" | "exclusive" = "exclusive"): boolean {
		if (!this.entries.has(runtimeId) || this.activeRuntimeOperations.has(runtimeId)) return false;
		this.activeRuntimeOperations.set(runtimeId, kind);
		this.markActivity(runtimeId);
		return true;
	}

	canRunStreamControl(runtimeId: string): boolean {
		const operation = this.activeRuntimeOperations.get(runtimeId);
		return this.entries.has(runtimeId) && (operation === undefined || operation === "turn");
	}

	releaseRuntimeOperation(runtimeId: string): void {
		this.activeRuntimeOperations.delete(runtimeId);
		this.markActivity(runtimeId);
	}

	isRuntimeOperating(runtimeId: string): boolean {
		return this.activeRuntimeOperations.has(runtimeId);
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
		const sessionId = crypto.randomUUID();
		let claimedIdentity: RuntimeSessionIdentity | undefined;
		try {
			const cwd = request.cwd ?? process.cwd();
			const sessionManager = this.createSessionManager(cwd);
			if (request.name !== undefined) {
				const name = request.name.trim();
				if (!name) throw new Error("Session name must be non-empty");
				sessionManager.appendSessionInfo(name);
			}
			claimedIdentity = this.identityOfSessionManager(sessionManager);
			this.claimSessionOwnership(sessionId, claimedIdentity);

			const createdRuntime = await this.createRuntime(cwd, sessionManager);
			runtime = createdRuntime;
			const now = Date.now();
			this.entries.set(sessionId, { runtime: createdRuntime, createdAt: now, lastActivityAt: now });
			await this.connectionManager.trackSession(
				sessionId,
				createdRuntime,
				() => this.bindWebExtensions(createdRuntime, sessionId),
				() => this.markActivity(sessionId),
			);
			return { sessionId };
		} catch (error) {
			this.entries.delete(sessionId);
			this.connectionManager.removeSession(sessionId);
			if (claimedIdentity) this.releaseSessionOwnership(sessionId, claimedIdentity);
			if (runtime) await this.disposeRuntime(sessionId, runtime);
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
			if (
				this.isRuntimeOperating(runtimeId) ||
				session.isStreaming ||
				session.isCompacting ||
				session.pendingMessageCount > 0
			)
				continue;
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

	async removeSession(sessionId: string): Promise<"removed" | "protected" | "busy" | "not_found"> {
		const entry = this.entries.get(sessionId);
		if (!entry) return "not_found";
		if (entry.system) return "protected";
		if (!this.tryAcquireRuntimeOperation(sessionId)) return "busy";

		this.entries.delete(sessionId);
		this.releaseSessionOwnership(sessionId, this.identityOf(entry.runtime));
		this.activeRuntimeOperations.delete(sessionId);
		this.releaseAgentTurn(sessionId);
		this.connectionManager.removeSession(sessionId);
		await this.disposeRuntime(sessionId, entry.runtime);
		return "removed";
	}

	async restartSession(sessionId: string): Promise<"restarted" | "busy" | "not_found"> {
		const entry = this.entries.get(sessionId);
		if (!entry) return "not_found";
		if (!this.tryAcquireRuntimeOperation(sessionId)) return "busy";

		try {
			const sessionManager = this.createSessionManager(entry.runtime.cwd);
			const name = entry.runtime.session.sessionName;
			if (name) sessionManager.appendSessionInfo(name);
			const replacementIdentity = this.identityOfSessionManager(sessionManager);
			this.claimSessionOwnership(sessionId, replacementIdentity);
			let replacement: AgentSessionRuntime | undefined;
			try {
				const createdReplacement = await this.createRuntime(
					entry.runtime.cwd,
					sessionManager,
					entry.runtime.services.environment,
				);
				replacement = createdReplacement;
				await this.connectionManager.replaceSession(
					sessionId,
					createdReplacement,
					() => this.bindWebExtensions(createdReplacement, sessionId),
					() => this.markActivity(sessionId),
				);

				this.entries.set(sessionId, { ...entry, runtime: createdReplacement });
				this.replaceSessionOwnership(sessionId, this.identityOf(entry.runtime), replacementIdentity);
				await this.disposeRuntime(sessionId, entry.runtime);
				return "restarted";
			} catch (error) {
				this.releaseSessionOwnershipDifference(sessionId, replacementIdentity, this.identityOf(entry.runtime));
				if (replacement) await this.disposeRuntime(sessionId, replacement);
				throw error;
			}
		} finally {
			this.releaseRuntimeOperation(sessionId);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.evictionTimer) clearInterval(this.evictionTimer);
		const entries = [...this.entries];
		this.entries.clear();
		for (const [sessionId, entry] of entries) {
			this.releaseSessionOwnership(sessionId, this.identityOf(entry.runtime));
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
				newSession: async (options) =>
					(await this.newSessionWithLease(sessionId, options, true)) ?? { cancelled: true },
				fork: async (entryId, options) =>
					(await this.forkSessionWithLease(sessionId, entryId, options, true)) ?? { cancelled: true },
				navigateTree: (targetId, options) =>
					this.runRuntimeActionWithLease(
						sessionId,
						(current) => current.session.navigateTree(targetId, options),
						true,
					),
				switchSession: async (sessionPath, options) =>
					(await this.switchSessionWithLease(sessionId, sessionPath, options, true)) ?? { cancelled: true },
				reload: () => this.runRuntimeActionWithLease(sessionId, (current) => current.session.reload(), true),
			},
			onError: (error) => {
				console.error(`[web] Session ${sessionId} extension error:`, error.error);
			},
		});
	}

	private identityOf(runtime: AgentSessionRuntime): RuntimeSessionIdentity {
		return this.identityOfSessionManager(runtime.session.sessionManager);
	}

	private identityOfSessionManager(sessionManager: SessionManager): RuntimeSessionIdentity {
		const sessionPath = sessionManager.getSessionFile();
		return {
			piSessionId: sessionManager.getSessionId(),
			sessionPath: sessionPath ? this.canonicalSessionPath(sessionPath) : null,
		};
	}

	private canonicalSessionPath(sessionPath: string): string {
		const absolutePath = resolve(sessionPath);
		try {
			return realpathSync(absolutePath);
		} catch {
			try {
				return join(realpathSync(dirname(absolutePath)), basename(absolutePath));
			} catch {
				return absolutePath;
			}
		}
	}

	private claimSessionOwnership(runtimeId: string, identity: RuntimeSessionIdentity): void {
		const pathOwner = identity.sessionPath ? this.sessionPathOwners.get(identity.sessionPath) : undefined;
		const idOwner = this.piSessionOwners.get(identity.piSessionId);
		const conflictingOwner =
			pathOwner !== undefined && pathOwner !== runtimeId
				? pathOwner
				: idOwner !== undefined && idOwner !== runtimeId
					? idOwner
					: undefined;
		if (conflictingOwner) throw new SessionInUseError(conflictingOwner, identity.piSessionId);
		if (identity.sessionPath) this.sessionPathOwners.set(identity.sessionPath, runtimeId);
		this.piSessionOwners.set(identity.piSessionId, runtimeId);
	}

	private releaseSessionOwnership(runtimeId: string, identity: RuntimeSessionIdentity): void {
		if (identity.sessionPath && this.sessionPathOwners.get(identity.sessionPath) === runtimeId) {
			this.sessionPathOwners.delete(identity.sessionPath);
		}
		if (this.piSessionOwners.get(identity.piSessionId) === runtimeId) {
			this.piSessionOwners.delete(identity.piSessionId);
		}
	}

	private replaceSessionOwnership(
		runtimeId: string,
		previousIdentity: RuntimeSessionIdentity,
		nextIdentity: RuntimeSessionIdentity,
	): void {
		this.claimSessionOwnership(runtimeId, nextIdentity);
		this.releaseSessionOwnershipDifference(runtimeId, previousIdentity, nextIdentity);
	}

	private releaseSessionOwnershipDifference(
		runtimeId: string,
		identity: RuntimeSessionIdentity,
		preservedIdentity: RuntimeSessionIdentity,
	): void {
		if (
			identity.sessionPath &&
			identity.sessionPath !== preservedIdentity.sessionPath &&
			this.sessionPathOwners.get(identity.sessionPath) === runtimeId
		) {
			this.sessionPathOwners.delete(identity.sessionPath);
		}
		if (
			identity.piSessionId !== preservedIdentity.piSessionId &&
			this.piSessionOwners.get(identity.piSessionId) === runtimeId
		) {
			this.piSessionOwners.delete(identity.piSessionId);
		}
	}
}
