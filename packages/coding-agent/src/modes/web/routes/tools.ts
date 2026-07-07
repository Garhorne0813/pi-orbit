/**
 * Tool and lifecycle routes for web mode.
 */

import type { Hono } from "hono";
import type { BashRequest, ForkRequest, WebSessionEntry } from "../types.ts";

export interface ToolRoutesDeps {
	sessionMap: Map<string, WebSessionEntry>;
}

export function registerToolRoutes(app: Hono, deps: ToolRoutesDeps): void {
	const { sessionMap } = deps;

	// POST /api/sessions/:id/bash — execute a ! command
	app.post("/api/sessions/:id/bash", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		let body: BashRequest;
		try {
			body = await c.req.json<BashRequest>();
		} catch {
			return c.json({ error: "Invalid JSON body" } as const, 400);
		}

		if (!body.command || typeof body.command !== "string") {
			return c.json({ error: "Missing 'command' field" } as const, 400);
		}

		try {
			await entry.runtime.session.executeBash(body.command);
			return c.json({ success: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to execute bash", details: message } as const, 500);
		}
	});

	// POST /api/sessions/:id/compact — trigger context compaction
	app.post("/api/sessions/:id/compact", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		try {
			await entry.runtime.session.compact();
			return c.json({ success: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to compact session", details: message } as const, 500);
		}
	});

	// POST /api/sessions/:id/fork — fork the session
	app.post("/api/sessions/:id/fork", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		let targetEntryId: string | undefined;
		try {
			const raw = await c.req.json<ForkRequest>();
			targetEntryId = raw.entryId;
		} catch {
			// Body is optional for fork
		}

		// If no entryId provided, fork from the first user message
		if (!targetEntryId) {
			const entries = entry.runtime.session.sessionManager.getEntries();
			const firstUserEntry = entries.find((e) => e.type === "message" && e.message.role === "user");
			targetEntryId = firstUserEntry?.id;
		}

		if (!targetEntryId) {
			return c.json({ error: "No entry to fork from" } as const, 400);
		}

		try {
			const result = await entry.runtime.fork(targetEntryId);
			if (result.cancelled) {
				return c.json({ success: false, reason: "cancelled" });
			}
			return c.json({ success: true, selectedText: result.selectedText });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to fork session", details: message } as const, 500);
		}
	});
}
