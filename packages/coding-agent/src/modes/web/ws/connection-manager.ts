/**
 * WebSocket connection manager for web mode.
 *
 * Tracks WebSocket connections per session, handles fan-out of
 * AgentSessionEvent messages to all connected clients for a session.
 */

import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";

/** Minimal WebSocket-like interface for sending messages */
export interface WebSocketLike {
	send(data: string): void;
	close(): void;
}

/** Per-session WebSocket connection tracking */
interface SessionConnections {
	clients: Set<WebSocketLike>;
	runtime: AgentSessionRuntime;
	unsubscribe: (() => void) | undefined;
}

export class ConnectionManager {
	private _sessions = new Map<string, SessionConnections>();

	async trackSession(
		sessionId: string,
		runtime: AgentSessionRuntime,
		bindSession: () => Promise<void>,
	): Promise<void> {
		if (this._sessions.has(sessionId)) {
			throw new Error(`Session is already tracked: ${sessionId}`);
		}
		const connections: SessionConnections = {
			clients: new Set(),
			runtime,
			unsubscribe: undefined,
		};
		this._sessions.set(sessionId, connections);
		runtime.setRebindSession(async () => {
			await bindSession();
			this.subscribeToCurrentSession(connections);
		});
		try {
			await bindSession();
		} catch (error) {
			this._sessions.delete(sessionId);
			runtime.setRebindSession(undefined);
			throw error;
		}
	}

	/**
	 * Register a WebSocket connection for a session.
	 * Starts forwarding events on first connection.
	 */
	register(sessionId: string, ws: WebSocketLike): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) throw new Error(`Session is not tracked: ${sessionId}`);
		conn.clients.add(ws);
		this.subscribeToCurrentSession(conn);
	}

	unregister(sessionId: string, ws: WebSocketLike): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) return;

		conn.clients.delete(ws);

		if (conn.clients.size === 0) {
			conn.unsubscribe?.();
			conn.unsubscribe = undefined;
		}
	}

	removeSession(sessionId: string): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) return;

		conn.runtime.setRebindSession(undefined);
		conn.unsubscribe?.();

		for (const client of conn.clients) {
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

	private subscribeToCurrentSession(connections: SessionConnections): void {
		connections.unsubscribe?.();
		connections.unsubscribe = undefined;
		if (connections.clients.size === 0) return;

		connections.unsubscribe = connections.runtime.session.subscribe((event: AgentSessionEvent) => {
			const message = JSON.stringify(event);
			for (const client of connections.clients) {
				try {
					client.send(message);
				} catch {
					connections.clients.delete(client);
				}
			}
			if (connections.clients.size === 0) {
				connections.unsubscribe?.();
				connections.unsubscribe = undefined;
			}
		});
	}
}
