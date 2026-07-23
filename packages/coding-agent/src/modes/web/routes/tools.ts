/** Tool and lifecycle routes for web mode. */

import type { Context, Hono } from "hono";
import { type WebCommand, WebCommandError, type WebCommandHandler } from "../commands.ts";
import { isBashRequest, isForkRequest } from "../types.ts";

export interface ToolRoutesDeps {
	commands: WebCommandHandler;
}

export function registerToolRoutes(app: Hono, deps: ToolRoutesDeps): void {
	app.post("/api/sessions/:id/bash", async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isBashRequest(body)) return context.json({ error: "Missing 'command' field" } as const, 400);
		return execute(context.req.param("id"), { type: "bash", ...body }, context, deps.commands);
	});

	app.post("/api/sessions/:id/compact", (context) =>
		execute(context.req.param("id"), { type: "compact" }, context, deps.commands),
	);

	app.post("/api/sessions/:id/fork", async (context) => {
		let body: unknown = {};
		try {
			body = await context.req.json();
		} catch {
			// Fork body is optional.
		}
		if (!isForkRequest(body)) return context.json({ error: "Invalid fork request" } as const, 400);
		return execute(context.req.param("id"), { type: "fork", ...body }, context, deps.commands);
	});
}

async function execute(sessionId: string, command: WebCommand, context: Context, commands: WebCommandHandler) {
	try {
		return context.json(await commands.execute(sessionId, command));
	} catch (error) {
		if (error instanceof WebCommandError) {
			return context.json({ error: error.message, details: error.details }, error.status);
		}
		return context.json({ error: "Internal server error" } as const, 500);
	}
}
