import type { Context, Hono } from "hono";
import { type WebCommand, WebCommandError, type WebCommandHandler } from "../commands.ts";
import {
	isCreateRuntimeRequest,
	isForkRequest,
	isPromptRequest,
	isResumeRuntimeRequest,
	isSetModelRequest,
	isWsClientMessage,
} from "../types.ts";
import { RuntimeCapacityError, type WebSessionHost } from "../web-session-host.ts";
import type { ConnectionManager } from "../ws/connection-manager.ts";

export function registerRuntimeRoutes(
	app: Hono,
	sessionHost: WebSessionHost,
	commands: WebCommandHandler,
	connectionManager: ConnectionManager,
): void {
	app.get("/api/runtimes", (context) => context.json(sessionHost.listRuntimes()));

	app.get("/api/runtimes/:runtimeId", (context) => {
		const descriptor = sessionHost.describe(context.req.param("runtimeId"));
		return descriptor
			? context.json(descriptor)
			: missingRuntimeResponse(context, sessionHost, context.req.param("runtimeId"));
	});

	app.post("/api/runtimes", async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid JSON body" } as const, 400);
		}
		if (!isCreateRuntimeRequest(body)) {
			return context.json({ error: "Invalid runtime request" } as const, 400);
		}
		try {
			return context.json(await sessionHost.createHostedRuntime(body), 201);
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			if (error instanceof RuntimeCapacityError) {
				return context.json({ error: error.message, code: "runtime_capacity_exceeded" } as const, 429);
			}
			const invalidConfiguration =
				details.startsWith("Model must") ||
				details.startsWith("Model not found") ||
				details.startsWith("Invalid thinking level");
			return context.json(
				{
					error: invalidConfiguration ? "Invalid runtime configuration" : "Failed to create runtime",
					details,
				} as const,
				invalidConfiguration ? 400 : 500,
			);
		}
	});

	app.delete("/api/runtimes/:runtimeId", async (context) => {
		const result = await sessionHost.removeSession(context.req.param("runtimeId"));
		if (result === "not_found") {
			return missingRuntimeResponse(context, sessionHost, context.req.param("runtimeId"));
		}
		if (result === "protected") {
			return context.json({ error: "Default runtime cannot be deleted" } as const, 403);
		}
		return context.json({ success: true } as const);
	});

	app.get("/api/runtimes/:runtimeId/health", (context) => {
		const descriptor = sessionHost.describe(context.req.param("runtimeId"));
		return descriptor
			? context.json({ healthy: true, protocolVersion: 1 as const, ...descriptor })
			: missingRuntimeResponse(context, sessionHost, context.req.param("runtimeId"));
	});

	app.post("/api/runtimes/:runtimeId/resume", async (context) => {
		const body = await readJson(context);
		if (!isResumeRuntimeRequest(body)) return context.json({ error: "Invalid resume request" } as const, 400);
		try {
			const descriptor = await sessionHost.resumeRuntime(context.req.param("runtimeId"), body);
			return descriptor
				? context.json(descriptor)
				: missingRuntimeResponse(context, sessionHost, context.req.param("runtimeId"));
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			return context.json(
				{
					error: details.startsWith("Pi session ID mismatch")
						? "Pi session ID mismatch"
						: "Failed to resume runtime",
					details,
				},
				details.startsWith("Pi session ID mismatch") ? 409 : 500,
			);
		}
	});

	app.post("/api/runtimes/:runtimeId/prompt", async (context) => {
		const body = await readJson(context);
		if (!isPromptRequest(body)) return context.json({ error: "Missing or invalid 'message' field" } as const, 400);
		return executeRuntimeCommand(context, sessionHost, commands, { type: "prompt", message: body.message }, 202);
	});

	app.post("/api/runtimes/:runtimeId/abort", (context) =>
		executeRuntimeCommand(context, sessionHost, commands, { type: "abort" }),
	);
	app.post("/api/runtimes/:runtimeId/compact", (context) =>
		executeRuntimeCommand(context, sessionHost, commands, { type: "compact" }),
	);

	app.post("/api/runtimes/:runtimeId/fork", async (context) => {
		const body = await readOptionalJson(context);
		if (!isForkRequest(body)) return context.json({ error: "Invalid fork request" } as const, 400);
		return executeRuntimeCommand(context, sessionHost, commands, { type: "fork", ...body });
	});

	app.post("/api/runtimes/:runtimeId/model", async (context) => {
		const body = await readJson(context);
		if (!isSetModelRequest(body)) {
			return context.json({ error: "Missing 'provider' or 'modelId' field" } as const, 400);
		}
		return executeRuntimeCommand(context, sessionHost, commands, { type: "set_model", ...body });
	});

	app.post("/api/runtimes/:runtimeId/ui-response", async (context) => {
		const runtimeId = context.req.param("runtimeId");
		const descriptor = sessionHost.describe(runtimeId);
		if (!descriptor) return missingRuntimeResponse(context, sessionHost, runtimeId);
		const body = await readJson(context);
		if (!isWsClientMessage(body) || body.type !== "extension_ui_response") {
			return context.json({ error: "Invalid extension UI response" } as const, 400);
		}
		if (!connectionManager.resolveUIResponse(runtimeId, body)) {
			return context.json({ error: "Extension UI request not found", code: "ui_request_not_found" } as const, 404);
		}
		sessionHost.markActivity(runtimeId);
		return context.json({ success: true, runtimeId, piSessionId: descriptor.piSessionId });
	});
}

async function executeRuntimeCommand(
	context: Context,
	sessionHost: WebSessionHost,
	commands: WebCommandHandler,
	command: WebCommand,
	status: 200 | 202 = 200,
): Promise<Response> {
	const runtimeId = context.req.param("runtimeId");
	if (!runtimeId) return context.json({ error: "Runtime ID is required" } as const, 400);
	try {
		const result = await commands.execute(runtimeId, command);
		sessionHost.markActivity(runtimeId);
		const descriptor = sessionHost.describe(runtimeId);
		if (!descriptor) return missingRuntimeResponse(context, sessionHost, runtimeId);
		return context.json({ ...result, runtimeId, piSessionId: descriptor.piSessionId }, status);
	} catch (error) {
		if (error instanceof WebCommandError) {
			if (error.status === 404) return missingRuntimeResponse(context, sessionHost, runtimeId);
			if (error.status === 429) {
				return context.json({ error: error.message, code: "agent_turn_capacity_exceeded" } as const, 429);
			}
			return context.json(
				{ error: error.message, details: error.details, code: "runtime_command_failed" },
				error.status,
			);
		}
		return context.json({ error: "Internal server error" } as const, 500);
	}
}

function missingRuntimeResponse(context: Context, sessionHost: WebSessionHost, runtimeId: string): Response {
	const code = sessionHost.getMissingRuntimeCode(runtimeId);
	return context.json(
		{ error: code === "runtime_evicted" ? "Runtime was evicted" : "Runtime not found", code },
		code === "runtime_evicted" ? 410 : 404,
	);
}

async function readJson(context: Context): Promise<unknown> {
	try {
		return await context.req.json();
	} catch {
		return undefined;
	}
}

async function readOptionalJson(context: Context): Promise<unknown> {
	try {
		return await context.req.json();
	} catch {
		return {};
	}
}
