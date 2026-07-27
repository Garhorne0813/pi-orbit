import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";

/**
 * Types for the web mode REST API and WebSocket protocol.
 */

/** Options passed to runWebMode */
export interface WebModeOptions {
	/** HTTP server port (default: 3000 or PI_WEB_PORT env var) */
	port?: number;
	/** HTTP server host (default: 127.0.0.1 or PI_WEB_HOST env var) */
	host?: string;
	/** Bearer token for API authentication (default: PI_WEB_AUTH_TOKEN env var) */
	authToken?: string;
	/** Allowed CORS origin (default: PI_WEB_CORS_ORIGIN env var or *) */
	corsOrigin?: string;
}

/** Session summary returned by list endpoints */
export interface SessionSummary {
	id: string;
	name: string | undefined;
	cwd: string;
	createdAt: number;
	model: string | undefined;
}

/** Create session request body */
export interface CreateSessionRequest {
	cwd?: string;
	name?: string;
}

/** Create session response */
export interface CreateSessionResponse {
	sessionId: string;
}

/** Prompt request body */
export interface PromptRequest {
	message: string;
}

/** Bash command request body */
export interface BashRequest {
	command: string;
}

/** Fork session request body */
export interface ForkRequest {
	entryId?: string;
}

/** Set model request body */
export interface SetModelRequest {
	provider: string;
	modelId: string;
}

/** Set thinking level request body */
export interface SetThinkingRequest {
	level: string;
}

/** Rename session request body */
export interface RenameSessionRequest {
	name: string;
}

/** Export session request body */
export interface ExportSessionRequest {
	outputPath?: string;
}

/** Health check response */
export interface HealthResponse {
	status: "ok";
	version: string;
}

/** API error response */
export interface ApiError {
	error: string;
	details?: string;
}

/** In-memory session entry managed by the web mode */
export interface WebSessionEntry {
	runtime: AgentSessionRuntime;
	createdAt: number;
	/** True for the default session seeded at startup (not disposable via DELETE) */
	system?: boolean;
}

/** Command sent from WebSocket client to server */
export interface WsClientCommand {
	type: "prompt";
	message: string;
}

/** Type guard for WS client commands */
export function isWsClientCommand(data: unknown): data is WsClientCommand {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return obj.type === "prompt" && typeof obj.message === "string" && obj.message.length > 0;
}

export function isCreateSessionRequest(data: unknown): data is CreateSessionRequest {
	if (typeof data !== "object" || data === null) return false;
	const object = data as Record<string, unknown>;
	return (
		(object.cwd === undefined || typeof object.cwd === "string") &&
		(object.name === undefined || typeof object.name === "string")
	);
}

export function isPromptRequest(data: unknown): data is PromptRequest {
	return hasNonEmptyString(data, "message");
}

export function isBashRequest(data: unknown): data is BashRequest {
	return hasNonEmptyString(data, "command");
}

export function isForkRequest(data: unknown): data is ForkRequest {
	if (typeof data !== "object" || data === null) return false;
	const object = data as Record<string, unknown>;
	return object.entryId === undefined || typeof object.entryId === "string";
}

export function isSetModelRequest(data: unknown): data is SetModelRequest {
	return hasNonEmptyString(data, "provider") && hasNonEmptyString(data, "modelId");
}

export function isSetThinkingRequest(data: unknown): data is SetThinkingRequest {
	return hasNonEmptyString(data, "level");
}

export function isRenameSessionRequest(data: unknown): data is RenameSessionRequest {
	return hasNonEmptyString(data, "name");
}

export function isExportSessionRequest(data: unknown): data is ExportSessionRequest {
	if (typeof data !== "object" || data === null) return false;
	const object = data as Record<string, unknown>;
	return object.outputPath === undefined || typeof object.outputPath === "string";
}

function hasNonEmptyString(data: unknown, key: string): boolean {
	if (typeof data !== "object" || data === null) return false;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0;
}
