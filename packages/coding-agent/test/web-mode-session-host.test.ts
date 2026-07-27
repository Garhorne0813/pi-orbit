import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
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

	async function createHarness() {
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
		const connectionManager = new ConnectionManager();
		const host = new WebSessionHost({
			defaultRuntime,
			connectionManager,
			createRuntime: (cwd, sessionManager) =>
				createAgentSessionRuntime(factory, { cwd, agentDir: root, sessionManager }),
			createSessionManager: (cwd) => {
				const manager = SessionManager.inMemory(cwd);
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
});
