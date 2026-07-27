import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { WebAccessPolicy } from "../src/modes/web/middleware/auth.ts";
import { createApp, WebServerHost } from "../src/modes/web/server.ts";
import { resolveWebModeOptions } from "../src/modes/web/web-mode.ts";
import { WebSessionHost } from "../src/modes/web/web-session-host.ts";
import { ConnectionManager } from "../src/modes/web/ws/connection-manager.ts";

describe("web mode server", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createHarness(authToken?: string) {
		const root = join(tmpdir(), `pi-web-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("websocket response"), fauxAssistantMessage("http response")]);
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
		const defaultRuntime = await createAgentSessionRuntime(factory, {
			cwd: root,
			agentDir: root,
			sessionManager: SessionManager.inMemory(root),
		});
		const connectionManager = new ConnectionManager();
		const sessionHost = new WebSessionHost({
			defaultRuntime,
			connectionManager,
			createRuntime: (cwd, sessionManager) =>
				createAgentSessionRuntime(factory, { cwd, agentDir: root, sessionManager }),
			createSessionManager: (cwd) => SessionManager.inMemory(cwd),
		});
		await sessionHost.initialize();
		const serverHost = new WebServerHost(
			createApp({
				sessionHost,
				connectionManager,
				accessPolicy: new WebAccessPolicy(authToken),
			}),
		);
		const address = await serverHost.start(0, "127.0.0.1");

		cleanups.push(async () => {
			await sessionHost.dispose();
			await serverHost.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});

		return {
			baseUrl: `http://127.0.0.1:${address.port}`,
			wsUrl: `ws://127.0.0.1:${address.port}`,
			sessionHost,
		};
	}

	it("uses one resolved auth policy for HTTP and WebSocket", async () => {
		const { baseUrl, wsUrl, sessionHost } = await createHarness("secret");
		expect((await fetch(`${baseUrl}/api/sessions`)).status).toBe(401);
		expect(
			(
				await fetch(`${baseUrl}/api/sessions`, {
					headers: { Authorization: "Bearer secret" },
				})
			).status,
		).toBe(200);

		const rejected = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}&token=wrong`);
		rejected.on("error", () => {});
		const [error] = await once(rejected, "unexpected-response");
		expect(error).toBeDefined();
	});

	it("streams events through the maintained WebSocket adapter after accepting a command", async () => {
		const { wsUrl, sessionHost } = await createHarness();
		const websocket = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}`);
		await once(websocket, "open");
		cleanups.push(() => websocket.close());

		const response = new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket response")), 5000);
			websocket.on("message", (data) => {
				const message = data.toString();
				if (message.includes("websocket response")) {
					clearTimeout(timeout);
					resolve(message);
				}
			});
		});
		websocket.send(JSON.stringify({ type: "prompt", message: "hello" }));

		expect(await response).toContain("websocket response");
	});

	it("returns 202 for REST prompts and protects the default session", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const prompt = await fetch(`${baseUrl}/api/sessions/${sessionHost.defaultSessionId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(prompt.status).toBe(202);

		const deletion = await fetch(`${baseUrl}/api/sessions/${sessionHost.defaultSessionId}`, { method: "DELETE" });
		expect(deletion.status).toBe(403);
		expect(sessionHost.get(sessionHost.defaultSessionId)).toBeDefined();
	});

	it("resolves environment authentication once and rejects invalid environment ports", () => {
		expect(resolveWebModeOptions({}, { PI_WEB_AUTH_TOKEN: "from-env" }).authToken).toBe("from-env");
		expect(() => resolveWebModeOptions({}, { PI_WEB_PORT: "invalid" })).toThrow("Invalid web port");
	});
});
