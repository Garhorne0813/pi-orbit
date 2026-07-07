/**
 * Session management routes for web mode.
 */

import * as crypto from "node:crypto";
import type { Hono } from "hono";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../core/agent-session-runtime.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import type { CreateSessionRequest, CreateSessionResponse, SessionSummary, WebSessionEntry } from "../types.ts";
import type { ConnectionManager } from "../ws/connection-manager.ts";

export interface SessionRoutesDeps {
	sessionMap: Map<string, WebSessionEntry>;
	factory: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	defaultRuntime: AgentSessionRuntime;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	connectionManager?: ConnectionManager;
}

/** Bind web-mode extensions onto a runtime. Shared between default and created sessions. */
function bindWebExtensions(runtime: AgentSessionRuntime, sessionId: string): Promise<void> {
	return runtime.session.bindExtensions({
		mode: "web",
		commandContextActions: {
			waitForIdle: () => runtime.session.agent.waitForIdle(),
			newSession: async (opts) => runtime.newSession(opts),
			fork: async (entryId, opts) => runtime.fork(entryId, opts),
			navigateTree: async (targetId, opts) => runtime.session.navigateTree(targetId, opts),
			switchSession: async (sessionPath, opts) => runtime.switchSession(sessionPath, opts),
			reload: async () => runtime.session.reload(),
		},
		onError: (err) => {
			console.error(`[web] Session ${sessionId} extension error:`, err.error);
		},
	});
}

export function registerSessionRoutes(app: Hono, deps: SessionRoutesDeps): void {
	const { sessionMap, factory, agentDir, defaultRuntime, sessionManager, connectionManager } = deps;

	// Seed with the default session created at startup.
	// Marked as system: DELETE will not dispose its externally-owned runtime.
	const defaultSessionId = crypto.randomUUID();
	sessionMap.set(defaultSessionId, {
		runtime: defaultRuntime,
		createdAt: Date.now(),
		system: true,
	});

	// Bind web-mode extensions for the default session (matches POST behavior)
	void bindWebExtensions(defaultRuntime, defaultSessionId);

	// POST /api/sessions — create a new session
	app.post("/api/sessions", async (c) => {
		let body: CreateSessionRequest;
		try {
			body = await c.req.json<CreateSessionRequest>();
		} catch {
			return c.json({ error: "Invalid JSON body" } as const, 400);
		}

		const cwd = body.cwd ?? process.cwd();

		try {
			const runtime = await createAgentSessionRuntime(factory, {
				cwd,
				agentDir,
				sessionManager,
			});

			const id = crypto.randomUUID();

			await bindWebExtensions(runtime, id);

			sessionMap.set(id, { runtime, createdAt: Date.now() });

			return c.json({ sessionId: id } satisfies CreateSessionResponse, 201);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: "Failed to create session", details: message } as const, 500);
		}
	});

	// GET /api/sessions — list all sessions
	app.get("/api/sessions", (c) => {
		const summaries: SessionSummary[] = [];
		for (const [id, entry] of sessionMap) {
			summaries.push({
				id,
				name: entry.runtime.session.sessionManager.getSessionName() ?? undefined,
				cwd: entry.runtime.cwd,
				createdAt: entry.createdAt,
				model: entry.runtime.session.model?.id,
			});
		}
		return c.json(summaries);
	});

	// GET /api/sessions/:id — get session info
	app.get("/api/sessions/:id", (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}
		const s = entry.runtime.session;
		return c.json({
			id,
			name: s.sessionManager.getSessionName() ?? undefined,
			cwd: entry.runtime.cwd,
			createdAt: entry.createdAt,
			model: s.model?.id,
			thinkingLevel: s.thinkingLevel,
			messageCount: s.state.messages.length,
		});
	});

	// DELETE /api/sessions/:id — delete a session
	app.delete("/api/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const entry = sessionMap.get(id);
		if (!entry) {
			return c.json({ error: "Session not found" } as const, 404);
		}

		// Close all WebSocket connections for this session
		connectionManager?.removeSession(id);

		// Remove from map first to prevent concurrent access during async dispose
		sessionMap.delete(id);

		// System sessions own an externally-managed runtime — do not dispose
		if (!entry.system) {
			try {
				await entry.runtime.dispose();
			} catch {
				// Session may already be disposed
			}
		}

		return c.json({ success: true });
	});
}
