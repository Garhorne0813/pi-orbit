import { once } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

	async function createHarness(
		options: {
			authToken?: string;
			configureApiKey?: boolean;
			promptRateLimit?: { limit: number; windowMs: number };
			corsOrigin?: string;
			heartbeatIntervalMs?: number;
			persistedSession?: boolean;
		} = {},
	) {
		const root = join(tmpdir(), `pi-web-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("websocket response"), fauxAssistantMessage("http response")]);
		const authStorage = AuthStorage.inMemory();
		if (options.configureApiKey !== false) {
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		}
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
			sessionManager: options.persistedSession
				? SessionManager.create(root, join(root, "sessions"))
				: SessionManager.inMemory(root),
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
				accessPolicy: new WebAccessPolicy(options.authToken),
				promptRateLimit: options.promptRateLimit,
				corsOrigin: options.corsOrigin,
			}),
			{ heartbeatIntervalMs: options.heartbeatIntervalMs },
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
			authStorage,
			root,
		};
	}

	it("uses one resolved auth policy for HTTP and WebSocket", async () => {
		const { baseUrl, wsUrl, sessionHost } = await createHarness({ authToken: "secret" });
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
		const queryToken = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}&token=secret`);
		queryToken.on("error", () => {});
		expect(await once(queryToken, "unexpected-response")).toBeDefined();

		const authorized = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}`, {
			headers: { Authorization: "Bearer secret" },
		});
		await once(authorized, "open");
		authorized.close();
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

	it("terminates WebSocket clients that stop answering heartbeats", async () => {
		const { wsUrl, sessionHost } = await createHarness({ heartbeatIntervalMs: 20 });
		const websocket = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}`, { autoPong: false });
		await once(websocket, "open");
		await Promise.race([
			once(websocket, "close"),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("WebSocket heartbeat did not close client")), 250),
			),
		]);
	});

	it("streams the same session events over SSE", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing SSE response body");

		await sessionHost.get(sessionId)?.runtime.session.prompt("hello");
		let received = "";
		while (!received.includes("websocket response")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += new TextDecoder().decode(chunk.value);
		}
		await reader.cancel();
		expect(received).toContain("websocket response");
	});

	it("returns 202 for REST prompts and protects the default session", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const prompt = await fetch(`${baseUrl}/api/sessions/${sessionHost.defaultSessionId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(prompt.status).toBe(202);
		expect(await prompt.json()).toEqual({ success: true });

		const deletion = await fetch(`${baseUrl}/api/sessions/${sessionHost.defaultSessionId}`, { method: "DELETE" });
		expect(deletion.status).toBe(403);
		expect(sessionHost.get(sessionHost.defaultSessionId)).toBeDefined();
	});

	it("restarts the protected default session without changing its web session id", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const previousRuntime = sessionHost.get(sessionId)?.runtime;
		if (!previousRuntime) throw new Error("missing default runtime");

		const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/restart`, { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(sessionHost.get(sessionId)?.runtime).not.toBe(previousRuntime);
	});

	it("reports prompt preflight failures to REST clients", async () => {
		const { baseUrl, sessionHost } = await createHarness({ configureApiKey: false });
		const response = await fetch(`${baseUrl}/api/sessions/${sessionHost.defaultSessionId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: "Failed to execute prompt command" });
	});

	it("rate limits prompt requests per session", async () => {
		const { baseUrl, sessionHost } = await createHarness({
			configureApiKey: false,
			promptRateLimit: { limit: 1, windowMs: 60_000 },
		});
		const url = `${baseUrl}/api/sessions/${sessionHost.defaultSessionId}/prompt`;
		const request = () =>
			fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "hello" }),
			});

		expect((await request()).status).toBe(500);
		expect((await request()).status).toBe(429);
	});

	it("exposes session state, history, tree, statistics, and renaming APIs", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const runtime = sessionHost.get(sessionId)?.runtime;
		if (!runtime) throw new Error("missing default runtime");
		await runtime.session.prompt("hello");

		const state = await fetch(`${baseUrl}/api/sessions/${sessionId}/state`);
		expect(state.status).toBe(200);
		expect(await state.json()).toMatchObject({ sessionId: runtime.session.sessionId, messageCount: 2 });

		const stats = await fetch(`${baseUrl}/api/sessions/${sessionId}/stats`);
		expect(await stats.json()).toMatchObject({ totalMessages: 2, userMessages: 1, assistantMessages: 1 });

		const messages = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
		const messagesBody = (await messages.json()) as { messages: unknown[] };
		expect(messagesBody.messages).toHaveLength(2);

		const entries = await fetch(`${baseUrl}/api/sessions/${sessionId}/entries`);
		const entriesBody = (await entries.json()) as { entries: Array<{ id: string }>; leafId: string | null };
		expect(entriesBody.entries.length).toBeGreaterThanOrEqual(2);
		expect(entriesBody.leafId).toBeTypeOf("string");
		const incremental = await fetch(
			`${baseUrl}/api/sessions/${sessionId}/entries?since=${entriesBody.entries[0]?.id}`,
		);
		expect(((await incremental.json()) as { entries: unknown[] }).entries).toHaveLength(
			entriesBody.entries.length - 1,
		);

		const tree = await fetch(`${baseUrl}/api/sessions/${sessionId}/tree`);
		const treeBody = (await tree.json()) as { tree: unknown[]; leafId: string | null };
		expect(treeBody.tree.length).toBeGreaterThanOrEqual(1);
		expect(treeBody.leafId).toBe(entriesBody.leafId);

		const renamed = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "renamed" }),
		});
		expect(renamed.status).toBe(200);
		expect(runtime.session.sessionName).toBe("renamed");
	});

	it("returns tool results and requires exact provider/model selection", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const runtime = sessionHost.get(sessionId)?.runtime;
		if (!runtime) throw new Error("missing default runtime");
		const model = (await runtime.services.modelRuntime.getAvailable())[0];
		if (!model) throw new Error("missing registered model");

		const bash = await fetch(`${baseUrl}/api/sessions/${sessionId}/bash`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "printf web-result" }),
		});
		expect(await bash.json()).toMatchObject({ output: "web-result", exitCode: 0 });

		const exact = await fetch(`${baseUrl}/api/sessions/${sessionId}/model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider: model.provider, modelId: model.id }),
		});
		expect(exact.status).toBe(200);

		const prefix = await fetch(`${baseUrl}/api/sessions/${sessionId}/model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider: model.provider, modelId: model.id.slice(0, -1) }),
		});
		expect(prefix.status).toBe(404);
	});

	it("clones and exports an active session", async () => {
		const { baseUrl, sessionHost, root } = await createHarness({ persistedSession: true });
		const sessionId = sessionHost.defaultSessionId;
		const runtime = sessionHost.get(sessionId)?.runtime;
		if (!runtime) throw new Error("missing default runtime");
		await runtime.session.prompt("hello");

		const outputPath = join(root, "session.html");
		const exported = await fetch(`${baseUrl}/api/sessions/${sessionId}/export`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ outputPath }),
		});
		expect(await exported.json()).toEqual({ path: outputPath });
		expect(existsSync(outputPath)).toBe(true);

		const cloned = await fetch(`${baseUrl}/api/sessions/${sessionId}/clone`, { method: "POST" });
		expect(await cloned.json()).toMatchObject({ success: true, cancelled: false });
	});

	it("resolves environment authentication once and rejects invalid environment ports", () => {
		expect(resolveWebModeOptions({}, { PI_WEB_AUTH_TOKEN: "from-env" }).authToken).toBe("from-env");
		expect(resolveWebModeOptions({}, { PI_WEB_CORS_ORIGIN: "https://control.example" }).corsOrigin).toBe(
			"https://control.example",
		);
		expect(() => resolveWebModeOptions({}, { PI_WEB_PORT: "invalid" })).toThrow("Invalid web port");
	});

	it("uses the configured CORS origin", async () => {
		const { baseUrl } = await createHarness({ corsOrigin: "https://control.example" });
		const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://control.example" } });
		expect(response.headers.get("access-control-allow-origin")).toBe("https://control.example");
	});
});
