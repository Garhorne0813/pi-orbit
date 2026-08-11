/**
 * WebSocket connection manager for web mode.
 *
 * Permanently tracks runtime events and fans them out to connected clients.
 */

import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import type {
	RuntimeEventEnvelope,
	RuntimeSkillsState,
	WsExtensionUIRequest,
	WsExtensionUIResponse,
} from "../types.ts";

/** Minimal WebSocket-like interface for sending messages */
export interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

/** Per-session WebSocket connection tracking */
interface SessionConnections {
	clients: Map<WebSocketLike, { eventFormat: "raw" | "envelope"; replaying: boolean; pendingMessages: string[] }>;
	runtime: AgentSessionRuntime;
	unsubscribe: (() => void) | undefined;
	pendingUIRequests: Map<string, (response: WsExtensionUIResponse) => boolean>;
	events: RuntimeEventEnvelope[];
	sequence: number;
}

export type RegisterResult =
	| { ok: true; oldestSequence: number; latestSequence: number }
	| {
			ok: false;
			code: "event_replay_gap" | "event_sequence_ahead";
			oldestSequence: number;
			latestSequence: number;
	  };

export class ConnectionManager {
	private _sessions = new Map<string, SessionConnections>();
	private readonly eventBufferSize: number;

	constructor(options: { eventBufferSize?: number } = {}) {
		this.eventBufferSize = options.eventBufferSize ?? 512;
		if (!Number.isInteger(this.eventBufferSize) || this.eventBufferSize < 1) {
			throw new Error("eventBufferSize must be positive");
		}
	}

	async trackSession(
		sessionId: string,
		runtime: AgentSessionRuntime,
		bindSession: () => Promise<void>,
		onEvent?: () => void,
	): Promise<void> {
		if (this._sessions.has(sessionId)) {
			throw new Error(`Session is already tracked: ${sessionId}`);
		}
		const connections: SessionConnections = {
			clients: new Map(),
			runtime,
			unsubscribe: undefined,
			pendingUIRequests: new Map(),
			events: [],
			sequence: 0,
		};
		this._sessions.set(sessionId, connections);
		runtime.setRebindSession(async () => {
			await bindSession();
			this.subscribeToCurrentSession(sessionId, connections, onEvent);
		});
		try {
			await bindSession();
			this.subscribeToCurrentSession(sessionId, connections, onEvent);
		} catch (error) {
			this._sessions.delete(sessionId);
			runtime.setRebindSession(undefined);
			throw error;
		}
	}

	async replaceSession(
		sessionId: string,
		runtime: AgentSessionRuntime,
		bindSession: () => Promise<void>,
		onEvent?: () => void,
	): Promise<void> {
		const connections = this._sessions.get(sessionId);
		if (!connections) throw new Error(`Session is not tracked: ${sessionId}`);
		await bindSession();
		const previousRuntime = connections.runtime;
		previousRuntime.setRebindSession(undefined);
		connections.unsubscribe?.();
		this.cancelPendingUIRequests(connections);
		connections.runtime = runtime;
		runtime.setRebindSession(async () => {
			await bindSession();
			this.subscribeToCurrentSession(sessionId, connections, onEvent);
		});
		this.subscribeToCurrentSession(sessionId, connections, onEvent);
	}

	/**
	 * Register an event client and optionally replay buffered envelopes.
	 */
	register(
		sessionId: string,
		ws: WebSocketLike,
		options: { eventFormat?: "raw" | "envelope"; afterSequence?: number } = {},
	): RegisterResult {
		const conn = this._sessions.get(sessionId);
		if (!conn) throw new Error(`Session is not tracked: ${sessionId}`);
		const eventFormat = options.eventFormat ?? "raw";
		const oldestSequence = conn.events[0]?.sequence ?? conn.sequence;
		const latestSequence = conn.sequence;
		const afterSequence = options.afterSequence;
		if (eventFormat === "envelope" && afterSequence !== undefined) {
			if (oldestSequence > 0 && afterSequence < oldestSequence - 1) {
				return { ok: false, code: "event_replay_gap", oldestSequence, latestSequence };
			}
			if (afterSequence > latestSequence) {
				return { ok: false, code: "event_sequence_ahead", oldestSequence, latestSequence };
			}
		}
		const replay =
			eventFormat === "envelope" && afterSequence !== undefined
				? conn.events.filter((event) => event.sequence > afterSequence)
				: [];
		const client = { eventFormat, replaying: replay.length > 0, pendingMessages: [] as string[] };
		conn.clients.set(ws, client);
		for (const event of replay) this.deliverMessage(conn, ws, JSON.stringify(event));
		client.replaying = false;
		for (const message of client.pendingMessages.splice(0)) this.deliverMessage(conn, ws, message);
		return { ok: true, oldestSequence, latestSequence };
	}

