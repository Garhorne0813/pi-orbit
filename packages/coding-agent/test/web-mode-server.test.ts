import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createWebExtensionUIContext } from "../src/modes/web/ui-context.ts";
import { createDefaultWebSessionManagerFactory, resolveWebModeOptions } from "../src/modes/web/web-mode.ts";
import { WebSessionHost } from "../src/modes/web/web-session-host.ts";
import { ConnectionManager, type WebSocketLike } from "../src/modes/web/ws/connection-manager.ts";

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
			corsOrigin?: string | null;
			heartbeatIntervalMs?: number;
			persistedSession?: boolean;
			maxConcurrentTurns?: number;
			requestBodyLimitBytes?: number;
			projectTrustRequired?: boolean;
			runtimeInitializationError?: string;
		} = {},
	) {
		const root = join(tmpdir(), `pi-web-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
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
			environment,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				environment,
				modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			const runtime = {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics:
					options.runtimeInitializationError === undefined
						? services.diagnostics
						: [{ type: "error" as const, message: options.runtimeInitializationError }],
			};
			return runtime;
		};
		const defaultRuntime = await createAgentSessionRuntime(factory, {
			cwd: root,
			agentDir: root,
			sessionManager: options.persistedSession
				? SessionManager.create(root, join(root, "sessions"))
				: SessionManager.inMemory(root),
		});
		const connectionManager = new ConnectionManager();
		const projectTrustDecisions = new Map<string, boolean | null>();
		const getProjectTrustStatus = (cwd: string) => {
			const workspaceCwd = realpathSync(cwd);
			return {
				cwd: workspaceCwd,
				required: options.projectTrustRequired === true,
				decision: options.projectTrustRequired === true ? (projectTrustDecisions.get(workspaceCwd) ?? null) : true,
			};
		};
		const projectTrustController = {
			getStatus: getProjectTrustStatus,
			setDecision: (cwd: string, decision: boolean | null) => {
				projectTrustDecisions.set(realpathSync(cwd), decision);
				return getProjectTrustStatus(cwd);
			},
		};
		const sessionHost = new WebSessionHost({
			defaultRuntime,
			connectionManager,
			createRuntime: (cwd, sessionManager, environment) =>
				createAgentSessionRuntime(factory, { cwd, agentDir: root, sessionManager, environment }),
			createSessionManager: createDefaultWebSessionManagerFactory(defaultRuntime.session.sessionManager),
			maxConcurrentTurns: options.maxConcurrentTurns,
			projectTrustController,
		});
		await sessionHost.initialize();
		const serverHost = new WebServerHost(
			createApp({
				sessionHost,
				connectionManager,
				accessPolicy: new WebAccessPolicy(options.authToken),
				promptRateLimit: options.promptRateLimit,
				corsOrigin: options.corsOrigin,
				requestBodyLimitBytes: options.requestBodyLimitBytes,
				projectTrustController,
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
			connectionManager,
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

	it("exposes the versioned runtime host contract and distinct runtime identities", async () => {
		const { baseUrl, sessionHost, root } = await createHarness();

		const capabilities = await fetch(`${baseUrl}/api/capabilities`);
		expect(capabilities.status).toBe(200);
		expect(await capabilities.json()).toMatchObject({
			protocolVersion: 1,
			features: {
				runtimeApi: true,
				eventReplay: true,
				atomicEventReplay: true,
				runtimeOperationLeases: true,
				qualifiedModelIdentity: true,
				runtimeEnvironment: true,
			},
		});

		const listed = await fetch(`${baseUrl}/api/runtimes`);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual([
			expect.objectContaining({
				runtimeId: sessionHost.defaultSessionId,
				piSessionId: sessionHost.get(sessionHost.defaultSessionId)?.runtime.session.sessionId,
			}),
		]);

		const created = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir: join(root, "runtime-sessions") }),
		});
		expect(created.status).toBe(201);
		const descriptor = (await created.json()) as {
			runtimeId: string;
			piSessionId: string;
			sessionPath: string | null;
		};
		expect(descriptor.runtimeId).not.toBe(descriptor.piSessionId);
		expect(descriptor.sessionPath).toContain(join(root, "runtime-sessions"));

		const fetched = await fetch(`${baseUrl}/api/runtimes/${descriptor.runtimeId}`);
		expect(fetched.status).toBe(200);
		expect(await fetched.json()).toMatchObject(descriptor);
	});

	it("uses the host session directory when runtime sessionDir is omitted", async () => {
		const { baseUrl, root } = await createHarness({ persistedSession: true });
		const response = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			workspaceCwd: realpathSync(root),
			persisted: true,
		});
	});

	it("reports runtime capacity, activity, and event buffer metrics in health checks", async () => {
		const { baseUrl } = await createHarness({ maxConcurrentTurns: 2 });
		const response = await fetch(`${baseUrl}/api/health`);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "ok",
			protocolVersion: 1,
			runtimeHost: {
				runtimeCount: 1,
				busyRuntimeCount: 0,
				activeTurnCount: 0,
				maxRuntimes: 64,
				maxConcurrentTurns: 2,
				atCapacity: false,
				bufferedEventCount: 0,
			},
		});
	});

	it("executes runtime commands with both identities and resumes an explicit session path", async () => {
		const { baseUrl, root } = await createHarness();
		const create = () =>
			fetch(`${baseUrl}/api/runtimes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: root, sessionDir: join(root, "runtime-sessions") }),
			});
		const source = (await (await create()).json()) as {
			runtimeId: string;
			piSessionId: string;
			sessionPath: string;
		};
		const prompt = await fetch(`${baseUrl}/api/runtimes/${source.runtimeId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "persist me" }),
		});
		expect(prompt.status).toBe(202);
		expect(await prompt.json()).toMatchObject({
			success: true,
			runtimeId: source.runtimeId,
			piSessionId: source.piSessionId,
		});

		const target = (await (await create()).json()) as { runtimeId: string; piSessionId: string };
		const conflict = await fetch(`${baseUrl}/api/runtimes/${target.runtimeId}/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: source.sessionPath, piSessionId: source.piSessionId }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ code: "session_in_use" });
		expect((await fetch(`${baseUrl}/api/runtimes/${source.runtimeId}`, { method: "DELETE" })).status).toBe(200);

		const resumed = await fetch(`${baseUrl}/api/runtimes/${target.runtimeId}/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: source.sessionPath, piSessionId: source.piSessionId }),
		});
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toMatchObject({
			runtimeId: target.runtimeId,
			piSessionId: source.piSessionId,
			sessionPath: source.sessionPath,
			busy: false,
		});

		const mismatch = await fetch(`${baseUrl}/api/runtimes/${target.runtimeId}/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: source.sessionPath, piSessionId: "different-session" }),
		});
		expect(mismatch.status).toBe(409);
		expect(await mismatch.json()).toMatchObject({ code: "pi_session_mismatch", retryable: false });
	});

	it("uses runtime sessionDir and sessionPath instead of the CLI startup session directory", async () => {
		const root = join(tmpdir(), `pi-web-session-factory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const startupDir = join(root, "startup");
		const runtimeDir = join(root, "runtime");
		mkdirSync(root, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const startup = SessionManager.create(root, startupDir);
		const createManager = createDefaultWebSessionManagerFactory(startup);
		const created = createManager(root, { sessionDir: runtimeDir });
		created.appendMessage({ role: "user", content: "persisted", timestamp: Date.now() });
		created.appendMessage(fauxAssistantMessage("persisted response"));
		const sessionPath = created.getSessionFile();
		if (!sessionPath) throw new Error("missing persisted session path");

		expect(sessionPath).toContain(runtimeDir);
		const resumed = createManager(root, { sessionDir: runtimeDir, sessionPath });
		expect(resumed.getSessionId()).toBe(created.getSessionId());
		expect(resumed.getEntries()).toHaveLength(created.getEntries().length);
		expect(sessionPath).not.toContain(startupDir);
	});

	it("rejects cross-workspace runtime creation and resume", async () => {
		const { baseUrl, root } = await createHarness();
		const firstWorkspace = join(root, "workspace-a");
		const secondWorkspace = join(root, "workspace-b");
		mkdirSync(firstWorkspace, { recursive: true });
		mkdirSync(secondWorkspace, { recursive: true });
		const source = SessionManager.create(secondWorkspace, join(root, "source-sessions"));
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		source.appendMessage(fauxAssistantMessage("source response"));
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("missing source session path");

		const mismatchedCreate = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cwd: firstWorkspace,
				sessionDir: join(root, "target-sessions"),
				sessionPath: sourcePath,
			}),
		});
		expect(mismatchedCreate.status).toBe(409);
		expect(await mismatchedCreate.json()).toMatchObject({ code: "runtime_workspace_mismatch" });

		const target = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: firstWorkspace, sessionDir: join(root, "target-sessions") }),
		});
		const { runtimeId } = (await target.json()) as { runtimeId: string };
		const mismatchedResume = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: sourcePath }),
		});
		expect(mismatchedResume.status).toBe(409);
		expect(await mismatchedResume.json()).toMatchObject({ code: "runtime_workspace_mismatch" });
	});

	it("requires an explicit project trust decision before creating a runtime", async () => {
		const { baseUrl, root } = await createHarness({ projectTrustRequired: true });
		const createRuntime = () =>
			fetch(`${baseUrl}/api/runtimes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: root }),
			});

		const blocked = await createRuntime();
		expect(blocked.status).toBe(409);
		expect(await blocked.json()).toMatchObject({ code: "project_trust_required", cwd: realpathSync(root) });
		const blockedLegacySession = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root }),
		});
		expect(blockedLegacySession.status).toBe(409);
		expect(await blockedLegacySession.json()).toMatchObject({ code: "project_trust_required" });

		const status = await fetch(`${baseUrl}/api/project-trust?cwd=${encodeURIComponent(root)}`);
		expect(await status.json()).toEqual({ cwd: realpathSync(root), required: true, decision: null });
		const decision = await fetch(`${baseUrl}/api/project-trust`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, decision: true }),
		});
		expect(decision.status).toBe(200);
		expect(await decision.json()).toEqual({ cwd: realpathSync(root), required: true, decision: true });
		expect((await createRuntime()).status).toBe(201);
	});

	it("returns runtime initialization diagnostics instead of a partially usable runtime", async () => {
		const { baseUrl, root } = await createHarness({ runtimeInitializationError: "extension failed" });
		const response = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root }),
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Runtime initialization failed",
			code: "runtime_initialization_failed",
			diagnostics: [{ type: "error", message: "extension failed" }],
		});
	});

	it("rejects opening a persisted Pi session that is already owned by another runtime", async () => {
		const { baseUrl, root } = await createHarness();
		const sessionDir = join(root, "owned-sessions");
		const sourceResponse = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir }),
		});
		const source = (await sourceResponse.json()) as {
			runtimeId: string;
			piSessionId: string;
			sessionPath: string;
		};
		await fetch(`${baseUrl}/api/runtimes/${source.runtimeId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "persist ownership" }),
		});

		const conflict = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir, sessionPath: source.sessionPath }),
		});

		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			code: "session_in_use",
			piSessionId: source.piSessionId,
		});
	});

	it("detects session ownership through symlink and duplicate Pi session identities", async () => {
		const { baseUrl, root } = await createHarness();
		const sessionDir = join(root, "identity-sessions");
		const manager = SessionManager.create(root, sessionDir);
		manager.appendMessage({ role: "user", content: "owned", timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("owned response"));
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("missing persisted session path");
		const ownerResponse = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir, sessionPath }),
		});
		expect(ownerResponse.status).toBe(201);

		const symlinkPath = join(root, "session-link.jsonl");
		symlinkSync(sessionPath, symlinkPath);
		const duplicatePath = join(root, "session-copy.jsonl");
		copyFileSync(sessionPath, duplicatePath);
		for (const candidate of [symlinkPath, duplicatePath]) {
			const conflict = await fetch(`${baseUrl}/api/runtimes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: root, sessionDir, sessionPath: candidate }),
			});
			expect(conflict.status, candidate).toBe(409);
			expect(await conflict.json()).toMatchObject({
				code: "session_in_use",
				piSessionId: manager.getSessionId(),
			});
		}
	});

	it("applies explicit model and thinking settings while creating a runtime", async () => {
		const { baseUrl, sessionHost, root } = await createHarness();
		const defaultRuntime = sessionHost.get(sessionHost.defaultSessionId)?.runtime;
		const model = (await defaultRuntime?.services.modelRuntime.getAvailable())?.[0];
		if (!model) throw new Error("missing model");

		const response = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				sessionDir: join(root, "runtime-sessions"),
				model: `${model.provider}/${model.id}`,
				thinking: "high",
			}),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			model: { provider: model.provider, id: model.id },
			qualifiedModel: `${model.provider}/${model.id}`,
			thinking: "high",
		});
	});

	it("updates thinking and reconciles state through runtime-host endpoints", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const runtimeId = sessionHost.defaultRuntimeId;
		const updated = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/thinking`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ level: "low" }),
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({
			success: true,
			runtimeId,
			piSessionId: sessionHost.get(runtimeId)?.runtime.session.sessionId,
			level: "low",
		});

		const state = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/state`);
		expect(state.status).toBe(200);
		expect(await state.json()).toMatchObject({
			runtimeId,
			piSessionId: sessionHost.get(runtimeId)?.runtime.session.sessionId,
			thinkingLevel: "low",
			isStreaming: false,
			isCompacting: false,
			messageCount: 0,
			pendingMessageCount: 0,
		});
	});

	it("lists extension, prompt-template, and skill commands through the runtime API", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const response = await fetch(`${baseUrl}/api/runtimes/${sessionHost.defaultRuntimeId}/commands`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ commands: [] });
	});

	it("applies runtime-scoped execution environments without changing process.env", async () => {
		const { baseUrl, root } = await createHarness();
		const key = `PI_ORBIT_RUNTIME_ENV_${Date.now()}`;
		const original = process.env[key];
		const createRuntime = async (value: string) => {
			const response = await fetch(`${baseUrl}/api/runtimes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					cwd: root,
					sessionDir: join(root, `runtime-env-${value}`),
					runtimeEnv: { [key]: value },
				}),
			});
			expect(response.status).toBe(201);
			return ((await response.json()) as { runtimeId: string }).runtimeId;
		};
		const firstRuntimeId = await createRuntime("first");
		const secondRuntimeId = await createRuntime("second");
		const readEnvironment = (runtimeId: string) =>
			fetch(`${baseUrl}/api/sessions/${runtimeId}/bash`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: `printf %s "$${key}"` }),
			});

		const [first, second] = await Promise.all([readEnvironment(firstRuntimeId), readEnvironment(secondRuntimeId)]);
		expect(await first.json()).toMatchObject({ output: "first", exitCode: 0 });
		expect(await second.json()).toMatchObject({ output: "second", exitCode: 0 });
		expect(process.env[key]).toBe(original);
	});

	it("uses process-level resources and rejects runtime-scoped extension overrides", async () => {
		const { baseUrl, root } = await createHarness();
		const capabilities = await fetch(`${baseUrl}/api/capabilities`);
		expect(await capabilities.json()).toMatchObject({
			isolationModel: "single-user-shared-process",
			supportsRuntimeEnvironment: true,
			features: { runtimeResourceOverrides: false },
		});

		for (const override of [{ skills: ["/tmp/skill"] }, { extensions: ["/tmp/extension.ts"] }]) {
			const response = await fetch(`${baseUrl}/api/runtimes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: root, sessionDir: join(root, "runtime-sessions"), ...override }),
			});
			expect(response.status).toBe(400);
		}
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

	it("resolves extension UI dialogs through the matching session WebSocket", async () => {
		const { wsUrl, sessionHost, connectionManager } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const websocket = new WebSocket(`${wsUrl}/ws?session_id=${sessionId}`);
		await once(websocket, "open");
		cleanups.push(() => websocket.close());
		const ui = createWebExtensionUIContext(sessionId, connectionManager);

		websocket.once("message", (data) => {
			const request = JSON.parse(data.toString()) as { type: string; id: string; method: string };
			expect(request).toMatchObject({ type: "extension_ui_request", method: "confirm" });
			websocket.send(JSON.stringify({ type: "extension_ui_response", id: request.id, confirmed: true }));
		});

		await expect(ui.confirm("Permission", "Continue?")).resolves.toBe(true);
	});

	it("accepts extension UI responses over the runtime HTTP API", async () => {
		const { baseUrl, sessionHost, connectionManager } = await createHarness();
		const runtimeId = sessionHost.defaultSessionId;
		const client: WebSocketLike = { send: () => {}, close: () => {} };
		connectionManager.register(runtimeId, client, { eventFormat: "envelope" });
		const resolved = new Promise<boolean>((resolve) => {
			connectionManager.registerUIRequest(runtimeId, "request-1", (response) => {
				if (!("confirmed" in response)) return false;
				resolve(response.confirmed);
				return true;
			});
		});

		const response = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/ui-response`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "extension_ui_response", id: "request-1", confirmed: true }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			runtimeId,
			piSessionId: sessionHost.get(runtimeId)?.runtime.session.sessionId,
		});
		await expect(resolved).resolves.toBe(true);
		connectionManager.unregister(runtimeId, client);
	});

	it("handles extension UI fallback, timeout, abort, and fire-and-forget messages", async () => {
		const { wsUrl, sessionHost, connectionManager } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const ui = createWebExtensionUIContext(sessionId, connectionManager);
		await expect(ui.confirm("No client", "Continue?")).resolves.toBe(false);

		const websocket = new WebSocket(`${wsUrl}/ws?session_id=${sessionId}`);
		await once(websocket, "open");
		cleanups.push(() => websocket.close());
		const messages: Array<{ method?: string }> = [];
		websocket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { method?: string }));

		await expect(ui.input("Timeout", undefined, { timeout: 10 })).resolves.toBeUndefined();
		const controller = new AbortController();
		const selection = ui.select("Abort", ["one"], { signal: controller.signal });
		controller.abort();
		await expect(selection).resolves.toBeUndefined();
		ui.notify("notice", "warning");
		ui.setStatus("build", "running");
		ui.setTitle("Pi Orbit");
		ui.setEditorText("draft");
		ui.setWidget("summary", ["line"], { placement: "belowEditor" });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.map((message) => message.method)).toEqual(
			expect.arrayContaining(["input", "select", "notify", "setStatus", "setTitle", "set_editor_text", "setWidget"]),
		);
		expect(connectionManager.getPendingUIRequests(sessionId)).toEqual([]);
	});

	it("isolates extension UI responses by session and accepts only the first valid response", async () => {
		const { baseUrl, wsUrl, sessionHost, connectionManager } = await createHarness();
		const created = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "other" }),
		});
		const { sessionId: otherSessionId } = (await created.json()) as { sessionId: string };
		const sessionId = sessionHost.defaultSessionId;
		const first = new WebSocket(`${wsUrl}/ws?session_id=${sessionId}`);
		const second = new WebSocket(`${wsUrl}/ws?session_id=${sessionId}`);
		const other = new WebSocket(`${wsUrl}/ws?session_id=${otherSessionId}`);
		await Promise.all([once(first, "open"), once(second, "open"), once(other, "open")]);
		cleanups.push(
			() => first.close(),
			() => second.close(),
			() => other.close(),
		);

		const requestPromise = once(first, "message");
		const result = createWebExtensionUIContext(sessionId, connectionManager).confirm("Choose", "Continue?");
		const [data] = await requestPromise;
		const request = JSON.parse(data.toString()) as { id: string };
		other.send(JSON.stringify({ type: "extension_ui_response", id: request.id, confirmed: false }));
		second.send(JSON.stringify({ type: "extension_ui_response", id: request.id, value: "invalid for confirm" }));
		first.send(JSON.stringify({ type: "extension_ui_response", id: request.id, confirmed: true }));

		await expect(result).resolves.toBe(true);
		expect(connectionManager.getPendingUIRequests(sessionId)).toEqual([]);
	});

	it("accepts abort commands over WebSocket", async () => {
		const { wsUrl, sessionHost } = await createHarness();
		const session = sessionHost.get(sessionHost.defaultSessionId)?.runtime.session;
		if (!session) throw new Error("missing default session");
		const abort = vi.spyOn(session, "abort");
		const websocket = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}`);
		await once(websocket, "open");
		cleanups.push(() => websocket.close());
		websocket.send(JSON.stringify({ type: "abort" }));

		await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
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

	it("replays buffered runtime events after Last-Event-ID", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const runtimeId = sessionHost.defaultSessionId;
		await sessionHost.get(runtimeId)?.runtime.session.prompt("before-connect");

		const response = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/events`, {
			headers: { "Last-Event-ID": "0" },
		});
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing runtime SSE response body");
		let received = "";
		while (!received.includes("websocket response")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += new TextDecoder().decode(chunk.value);
		}
		await reader.cancel();

		expect(received).toContain("event: runtime_event");
		expect(received).toContain("id: 1");
		expect(received).toContain(`"runtimeId":"${runtimeId}"`);
		expect(received).toContain("websocket response");
	});

	it("rejects a runtime event cursor ahead of the current sequence", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const runtimeId = sessionHost.defaultRuntimeId;
		const response = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/events`, {
			headers: { "Last-Event-ID": "1" },
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "event_sequence_ahead",
			oldestSequence: 0,
			latestSequence: 0,
		});
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

	it("exposes queued-message and agent cancellation controls", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const session = sessionHost.get(sessionId)?.runtime.session;
		if (!session) throw new Error("missing default session");
		const steer = vi.spyOn(session, "steer").mockResolvedValue();
		const followUp = vi.spyOn(session, "followUp").mockResolvedValue();
		const abortBash = vi.spyOn(session, "abortBash");
		const abortRetry = vi.spyOn(session, "abortRetry");
		let finishTurn = () => {};
		vi.spyOn(session, "prompt").mockImplementation((_message, promptOptions) => {
			promptOptions?.preflightResult?.(true);
			return new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
		});
		const promptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "run" }),
		});
		expect(promptResponse.status).toBe(202);

		const steerResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "change course" }),
		});
		const followUpResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/follow-up`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "then summarize" }),
		});
		const runtimeSteerResponse = await fetch(`${baseUrl}/api/runtimes/${sessionId}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "runtime course" }),
		});
		const runtimeFollowUpResponse = await fetch(`${baseUrl}/api/runtimes/${sessionId}/follow-up`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "runtime summary" }),
		});
		const abortBashResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/abort-bash`, {
			method: "POST",
		});
		const abortRetryResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/abort-retry`, {
			method: "POST",
		});

		expect(steerResponse.status).toBe(200);
		expect(followUpResponse.status).toBe(200);
		expect(runtimeSteerResponse.status).toBe(200);
		expect(runtimeFollowUpResponse.status).toBe(200);
		expect(abortBashResponse.status).toBe(200);
		expect(abortRetryResponse.status).toBe(200);
		expect(steer).toHaveBeenCalledWith("change course", undefined);
		expect(followUp).toHaveBeenCalledWith("then summarize", undefined);
		expect(steer).toHaveBeenCalledWith("runtime course", undefined);
		expect(followUp).toHaveBeenCalledWith("runtime summary", undefined);
		expect(abortBash).toHaveBeenCalledOnce();
		expect(abortRetry).toHaveBeenCalledOnce();
		finishTurn();
	});

	it("rejects restart and legacy deletion while a prompt is active", async () => {
		const { baseUrl, sessionHost, root } = await createHarness();
		const created = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root }),
		});
		const { sessionId } = (await created.json()) as { sessionId: string };
		const session = sessionHost.get(sessionId)?.runtime.session;
		if (!session) throw new Error("missing runtime session");
		let finishTurn = () => {};
		vi.spyOn(session, "prompt").mockImplementation((_message, promptOptions) => {
			promptOptions?.preflightResult?.(true);
			return new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
		});
		await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "run" }),
		});

		const restart = await fetch(`${baseUrl}/api/sessions/${sessionId}/restart`, { method: "POST" });
		const deletion = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });

		expect(restart.status).toBe(409);
		expect(await restart.json()).toMatchObject({ code: "runtime_busy" });
		expect(deletion.status).toBe(409);
		expect(await deletion.json()).toMatchObject({ code: "runtime_busy" });
		expect(sessionHost.get(sessionId)).toBeDefined();
		finishTurn();
	});

	it("updates queue and automation settings and cycles model state", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const session = sessionHost.get(sessionId)?.runtime.session;
		if (!session) throw new Error("missing default session");
		const cycleModel = vi.spyOn(session, "cycleModel").mockResolvedValue(undefined);

		for (const [path, body] of [
			["steering-mode", { mode: "one-at-a-time" }],
			["follow-up-mode", { mode: "one-at-a-time" }],
			["auto-compaction", { enabled: false }],
			["auto-retry", { enabled: false }],
		] as const) {
			const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/${path}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
		}

		const cycleModelResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/cycle-model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ direction: "backward" }),
		});
		const cycleThinkingResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/cycle-thinking`, {
			method: "POST",
		});
		const thinkingLevelsResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/thinking-levels`);

		expect(cycleModelResponse.status).toBe(200);
		expect(await cycleModelResponse.json()).toEqual({ result: null });
		expect(cycleModel).toHaveBeenCalledWith("backward");
		expect(cycleThinkingResponse.status).toBe(200);
		expect(await cycleThinkingResponse.json()).toHaveProperty("level");
		expect(thinkingLevelsResponse.status).toBe(200);
		expect(await thinkingLevelsResponse.json()).toHaveProperty("levels");
		expect(session.steeringMode).toBe("one-at-a-time");
		expect(session.followUpMode).toBe("one-at-a-time");
		expect(session.autoCompactionEnabled).toBe(false);
		expect(session.autoRetryEnabled).toBe(false);
	});

	it("exposes session commands, fork messages, assistant text, and switching", async () => {
		const { baseUrl, sessionHost, root } = await createHarness({ persistedSession: true });
		const sessionId = sessionHost.defaultSessionId;
		const runtime = sessionHost.get(sessionId)?.runtime;
		if (!runtime) throw new Error("missing default runtime");
		await runtime.session.prompt("hello");
		const switchSession = vi.spyOn(runtime, "switchSession").mockResolvedValue({ cancelled: false });

		const commands = await fetch(`${baseUrl}/api/sessions/${sessionId}/commands`);
		const forkMessages = await fetch(`${baseUrl}/api/sessions/${sessionId}/fork-messages`);
		const assistantText = await fetch(`${baseUrl}/api/sessions/${sessionId}/last-assistant-text`);
		const switched = await fetch(`${baseUrl}/api/sessions/${sessionId}/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: "/tmp/example.jsonl", cwdOverride: root }),
		});

		expect(commands.status).toBe(200);
		expect(await commands.json()).toEqual({ commands: [] });
		expect(forkMessages.status).toBe(200);
		expect(await forkMessages.json()).toMatchObject({ messages: [{ text: "hello" }] });
		expect(assistantText.status).toBe(200);
		expect(await assistantText.json()).toEqual({ text: "websocket response" });
		expect(switched.status).toBe(200);
		expect(await switched.json()).toEqual({ success: true, cancelled: false });
		expect(switchSession).toHaveBeenCalledWith("/tmp/example.jsonl", { cwdOverride: root });
	});

	it("restarts the protected default session without changing its web session id", async () => {
		const { baseUrl, sessionHost, connectionManager } = await createHarness();
		const sessionId = sessionHost.defaultSessionId;
		const previousRuntime = sessionHost.get(sessionId)?.runtime;
		if (!previousRuntime) throw new Error("missing default runtime");
		await previousRuntime.session.prompt("before restart");
		const previousSequence = connectionManager.getReplayWindow(sessionId, Number.MAX_SAFE_INTEGER).latestSequence;

		const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/restart`, { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(sessionHost.get(sessionId)?.runtime).not.toBe(previousRuntime);
		await sessionHost.get(sessionId)?.runtime.session.prompt("after restart");
		const events = connectionManager.getBufferedEvents(sessionId, previousSequence);
		expect(events.length).toBeGreaterThan(0);
		expect(events[0]?.sequence).toBe(previousSequence + 1);
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

	it("rate limits runtime prompts independently", async () => {
		const { baseUrl, sessionHost, root } = await createHarness({
			configureApiKey: false,
			promptRateLimit: { limit: 1, windowMs: 60_000 },
		});
		const created = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir: join(root, "rate-limit-sessions") }),
		});
		const { runtimeId } = (await created.json()) as { runtimeId: string };
		const prompt = (id: string) =>
			fetch(`${baseUrl}/api/runtimes/${id}/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "hello" }),
			});

		expect((await prompt(sessionHost.defaultRuntimeId)).status).toBe(500);
		expect((await prompt(sessionHost.defaultRuntimeId)).status).toBe(429);
		expect((await prompt(runtimeId)).status).toBe(500);
	});

	it("limits concurrent agent turns across runtimes and releases capacity when a turn ends", async () => {
		const { baseUrl, sessionHost, root } = await createHarness({ maxConcurrentTurns: 1 });
		const firstRuntimeId = sessionHost.defaultRuntimeId;
		const created = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir: join(root, "turn-sessions") }),
		});
		const { runtimeId: secondRuntimeId } = (await created.json()) as { runtimeId: string };
		const firstSession = sessionHost.get(firstRuntimeId)?.runtime.session;
		if (!firstSession) throw new Error("missing first runtime");
		let finishTurn = () => {};
		vi.spyOn(firstSession, "prompt").mockImplementation((_message, options) => {
			options?.preflightResult?.(true);
			return new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
		});

		const prompt = (runtimeId: string) =>
			fetch(`${baseUrl}/api/runtimes/${runtimeId}/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "run" }),
			});
		expect((await prompt(firstRuntimeId)).status).toBe(202);
		const rejected = await prompt(secondRuntimeId);
		expect(rejected.status).toBe(429);
		expect(await rejected.json()).toMatchObject({ code: "agent_turn_capacity_exceeded" });

		finishTurn();
		await vi.waitFor(() => expect(sessionHost.activeTurnCount).toBe(0));
		expect((await prompt(secondRuntimeId)).status).toBe(202);
	});

	it("rejects a second prompt while the same runtime owns an operation lease", async () => {
		const { baseUrl, sessionHost } = await createHarness({ maxConcurrentTurns: 2 });
		const runtimeId = sessionHost.defaultRuntimeId;
		const session = sessionHost.get(runtimeId)?.runtime.session;
		if (!session) throw new Error("missing runtime session");
		let finishTurn = () => {};
		vi.spyOn(session, "prompt").mockImplementation((_message, options) => {
			options?.preflightResult?.(true);
			return new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
		});
		const prompt = () =>
			fetch(`${baseUrl}/api/runtimes/${runtimeId}/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "run" }),
			});

		expect((await prompt()).status).toBe(202);
		const descriptor = await fetch(`${baseUrl}/api/runtimes/${runtimeId}`);
		expect(await descriptor.json()).toMatchObject({ busy: true });
		const rejected = await prompt();
		expect(rejected.status).toBe(409);
		expect(await rejected.json()).toMatchObject({ code: "runtime_busy" });
		finishTurn();
	});

	it("rejects resume while a runtime prompt is active", async () => {
		const { baseUrl, sessionHost } = await createHarness();
		const runtimeId = sessionHost.defaultRuntimeId;
		const session = sessionHost.get(runtimeId)?.runtime.session;
		if (!session) throw new Error("missing runtime session");
		let finishTurn = () => {};
		vi.spyOn(session, "prompt").mockImplementation((_message, options) => {
			options?.preflightResult?.(true);
			return new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
		});
		await fetch(`${baseUrl}/api/runtimes/${runtimeId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "run" }),
		});

		const resumed = await fetch(`${baseUrl}/api/runtimes/${runtimeId}/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionPath: "/tmp/busy.jsonl" }),
		});
		expect(resumed.status).toBe(409);
		expect(await resumed.json()).toMatchObject({ code: "runtime_busy" });
		finishTurn();
	});

	it("rejects deletion while a runtime prompt is active", async () => {
		const { baseUrl, sessionHost, root } = await createHarness();
		const created = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: root, sessionDir: join(root, "busy-delete-sessions") }),
		});
		const { runtimeId } = (await created.json()) as { runtimeId: string };
		const session = sessionHost.get(runtimeId)?.runtime.session;
		if (!session) throw new Error("missing runtime session");
		let finishTurn = () => {};
		vi.spyOn(session, "prompt").mockImplementation((_message, options) => {
			options?.preflightResult?.(true);
			return new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
		});
		await fetch(`${baseUrl}/api/runtimes/${runtimeId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "run" }),
		});

		const rejected = await fetch(`${baseUrl}/api/runtimes/${runtimeId}`, { method: "DELETE" });
		expect(rejected.status).toBe(409);
		expect(await rejected.json()).toMatchObject({ code: "runtime_busy" });
		finishTurn();
		await vi.waitFor(() => expect(sessionHost.isRuntimeOperating(runtimeId)).toBe(false));
		expect((await fetch(`${baseUrl}/api/runtimes/${runtimeId}`, { method: "DELETE" })).status).toBe(200);
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
		const originalSessionPath = runtime.session.sessionFile;
		if (!originalSessionPath) throw new Error("missing original session path");

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
		expect(runtime.session.sessionFile).not.toBe(originalSessionPath);
		const reopened = await fetch(`${baseUrl}/api/runtimes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				sessionDir: join(root, "sessions"),
				sessionPath: originalSessionPath,
			}),
		});
		expect(reopened.status).toBe(201);
	});

	it("resolves Pi Orbit environment settings and ignores the retired Pi Web names", () => {
		expect(resolveWebModeOptions({}, { PI_ORBIT_AUTH_TOKEN: "from-env" }).authToken).toBe("from-env");
		expect(resolveWebModeOptions({}, { PI_ORBIT_CORS_ORIGIN: "https://control.example" }).corsOrigin).toBe(
			"https://control.example",
		);
		expect(() => resolveWebModeOptions({}, { PI_ORBIT_PORT: "invalid" })).toThrow("Invalid web port");
		expect(resolveWebModeOptions({}, { PI_WEB_AUTH_TOKEN: "legacy", PI_WEB_PORT: "invalid" })).toMatchObject({
			authToken: undefined,
			port: 3000,
		});
		expect(
			resolveWebModeOptions(
				{},
				{
					PI_ORBIT_RUNTIME_DISPOSE_TIMEOUT_MS: "2500",
					PI_ORBIT_SHUTDOWN_TIMEOUT_MS: "5000",
				},
			),
		).toMatchObject({ disposeTimeoutMs: 2500, shutdownTimeoutMs: 5000 });
	});

	it("requires authentication and an explicit CORS origin on non-loopback hosts", () => {
		expect(() => resolveWebModeOptions({ host: "0.0.0.0" }, {})).toThrow(
			"Authentication is required for non-loopback web hosts",
		);
		expect(() => resolveWebModeOptions({ host: "0.0.0.0", authToken: "secret" }, {})).toThrow(
			"An explicit CORS origin is required for non-loopback web hosts",
		);
		expect(
			resolveWebModeOptions({ host: "0.0.0.0", authToken: "secret", corsOrigin: "https://control.example" }, {}),
		).toMatchObject({ host: "0.0.0.0", authToken: "secret", corsOrigin: "https://control.example" });
	});

	it("requires authentication and restrictive default CORS in app-managed mode", () => {
		expect(() => resolveWebModeOptions({ appManaged: true }, {})).toThrow(
			"Authentication is required in app-managed web mode",
		);
		expect(resolveWebModeOptions({ appManaged: true, authToken: "secret" }, {})).toMatchObject({
			appManaged: true,
			authToken: "secret",
			corsOrigin: null,
		});
		expect(resolveWebModeOptions({}, { PI_ORBIT_APP_MANAGED: "1", PI_ORBIT_AUTH_TOKEN: "from-env" })).toMatchObject({
			appManaged: true,
			authToken: "from-env",
			corsOrigin: null,
		});
	});

	it("disables cross-origin access by default on loopback", () => {
		expect(resolveWebModeOptions({}, {})).toMatchObject({ host: "127.0.0.1", corsOrigin: null });
	});

	it("exchanges a bearer token for a browser session cookie", async () => {
		const { baseUrl, wsUrl, sessionHost } = await createHarness({ authToken: "secret" });
		const bootstrap = await fetch(`${baseUrl}/api/auth/session`, {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
		});
		expect(bootstrap.status).toBe(204);
		const cookie = bootstrap.headers.get("set-cookie");
		expect(cookie).toContain("pi_web_auth=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		if (!cookie) throw new Error("missing auth cookie");

		const sessions = await fetch(`${baseUrl}/api/sessions`, { headers: { Cookie: cookie } });
		expect(sessions.status).toBe(200);
		const websocket = new WebSocket(`${wsUrl}/ws?session_id=${sessionHost.defaultSessionId}`, {
			headers: { Cookie: cookie },
		});
		await once(websocket, "open");
		websocket.close();
	});

	it("omits CORS response headers when cross-origin access is disabled", async () => {
		const { baseUrl } = await createHarness({ corsOrigin: null });
		const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "null" } });

		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("uses the configured CORS origin", async () => {
		const { baseUrl } = await createHarness({ corsOrigin: "https://control.example" });
		const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://control.example" } });
		expect(response.headers.get("access-control-allow-origin")).toBe("https://control.example");
	});

	it("rejects API request bodies that exceed the configured limit", async () => {
		const { baseUrl } = await createHarness({ requestBodyLimitBytes: 128 });
		const response = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x".repeat(256) }),
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: "Request body too large",
			code: "request_body_too_large",
		});
	});
});
