/**
 * Prompt and agent control routes for web mode.
 */

import type { Hono } from "hono";
import type { PromptRequest, WebSessionEntry } from "../types.ts";

export interface PromptRoutesDeps {
	sessionMap: Map<string, WebSessionEntry>;
}

export function registerPromptRoutes(app: Hono, deps: PromptRoutesDeps): void {
	const { sessionMap } = deps;

	// POST /api/sessions/:id/prompt — send a prompt to the agent
	app.post("/api/sessions/:id/prompt", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		let body: PromptRequest;
		try {
			body = await c.req.json<PromptRequest>();
		} catch {
			return c.json({ error: "Invalid JSON body" } as const, 400);
		}

		if (!body.message || typeof body.message !== "string") {
			return c.json({ error: "Missing or invalid 'message' field" } as const, 400);
		}

		try {
			await entry.runtime.session.prompt(body.message);
			return c.json({ success: true } as const);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to send prompt", details: message } as const, 500);
		}
	});

	// POST /api/sessions/:id/abort — abort the current agent run
	app.post("/api/sessions/:id/abort", (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		try {
			entry.runtime.session.abort();
			return c.json({ success: true } as const);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to abort", details: message } as const, 500);
		}
	});
}