	unregister(sessionId: string, ws: WebSocketLike): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) return;

		conn.clients.delete(ws);

		if (conn.clients.size === 0) this.cancelPendingUIRequests(conn);
	}

	sendToSession(sessionId: string, message: WsExtensionUIRequest): boolean {
		const conn = this._sessions.get(sessionId);
		if (!conn || conn.clients.size === 0) return false;
		this.recordEvent(sessionId, conn, message);
		if (conn.clients.size === 0) this.cancelPendingUIRequests(conn);
		return conn.clients.size > 0;
	}

	registerUIRequest(
		sessionId: string,
		requestId: string,
		resolve: (response: WsExtensionUIResponse) => boolean,
	): boolean {
		const conn = this._sessions.get(sessionId);
		if (!conn || conn.clients.size === 0) return false;
		conn.pendingUIRequests.set(requestId, resolve);
		return true;
	}

	resolveUIResponse(sessionId: string, response: WsExtensionUIResponse): boolean {
		const conn = this._sessions.get(sessionId);
		const resolve = conn?.pendingUIRequests.get(response.id);
		if (!conn || !resolve) return false;
		if (!resolve(response)) return false;
		conn.pendingUIRequests.delete(response.id);
		return true;
	}

	cancelUIRequest(sessionId: string, requestId: string): void {
		this._sessions.get(sessionId)?.pendingUIRequests.delete(requestId);
	}

	getPendingUIRequests(sessionId: string): string[] {
		return [...(this._sessions.get(sessionId)?.pendingUIRequests.keys() ?? [])];
	}

	get bufferedEventCount(): number {
		let count = 0;
		for (const connections of this._sessions.values()) count += connections.events.length;
		return count;
	}

	getBufferedEvents(sessionId: string, afterSequence = 0): RuntimeEventEnvelope[] {
		return (this._sessions.get(sessionId)?.events ?? []).filter((event) => event.sequence > afterSequence);
	}

	getReplayWindow(
		sessionId: string,
		afterSequence: number,
	): {
		events: RuntimeEventEnvelope[];
		oldestSequence: number;
		latestSequence: number;
		gap: boolean;
		ahead: boolean;
	} {
		const connections = this._sessions.get(sessionId);
		const oldestSequence = connections?.events[0]?.sequence ?? connections?.sequence ?? 0;
		const latestSequence = connections?.sequence ?? 0;
		return {
			events: this.getBufferedEvents(sessionId, afterSequence),
			oldestSequence,
			latestSequence,
			gap: oldestSequence > 0 && afterSequence < oldestSequence - 1,
			ahead: afterSequence > latestSequence,
		};
	}

	publishRuntimeEvicted(sessionId: string): void {
		const connections = this._sessions.get(sessionId);
		if (!connections) return;
		this.recordEvent(sessionId, connections, { type: "runtime_evicted", reason: "idle" });
	}

	publishRuntimeSkillsChanged(sessionId: string, reason: "policy" | "refresh", state: RuntimeSkillsState): void {
		const connections = this._sessions.get(sessionId);
		if (!connections) return;
		this.recordEvent(sessionId, connections, {
			type: "runtime_skills_changed",
			reason,
			policy: state.policy,
			enabledSkills: state.skills.filter((skill) => skill.enabled).map((skill) => skill.name),
		});
	}

	removeSession(sessionId: string): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) return;

		conn.runtime.setRebindSession(undefined);
		conn.unsubscribe?.();
		this.cancelPendingUIRequests(conn);

		for (const client of conn.clients.keys()) {
			try {
				client.close();
			} catch {
				// Ignore
			}
		}

		this._sessions.delete(sessionId);
	}

	connectionCount(sessionId: string): number {
		return this._sessions.get(sessionId)?.clients.size ?? 0;
	}

	private cancelPendingUIRequests(connections: SessionConnections): void {
		for (const resolve of connections.pendingUIRequests.values()) {
			resolve({ type: "extension_ui_response", id: "", cancelled: true });
		}
		connections.pendingUIRequests.clear();
	}

	private subscribeToCurrentSession(sessionId: string, connections: SessionConnections, onEvent?: () => void): void {
		connections.unsubscribe?.();
		connections.unsubscribe = undefined;

		connections.unsubscribe = connections.runtime.session.subscribe((event: AgentSessionEvent) => {
			onEvent?.();
			this.recordEvent(sessionId, connections, event);
		});
	}

	private recordEvent(sessionId: string, connections: SessionConnections, event: RuntimeEventEnvelope["event"]): void {
		const envelope: RuntimeEventEnvelope = {
			protocolVersion: 1,
			runtimeId: sessionId,
			piSessionId: connections.runtime.session.sessionId,
			sequence: ++connections.sequence,
			timestamp: new Date().toISOString(),
			event,
		};
		connections.events.push(envelope);
		if (connections.events.length > this.eventBufferSize) connections.events.shift();
		const rawMessage = JSON.stringify(event);
		const envelopeMessage = JSON.stringify(envelope);
		for (const [client, state] of connections.clients) {
			const message = state.eventFormat === "envelope" ? envelopeMessage : rawMessage;
			if (state.replaying) state.pendingMessages.push(message);
			else this.deliverMessage(connections, client, message);
		}
	}

	private deliverMessage(connections: SessionConnections, client: WebSocketLike, message: string): void {
		if (!connections.clients.has(client)) return;
		try {
			client.send(message);
		} catch {
			try {
				client.close(1011, "Event delivery failed");
			} catch {
				// Ignore close failures for already-broken connections.
			}
			connections.clients.delete(client);
		}
	}
}
