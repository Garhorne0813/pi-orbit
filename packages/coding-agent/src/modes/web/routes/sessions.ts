/** Session management routes for web mode. */

import type { Hono } from "hono";
import { isCreateSessionRequest } from "../types.ts";
import type { WebSessionHost } from "../web-session-host.ts";

export interface SessionRoutesDeps {
	sessionHost: WebSessionHost;
}

export function registerSessionRoutes(app: Hono, deps: SessionRoutesDeps): void {
	const { sessionHost } = deps;

	app.post("/api/sessions", async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isCreateSessionRequest(body)) {
			return context.json({ error: "Invalid session request" } as const, 400);
		}

		try {
			return context.json(await sessionHost.createSession(body), 201);
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			const status = details === "Session name must be non-empty" ? 400 : 500;
			return context.json({ error: "Failed to create session", details } as const, status);
		}
	});

	app.get("/api/sessions", (context) => context.json(sessionHost.list()));

	app.get("/api/sessions/:id", (context) => {
		const id = context.req.param("id");
		const entry = sessionHost.get(id);
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		const session = entry.runtime.session;
		return context.json({
			id,
			name: session.sessionManager.getSessionName() ?? undefined,
			cwd: entry.runtime.cwd,
			createdAt: entry.createdAt,
			model: session.model?.id,
			thinkingLevel: session.thinkingLevel,
			messageCount: session.state.messages.length,
		});
	});

	app.delete("/api/sessions/:id", async (context) => {
		const result = await sessionHost.removeSession(context.req.param("id"));
		if (result === "not_found") return context.json({ error: "Session not found" } as const, 404);
		if (result === "protected") {
			return context.json({ error: "Default session cannot be deleted" } as const, 403);
		}
		return context.json({ success: true } as const);
	});
}
