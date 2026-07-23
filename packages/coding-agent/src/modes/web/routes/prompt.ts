/** Prompt and agent control routes for web mode. */

import type { Context, Hono } from "hono";
import { WebCommandError, type WebCommandHandler } from "../commands.ts";
import { isPromptRequest } from "../types.ts";

export interface PromptRoutesDeps {
	commands: WebCommandHandler;
}

export function registerPromptRoutes(app: Hono, deps: PromptRoutesDeps): void {
	app.post("/api/sessions/:id/prompt", async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isPromptRequest(body)) {
			return context.json({ error: "Missing or invalid 'message' field" } as const, 400);
		}
		try {
			return context.json(await deps.commands.execute(context.req.param("id"), { type: "prompt", ...body }), 202);
		} catch (error) {
			return commandErrorResponse(context, error);
		}
	});

	app.post("/api/sessions/:id/abort", async (context) => {
		try {
			return context.json(await deps.commands.execute(context.req.param("id"), { type: "abort" }));
		} catch (error) {
			return commandErrorResponse(context, error);
		}
	});
}

function commandErrorResponse(context: Context, error: unknown) {
	if (error instanceof WebCommandError) {
		return context.json({ error: error.message, details: error.details }, error.status);
	}
	return context.json({ error: "Internal server error" } as const, 500);
}
