import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { WebSessionHost } from "../src/modes/web/web-session-host.ts";
import { ConnectionManager, type WebSocketLike } from "../src/modes/web/ws/connection-manager.ts";

describe("web session host", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createHarness(
		options: {
			maxRuntimes?: number;
			idleTimeoutMs?: number;
			eventBufferSize?: number;
			disposeTimeoutMs?: number;
		} = {},
	) {
		const { eventBufferSize, ...hostOptions } = options;
		const root = join(tmpdir(), `pi-web-host-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage("second response"),
			fauxAssistantMessage("third response"),
		]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(root, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const factory: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const defaultManager = SessionManager.inMemory(root);
		const defaultRuntime = await createAgentSessionRuntime(factory, {
			cwd: root,
			agentDir: root,
			sessionManager: defaultManager,
		});
		const createdManagers: SessionManager[] = [];
		const connectionManager = new ConnectionManager({ eventBufferSize });
		const host = new WebSessionHost({
			...hostOptions,
			defaultRuntime,
			connectionManager,
			createRuntime: (cwd, sessionManager) =>
				createAgentSessionRuntime(factory, { cwd, agentDir: root, sessionManager }),
			createSessionManager: (cwd, runtimeOptions) => {
				const manager = runtimeOptions?.sessionPath
					? SessionManager.open(runtimeOptions.sessionPath, runtimeOptions.sessionDir, cwd)
					: runtimeOptions?.sessionDir
						? SessionManager.create(cwd, runtimeOptions.sessionDir)
						: SessionManager.inMemory(cwd);
				createdManagers.push(manager);
				return manager;
			},
		});
		await host.initialize();

		cleanups.push(async () => {
			await host.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});

		return { host, connectionManager, defaultRuntime, defaultManager, createdManagers, root };
	}

	it("creates isolated sessions with their own SessionManager and applies names", async () => {
		const { host, defaultManager, createdManagers, root } = await createHarness();
		const result = await host.createSession({ cwd: root, name: "web child" });
		const child = host.get(result.sessionId);

		expect(createdManagers).toHaveLength(1);
		expect(createdManagers[0]).not.toBe(defaultManager);
		expect(child?.runtime.session.sessionManager).toBe(createdManagers[0]);
		expect(child?.runtime.session.sessionManager.getSessionName()).toBe("web child");
	});

	it("exposes distinct runtime and persisted Pi session identities", async () => {
		const { host, defaultRuntime, root } = await createHarness();
		const defaultDescriptor = host.describe(host.defaultSessionId);

		expect(defaultDescriptor).toMatchObject({
			runtimeId: host.defaultSessionId,
			piSessionId: defaultRuntime.session.sessionId,
			sessionPath: null,
			cwd: root,
			busy: false,
		});
		expect(defaultDescriptor?.runtimeId).not.toBe(defaultDescriptor?.piSessionId);

		const created = await host.createSession({ cwd: root, name: "web child" });
		const descriptor = host.describe(created.sessionId);
		expect(descriptor).toMatchObject({
			runtimeId: created.sessionId,
			piSessionId: host.get(created.sessionId)?.runtime.session.sessionId,
			sessionPath: null,
			cwd: root,
			busy: false,
		});
		expect(descriptor?.createdAt).toBeTypeOf("number");
		expect(descriptor?.lastActivityAt).toBeTypeOf("number");
	});

	it("keeps the default session registered when deletion is requested", async () => {
		const { host } = await createHarness();
		const result = await host.removeSession(host.defaultSessionId);

		expect(result).toBe("protected");
		expect(host.get(host.defaultSessionId)).toBeDefined();
	});

	it("rebinds event streaming after the runtime replaces its AgentSession", async () => {
		const { host, connectionManager, defaultRuntime } = await createHarness();
		const sent: string[] = [];
		const client: WebSocketLike = {
			send: (data) => sent.push(data),
			close: () => {},
		};
		connectionManager.register(host.defaultSessionId, client);

		await defaultRuntime.session.prompt("first");
		sent.length = 0;
		await defaultRuntime.newSession();
		await defaultRuntime.session.prompt("second");

		expect(sent.some((message) => message.includes("second response"))).toBe(true);
	});

	it("buffers ordered runtime events even when no client is connected", async () => {
		const { host, connectionManager, defaultRuntime } = await createHarness();

		await defaultRuntime.session.prompt("background");
		const events = connectionManager.getBufferedEvents(host.defaultSessionId);

		expect(events.length).toBeGreaterThan(0);
		expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
		expect(events.every((event) => event.runtimeId === host.defaultSessionId)).toBe(true);
		expect(events.every((event) => event.piSessionId === defaultRuntime.session.sessionId)).toBe(true);
		expect(events.every((event) => event.protocolVersion === 1)).toBe(true);
	});

	it("reports a replay gap when the requested sequence predates the ring buffer", async () => {
		const { host, connectionManager, defaultRuntime } = await createHarness({ eventBufferSize: 2 });

		await defaultRuntime.session.prompt("overflow");
		const window = connectionManager.getReplayWindow(host.defaultSessionId, 0);

		expect(window.gap).toBe(true);
		expect(window.events).toHaveLength(2);
		expect(window.oldestSequence).toBeGreaterThan(1);
		expect(window.latestSequence).toBeGreaterThanOrEqual(window.oldestSequence);
	});

	it("disposes dynamically created runtimes when removed", async () => {
		const { host, root } = await createHarness();
		const result = await host.createSession({ cwd: root });
		const child = host.get(result.sessionId);
		if (!child) throw new Error("missing child runtime");
		let disposed = false;
		const originalDispose = child.runtime.dispose.bind(child.runtime);
		child.runtime.dispose = async () => {
			disposed = true;
			await originalDispose();
		};

		expect(await host.removeSession(result.sessionId)).toBe("removed");
		expect(disposed).toBe(true);
		expect(host.get(result.sessionId)).toBeUndefined();
	});

	it("does not let a stuck runtime dispose block removal indefinitely", async () => {
		const { host, root } = await createHarness({ disposeTimeoutMs: 10 });
		const created = await host.createSession({ cwd: root });
		const child = host.get(created.sessionId);
		if (!child) throw new Error("missing child runtime");
		child.runtime.dispose = () => new Promise<void>(() => {});

		await expect(host.removeSession(created.sessionId)).resolves.toBe("removed");
		expect(host.get(created.sessionId)).toBeUndefined();
	});

	it("enforces runtime capacity and evicts only idle non-busy runtimes", async () => {
		const { host, root } = await createHarness({ maxRuntimes: 2, idleTimeoutMs: 1_000 });
		const request = { cwd: root, sessionDir: join(root, "sessions") };
		const first = await host.createHostedRuntime(request);
		await expect(host.createHostedRuntime(request)).rejects.toThrow("Runtime capacity exceeded");

		const entry = host.get(first.runtimeId);
		if (!entry) throw new Error("missing child runtime");
		await entry.runtime.session.prompt("persist before eviction");
		expect(existsSync(entry.runtime.session.sessionFile ?? "")).toBe(true);
		entry.lastActivityAt = 1_000;
		const streaming = vi.spyOn(entry.runtime.session, "isStreaming", "get").mockReturnValue(true);
		expect(await host.evictIdleRuntimes(3_000)).toEqual([]);
		expect(host.get(first.runtimeId)).toBeDefined();

		streaming.mockReturnValue(false);
		expect(await host.evictIdleRuntimes(3_000)).toEqual([first.runtimeId]);
		expect(host.get(first.runtimeId)).toBeUndefined();
		expect(host.getMissingRuntimeCode(first.runtimeId)).toBe("runtime_evicted");
		expect(host.get(host.defaultSessionId)).toBeDefined();
	});

	it("never idle-evicts an in-memory runtime whose history cannot be resumed", async () => {
		const { host, root } = await createHarness({ idleTimeoutMs: 1_000 });
		const created = await host.createSession({ cwd: root });
		const entry = host.get(created.sessionId);
		if (!entry) throw new Error("missing in-memory runtime");
		entry.lastActivityAt = 1_000;

		expect(await host.evictIdleRuntimes(3_000)).toEqual([]);
		expect(host.get(created.sessionId)).toBeDefined();
	});

	it("does not evict a persisted runtime before its session file has been flushed", async () => {
		const { host, root } = await createHarness({ idleTimeoutMs: 1_000 });
		const created = await host.createHostedRuntime({
			cwd: root,
			sessionDir: join(root, "unflushed-sessions"),
		});
		const entry = host.get(created.runtimeId);
		if (!entry) throw new Error("missing persisted runtime");
		expect(entry.runtime.session.sessionFile).toBeTypeOf("string");
		expect(existsSync(entry.runtime.session.sessionFile ?? "")).toBe(false);
		entry.lastActivityAt = 1_000;

		expect(await host.evictIdleRuntimes(3_000)).toEqual([]);
		expect(host.get(created.runtimeId)).toBeDefined();
	});
});
