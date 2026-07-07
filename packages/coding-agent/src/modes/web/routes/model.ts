/**
 * Model and configuration routes for web mode.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { Hono } from "hono";
import { isValidThinkingLevel } from "../../../cli/args.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SetModelRequest, SetThinkingRequest, WebSessionEntry } from "../types.ts";

export interface ModelRoutesDeps {
	sessionMap: Map<string, WebSessionEntry>;
	modelRegistry: ModelRegistry;
}

export function registerModelRoutes(app: Hono, deps: ModelRoutesDeps): void {
	const { sessionMap, modelRegistry } = deps;

	// GET /api/models — list available models
	app.get("/api/models", (c) => {
		const models = modelRegistry.getAll();
		const modelList = models.map((m: Model<Api>) => ({
			id: m.id,
			name: m.name,
			provider: m.provider,
			reasoning: m.reasoning,
			input: m.input,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		}));
		return c.json(modelList);
	});

	// POST /api/sessions/:id/model — set the model for a session
	app.post("/api/sessions/:id/model", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		let body: SetModelRequest;
		try {
			body = await c.req.json<SetModelRequest>();
		} catch {
			return c.json({ error: "Invalid JSON body" } as const, 400);
		}

		if (!body.modelId || typeof body.modelId !== "string") {
			return c.json({ error: "Missing 'modelId' field" } as const, 400);
		}

		const models = modelRegistry.getAll();
		const model = models.find((m: Model<Api>) => m.id === body.modelId || m.id.startsWith(body.modelId));
		if (!model) {
			return c.json({ error: `Model not found: ${body.modelId}` } as const, 404);
		}

		try {
			await entry.runtime.session.setModel(model);
			return c.json({ success: true, model: model.id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to set model", details: message } as const, 500);
		}
	});

	// POST /api/sessions/:id/thinking — set thinking level
	app.post("/api/sessions/:id/thinking", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		let body: SetThinkingRequest;
		try {
			body = await c.req.json<SetThinkingRequest>();
		} catch {
			return c.json({ error: "Invalid JSON body" } as const, 400);
		}

		if (!body.level || !isValidThinkingLevel(body.level)) {
			return c.json(
				{
					error: "Invalid thinking level",
					details: "Must be one of: off, minimal, low, medium, high, xhigh",
				} as const,
				400,
			);
		}

		try {
			entry.runtime.session.setThinkingLevel(
				body.level as Parameters<typeof entry.runtime.session.setThinkingLevel>[0],
			);
			return c.json({ success: true, level: body.level });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to set thinking level", details: message } as const, 500);
		}
	});
}
