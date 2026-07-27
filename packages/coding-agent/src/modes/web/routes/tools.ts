/** Tool and lifecycle routes for web mode. */

import type { Hono } from "hono";
import type { WebCommandHandler } from "../commands.ts";
import { isBashRequest, isForkRequest } from "../types.ts";
import { executeCommand } from "./utils.ts";

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
		return executeCommand(context, () => deps.commands.execute(context.req.param("id"), { type: "bash", ...body }));
	});

	app.post("/api/sessions/:id/compact", (context) =>
		executeCommand(context, () => deps.commands.execute(context.req.param("id"), { type: "compact" })),
	);

	app.post("/api/sessions/:id/fork", async (context) => {
		let body: unknown = {};
		try {
			body = await context.req.json();
		} catch {
			// Fork body is optional.
		}
		if (!isForkRequest(body)) return context.json({ error: "Invalid fork request" } as const, 400);
		return executeCommand(context, () => deps.commands.execute(context.req.param("id"), { type: "fork", ...body }));
	});
}
