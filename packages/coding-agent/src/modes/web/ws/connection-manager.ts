/**
 * WebSocket connection manager for web mode.
 *
 * Tracks WebSocket connections per session, handles fan-out of
 * AgentSessionEvent messages to all connected clients for a session.
 */

import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type { WebSessionEntry } from "../types.ts";

/** Minimal WebSocket-like interface for sending messages */
export interface WebSocketLike {
	send(data: string): void;
	close(): void;
}

/** Per-session WebSocket connection tracking */
interface SessionConnections {
	clients: Set<WebSocketLike>;
	_unsubscribe: (() => void) | undefined;
}

export class ConnectionManager {
	private _sessions = new Map<string, SessionConnections>();

	/**
	 * Register a WebSocket connection for a session.
	 * Starts forwarding events on first connection.
	 */
	register(sessionId: string, entry: WebSessionEntry, ws: WebSocketLike): void {
		let conn = this._sessions.get(sessionId);
		if (!conn) {
			conn = {
				clients: new Set(),
				_unsubscribe: undefined,
			};
			this._sessions.set(sessionId, conn);
		}

		conn.clients.add(ws);

		// Subscribe to session events on first connection
		if (!conn._unsubscribe) {
			const sessionConnections = conn;
			const listener = (event: AgentSessionEvent) => {
				const message = JSON.stringify(event);
				for (const client of sessionConnections.clients) {
					try {
						client.send(message);
					} catch {
						// Client disconnected — remove dead connection
						sessionConnections.clients.delete(client);
					}
				}
			};

			try {
				conn._unsubscribe = entry.runtime.session.subscribe(listener);
			} catch {
				// Session might not support subscription
			}
		}
	}

	unregister(sessionId: string, ws: WebSocketLike): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) return;

		conn.clients.delete(ws);

		if (conn.clients.size === 0) {
			if (conn._unsubscribe) {
				conn._unsubscribe();
			}
			this._sessions.delete(sessionId);
		}
	}

	removeSession(sessionId: string): void {
		const conn = this._sessions.get(sessionId);
		if (!conn) return;

		if (conn._unsubscribe) {
			conn._unsubscribe();
		}

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
}
