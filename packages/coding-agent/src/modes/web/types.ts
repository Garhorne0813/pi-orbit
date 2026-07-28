import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
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
	/** Maximum runtimes held by one web host, including the startup runtime. */
	maxRuntimes?: number;
	/** Evict inactive non-system runtimes after this many milliseconds. */
	idleTimeoutMs?: number;
	/** Maximum simultaneous agent turns across all runtimes. */
	maxConcurrentTurns?: number;
	/** Maximum HTTP API request body size. */
	requestBodyLimitBytes?: number;
	/** Maximum time to wait for one runtime to dispose. */
	disposeTimeoutMs?: number;
	/** Maximum time to wait for complete Web host shutdown. */
	shutdownTimeoutMs?: number;
}

/** Session summary returned by list endpoints */
export interface SessionSummary {
	id: string;
	name: string | undefined;
	cwd: string;
	createdAt: number;
	model: string | undefined;
}

/** Stable host handle plus the current persisted Pi session identity. */
export interface RuntimeDescriptor {
	runtimeId: string;
	piSessionId: string;
	sessionPath: string | null;
	cwd: string;
	createdAt: number;
	lastActivityAt: number;
	busy: boolean;
	model: string | null;
	thinking: string | null;
	isStreaming: boolean;
	isCompacting: boolean;
}

export interface CreateRuntimeRequest {
	cwd: string;
	sessionDir: string;
	sessionPath?: string;
	model?: string;
	thinking?: string;
}

export interface ResumeRuntimeRequest {
	sessionPath: string;
	piSessionId?: string;
	cwdOverride?: string;
}

export interface RuntimeCapabilities {
	protocolVersion: 1;
	piVersion: string;
	isolationModel: "single-user-shared-process";
	supportedCommands: readonly ["prompt", "abort", "compact", "fork", "model", "resume"];
	supportsRuntimeEnvironment: false;
	supportsSessionResume: true;
	supportsEventSequence: true;
	supportsExtensionUI: true;
	features: {
		runtimeApi: true;
		eventReplay: true;
		runtimeEnvironment: false;
		runtimeResourceOverrides: false;
		idleEviction: true;
	};
}

export const RUNTIME_CAPABILITIES: Omit<RuntimeCapabilities, "piVersion"> = {
	protocolVersion: 1,
	isolationModel: "single-user-shared-process",
	supportedCommands: ["prompt", "abort", "compact", "fork", "model", "resume"],
	supportsRuntimeEnvironment: false,
	supportsSessionResume: true,
	supportsEventSequence: true,
	supportsExtensionUI: true,
	features: {
		runtimeApi: true,
		eventReplay: true,
		runtimeEnvironment: false,
		runtimeResourceOverrides: false,
		idleEviction: true,
	},
};

