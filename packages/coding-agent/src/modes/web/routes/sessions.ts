/** Session management routes for web mode. */

import type { Hono } from "hono";
import { isCreateSessionRequest, isExportSessionRequest, isRenameSessionRequest } from "../types.ts";
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

	app.get("/api/sessions/:id/state", (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		const session = entry.runtime.session;
		return context.json({
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			sessionName: session.sessionName,
			autoCompactionEnabled: session.autoCompactionEnabled,
			messageCount: session.messages.length,
			pendingMessageCount: session.pendingMessageCount,
		});
	});

	app.get("/api/sessions/:id/stats", (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		return context.json(entry.runtime.session.getSessionStats());
	});

	app.get("/api/sessions/:id/messages", (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		return context.json({ messages: entry.runtime.session.messages });
	});

	app.get("/api/sessions/:id/entries", (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		const sessionManager = entry.runtime.session.sessionManager;
		let entries = sessionManager.getEntries();
		const since = context.req.query("since");
		if (since !== undefined) {
			const index = entries.findIndex((item) => item.id === since);
			if (index === -1) return context.json({ error: `Entry not found: ${since}` } as const, 404);
			entries = entries.slice(index + 1);
		}
		return context.json({ entries, leafId: sessionManager.getLeafId() });
	});

	app.get("/api/sessions/:id/tree", (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		const sessionManager = entry.runtime.session.sessionManager;
		return context.json({ tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
	});

	app.patch("/api/sessions/:id", async (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isRenameSessionRequest(body) || !body.name.trim()) {
			return context.json({ error: "Session name cannot be empty" } as const, 400);
		}
		entry.runtime.session.setSessionName(body.name.trim());
		return context.json({ success: true } as const);
	});

	app.post("/api/sessions/:id/clone", async (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		const leafId = entry.runtime.session.sessionManager.getLeafId();
		if (!leafId) return context.json({ error: "Cannot clone session: no current entry selected" } as const, 400);
		try {
			const result = await entry.runtime.fork(leafId, { position: "at" });
			return context.json({ success: !result.cancelled, cancelled: result.cancelled });
		} catch (error) {
			return context.json(
				{
					error: "Failed to clone session",
					details: error instanceof Error ? error.message : String(error),
				} as const,
				500,
			);
		}
	});

	app.post("/api/sessions/:id/export", async (context) => {
		const entry = sessionHost.get(context.req.param("id"));
		if (!entry) return context.json({ error: "Session not found" } as const, 404);
		let body: unknown = {};
		try {
			body = await context.req.json();
		} catch {
			// Export body is optional.
		}
		if (!isExportSessionRequest(body)) return context.json({ error: "Invalid export request" } as const, 400);
		try {
			return context.json({ path: await entry.runtime.session.exportToHtml(body.outputPath) });
		} catch (error) {
			return context.json(
				{
					error: "Failed to export session",
					details: error instanceof Error ? error.message : String(error),
				} as const,
				500,
			);
		}
	});

	app.post("/api/sessions/:id/restart", async (context) => {
		try {
			const result = await sessionHost.restartSession(context.req.param("id"));
			if (result === "not_found") return context.json({ error: "Session not found" } as const, 404);
			return context.json({ success: true } as const);
		} catch (error) {
			return context.json(
				{
					error: "Failed to restart session",
					details: error instanceof Error ? error.message : String(error),
				} as const,
				500,
			);
		}
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
