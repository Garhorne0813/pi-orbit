/** Model and configuration routes for web mode. */

import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Hono } from "hono";
import type { WebCommandHandler } from "../commands.ts";
import {
	isCycleModelRequest,
	isEnabledRequest,
	isQueueModeRequest,
	isSetModelRequest,
	isSetThinkingRequest,
} from "../types.ts";
import type { WebSessionHost } from "../web-session-host.ts";
import { executeCommand } from "./utils.ts";

export interface ModelRoutesDeps {
	commands: WebCommandHandler;
	sessionHost: WebSessionHost;
}

interface RuntimeCatalogModel {
	id: string;
	name: string;
	api: Api;
	reasoning: boolean;
	thinkingLevels: ModelThinkingLevel[];
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

interface RuntimeCatalogProvider {
	id: string;
	name: string;
	baseUrl: string | null;
	auth: {
		apiKey: boolean;
		oauth: boolean;
		subscription: boolean;
		configured: boolean;
	};
	models: RuntimeCatalogModel[];
}

interface RuntimeCatalogResponse {
	schemaVersion: 1;
	providers: RuntimeCatalogProvider[];
}

export function registerModelRoutes(app: Hono, deps: ModelRoutesDeps): void {
	app.get("/api/models", async (context) => {
		const sessionId = context.req.query("session_id") ?? deps.sessionHost.defaultSessionId;
		const entry = deps.sessionHost.get(sessionId);
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		return context.json(
			(await entry.runtime.services.modelRuntime.getAvailable()).map((model: Model<Api>) => ({
				id: model.id,
				name: model.name,
				provider: model.provider,
				reasoning: model.reasoning,
				thinkingLevels: getSupportedThinkingLevels(model),
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		);
	});

	app.get("/api/catalog", (context) => {
		const entry = deps.sessionHost.get(deps.sessionHost.defaultRuntimeId);
		if (!entry) return context.json({ error: "Runtime not found" } as const, 404);

		const modelRuntime = entry.runtime.services.modelRuntime;
		const providers: RuntimeCatalogProvider[] = modelRuntime.getProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl ?? null,
			auth: {
				apiKey: provider.auth.apiKey !== undefined,
				oauth: provider.auth.oauth !== undefined,
				subscription: provider.auth.oauth?.isSubscription === true,
				configured: modelRuntime.hasConfiguredAuth(provider.id),
			},
			models: modelRuntime.getModels(provider.id).map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				thinkingLevels: getSupportedThinkingLevels(model),
				input: [...model.input],
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		}));

		return context.json<RuntimeCatalogResponse>({ schemaVersion: 1, providers });
	});

	app.post("/api/sessions/:id/model", async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isSetModelRequest(body)) {
			return context.json({ error: "Missing 'provider' or 'modelId' field" } as const, 400);
		}
		return executeCommand(context, () =>
			deps.commands.execute(context.req.param("id"), { type: "set_model", ...body }),
		);
	});

	app.post("/api/sessions/:id/thinking", async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isSetThinkingRequest(body)) return context.json({ error: "Missing 'level' field" } as const, 400);
		return executeCommand(context, () =>
			deps.commands.execute(context.req.param("id"), { type: "set_thinking_level", ...body }),
		);
	});

	app.post("/api/sessions/:id/cycle-model", async (context) => {
		let body: unknown = {};
		try {
			body = await context.req.json();
		} catch {
			// The direction is optional.
		}
		if (!isCycleModelRequest(body)) return context.json({ error: "Invalid model cycle direction" } as const, 400);
		return executeCommand(context, () =>
			deps.commands.execute(context.req.param("id"), { type: "cycle_model", direction: body.direction }),
		);
	});

	app.post("/api/sessions/:id/cycle-thinking", (context) =>
		executeCommand(context, () => deps.commands.execute(context.req.param("id"), { type: "cycle_thinking" })),
	);

	app.get("/api/sessions/:id/thinking-levels", (context) => {
		const entry = deps.sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		return context.json({ levels: entry.runtime.session.getAvailableThinkingLevels() });
	});

	for (const [path, type] of [
		["steering-mode", "set_steering_mode"],
		["follow-up-mode", "set_follow_up_mode"],
	] as const) {
		app.put(`/api/sessions/:id/${path}`, async (context) => {
			let body: unknown;
			try {
				body = await context.req.json();
			} catch {
				return context.json({ error: "Invalid JSON body" } as const, 400);
			}
			if (!isQueueModeRequest(body)) return context.json({ error: "Invalid queue mode" } as const, 400);
			return executeCommand(context, () =>
				deps.commands.execute(context.req.param("id"), { type, mode: body.mode }),
			);
		});
	}

	for (const [path, type] of [
		["auto-compaction", "set_auto_compaction"],
		["auto-retry", "set_auto_retry"],
	] as const) {
		app.put(`/api/sessions/:id/${path}`, async (context) => {
			let body: unknown;
			try {
				body = await context.req.json();
			} catch {
				return context.json({ error: "Invalid JSON body" } as const, 400);
			}
			if (!isEnabledRequest(body))
				return context.json({ error: "Missing or invalid 'enabled' field" } as const, 400);
			return executeCommand(context, () =>
				deps.commands.execute(context.req.param("id"), { type, enabled: body.enabled }),
			);
		});
	}
}