export interface RuntimeEventEnvelope {
	protocolVersion: 1;
	runtimeId: string;
	piSessionId: string;
	sequence: number;
	timestamp: string;
	event: AgentSessionEvent | WsExtensionUIRequest | { type: "runtime_evicted"; reason: "idle" };
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

/** Queued message request body */
export interface QueuedMessageRequest {
	message: string;
	images?: ImageContent[];
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

export interface QueueModeRequest {
	mode: "all" | "one-at-a-time";
}

export interface EnabledRequest {
	enabled: boolean;
}

export interface CycleModelRequest {
	direction?: "forward" | "backward";
}

/** Rename session request body */
export interface RenameSessionRequest {
	name: string;
}

/** Export session request body */
export interface ExportSessionRequest {
	outputPath?: string;
}

export interface SwitchSessionRequest {
	sessionPath: string;
	cwdOverride?: string;
}

/** Health check response */
export interface HealthResponse {
	status: "ok";
	version: string;
	protocolVersion: 1;
	runtimeHost: {
		runtimeCount: number;
		busyRuntimeCount: number;
		activeTurnCount: number;
		maxRuntimes: number;
		maxConcurrentTurns: number;
		atCapacity: boolean;
		bufferedEventCount: number;
	};
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
	lastActivityAt: number;
	/** True for the default session seeded at startup (not disposable via DELETE) */
	system?: boolean;
}

/** Command sent from WebSocket client to server */
export type WsExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type WsExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type WsClientMessage = { type: "prompt"; message: string } | { type: "abort" } | WsExtensionUIResponse;

/** Type guard for WS client commands */
export function isWsClientMessage(data: unknown): data is WsClientMessage {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (obj.type === "prompt") return typeof obj.message === "string" && obj.message.length > 0;
	if (obj.type === "abort") return true;
	if (obj.type !== "extension_ui_response" || typeof obj.id !== "string" || obj.id.length === 0) return false;
	return typeof obj.value === "string" || typeof obj.confirmed === "boolean" || obj.cancelled === true;
}

export function isCreateSessionRequest(data: unknown): data is CreateSessionRequest {
	if (typeof data !== "object" || data === null) return false;
	const object = data as Record<string, unknown>;
	return (
		(object.cwd === undefined || typeof object.cwd === "string") &&
		(object.name === undefined || typeof object.name === "string")
	);
}

export function isCreateRuntimeRequest(data: unknown): data is CreateRuntimeRequest {
	if (typeof data !== "object" || data === null) return false;
	const object = data as Record<string, unknown>;
	if (!hasNonEmptyString(object, "cwd") || !hasNonEmptyString(object, "sessionDir")) return false;
	if (object.sessionPath !== undefined && !hasNonEmptyString(object, "sessionPath")) return false;
	if (object.model !== undefined && !hasNonEmptyString(object, "model")) return false;
	if (object.thinking !== undefined && !hasNonEmptyString(object, "thinking")) return false;
	return object.runtimeEnv === undefined && object.skills === undefined && object.extensions === undefined;
}

export function isResumeRuntimeRequest(data: unknown): data is ResumeRuntimeRequest {
	if (!hasNonEmptyString(data, "sessionPath")) return false;
	const object = data as Record<string, unknown>;
	if (object.piSessionId !== undefined && !hasNonEmptyString(object, "piSessionId")) return false;
	return object.cwdOverride === undefined || hasNonEmptyString(object, "cwdOverride");
}

export function isPromptRequest(data: unknown): data is PromptRequest {
	return hasNonEmptyString(data, "message");
}

export function isQueuedMessageRequest(data: unknown): data is QueuedMessageRequest {
	if (!hasNonEmptyString(data, "message")) return false;
	const images = (data as Record<string, unknown>).images;
	return images === undefined || Array.isArray(images);
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

export function isQueueModeRequest(data: unknown): data is QueueModeRequest {
	if (typeof data !== "object" || data === null) return false;
	const mode = (data as Record<string, unknown>).mode;
	return mode === "all" || mode === "one-at-a-time";
}

export function isEnabledRequest(data: unknown): data is EnabledRequest {
	return typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).enabled === "boolean";
}

export function isCycleModelRequest(data: unknown): data is CycleModelRequest {
	if (typeof data !== "object" || data === null) return false;
	const direction = (data as Record<string, unknown>).direction;
	return direction === undefined || direction === "forward" || direction === "backward";
}

export function isRenameSessionRequest(data: unknown): data is RenameSessionRequest {
	return hasNonEmptyString(data, "name");
}

export function isExportSessionRequest(data: unknown): data is ExportSessionRequest {
	if (typeof data !== "object" || data === null) return false;
	const object = data as Record<string, unknown>;
	return object.outputPath === undefined || typeof object.outputPath === "string";
}

export function isSwitchSessionRequest(data: unknown): data is SwitchSessionRequest {
	if (!hasNonEmptyString(data, "sessionPath")) return false;
	const cwdOverride = (data as Record<string, unknown>).cwdOverride;
	return cwdOverride === undefined || (typeof cwdOverride === "string" && cwdOverride.length > 0);
}

function hasNonEmptyString(data: unknown, key: string): boolean {
	if (typeof data !== "object" || data === null) return false;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0;
}
