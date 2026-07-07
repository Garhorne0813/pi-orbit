/**
 * HTTP + WebSocket server for web mode.
 *
 * Sets up a Hono app with REST API routes and WebSocket upgrade handling.
 */

import * as crypto from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { VERSION } from "../../config.ts";
import { createAuthMiddleware } from "./middleware/auth.ts";
import { registerModelRoutes } from "./routes/model.ts";
import { registerPromptRoutes } from "./routes/prompt.ts";
import { registerSessionRoutes, type SessionRoutesDeps } from "./routes/sessions.ts";
import { registerToolRoutes } from "./routes/tools.ts";
import type { HealthResponse, WebSessionEntry } from "./types.ts";
import { isWsClientCommand } from "./types.ts";
import { ConnectionManager, type WebSocketLike } from "./ws/connection-manager.ts";

export interface CreateServerOptions {
	authToken?: string;
	sessionMap: Map<string, WebSessionEntry>;
	sessionRoutesDeps: SessionRoutesDeps;
	modelRegistry: SessionRoutesDeps["modelRegistry"];
}

export function createApp(options: CreateServerOptions): { app: Hono; connectionManager: ConnectionManager } {
	const { authToken, sessionMap, sessionRoutesDeps, modelRegistry } = options;
	const app = new Hono();
	const connectionManager = new ConnectionManager();

	const auth = createAuthMiddleware(authToken);

	// CORS middleware — allow browser clients from any origin
	app.use("*", async (c, next) => {
		c.res.headers.set("Access-Control-Allow-Origin", "*");
		c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
		if (c.req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: c.res.headers });
		}
		await next();
	});

	// Health check (no auth required)
	app.get("/api/health", (c) => {
		return c.json<HealthResponse>({ status: "ok", version: VERSION });
	});

	// Protected routes
	app.use("/api/*", auth);

	// Wire connectionManager into session routes so DELETE can clean up WS connections
	sessionRoutesDeps.connectionManager = connectionManager;

	// Register route modules
	registerSessionRoutes(app, sessionRoutesDeps);
	registerPromptRoutes(app, { sessionMap });
	registerModelRoutes(app, { sessionMap, modelRegistry });
	registerToolRoutes(app, { sessionMap });

	// WebSocket informational endpoint
	app.get("/ws", (c) => {
		const upgradeHeader = c.req.header("Upgrade");
		if (upgradeHeader !== "websocket") {
			return c.json(
				{
					error: "WebSocket upgrade required",
					endpoint: "ws://host:port/ws",
					params: { session_id: "<id>", token: "<auth_token>" },
				},
				426,
			);
		}
		return new Response(null, { status: 101, statusText: "Switching Protocols" });
	});

	return { app, connectionManager };
}

/**
 * Create a Node.js HTTP server that routes requests through Hono
 * and handles WebSocket upgrades.
 */
export function createHttpServer(
	app: Hono,
	sessionMap: Map<string, WebSessionEntry>,
	connectionManager: ConnectionManager,
	authToken?: string,
) {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		// Build a Web Request from Node.js req
		const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value) {
				if (Array.isArray(value)) {
					for (const v of value) headers.set(key, v);
				} else {
					headers.set(key, value);
				}
			}
		}

		// Read body for non-GET requests
		const method = req.method ?? "GET";
		let body: ReadableStream | null = null;
		if (method !== "GET" && method !== "HEAD") {
			const listeners: Array<[string, (...args: any[]) => void]> = [];
			body = new ReadableStream({
				start(controller) {
					const onData = (chunk: Buffer) => controller.enqueue(chunk);
					const onEnd = () => controller.close();
					const onError = (err: Error) => controller.error(err);
					req.on("data", onData);
					req.on("end", onEnd);
					req.on("error", onError);
					listeners.push(["data", onData], ["end", onEnd], ["error", onError]);
				},
				cancel() {
					for (const [event, handler] of listeners) {
						req.removeListener(event, handler);
					}
				},
			});
		}

		const webReq = new Request(url, {
			method,
			headers,
			body: body as never,
			duplex: "half",
		} as RequestInit);

		void Promise.resolve(app.fetch(webReq))
			.then((webRes: Response) => {
				res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
				if (webRes.body) {
					const reader = (webRes.body as ReadableStream).getReader();
					const pump = (): void => {
						void reader
							.read()
							.then(({ done, value }) => {
								if (done) {
									res.end();
									return;
								}
								res.write(value);
								pump();
							})
							.catch((streamErr: unknown) => {
								console.error("[web] Response stream error:", streamErr);
								if (!res.writableEnded) {
									res.end();
								}
							});
					};
					pump();
				} else {
					res.end();
				}
			})
			.catch((err: unknown) => {
				console.error("[web] Request error:", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			});
	});

	// WebSocket upgrade handler
	server.on("upgrade", (request: IncomingMessage, socket: Socket, _head: Buffer) => {
		const url = new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`);

		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}

		const sessionId = url.searchParams.get("session_id");
		if (!sessionId) {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing session_id\r\n");
			socket.destroy();
			return;
		}

		const token = authToken ?? process.env.PI_WEB_AUTH_TOKEN ?? undefined;
		if (token) {
			const queryToken = url.searchParams.get("token");
			if (!queryToken || queryToken !== token) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\nInvalid token\r\n");
				socket.destroy();
				return;
			}
		}

		const entry = sessionMap.get(sessionId);
		if (!entry) {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\nSession not found\r\n");
			socket.destroy();
			return;
		}

		const key = request.headers["sec-websocket-key"];
		if (!key) {
			socket.destroy();
			return;
		}

		const acceptKey = createAcceptKey(key);
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
		);

		const ws = createWebSocketLike(socket);
		connectionManager.register(sessionId, entry, ws);

		let frameBuffer = Buffer.alloc(0);
		let fragmentedMessage = "";

		socket.on("data", (chunk: Buffer) => {
			try {
				// Accumulate buffer for frame reassembly across TCP packets
				frameBuffer = Buffer.concat([frameBuffer, chunk]);

				// Process all complete frames in the buffer
				while (frameBuffer.length >= 2) {
					const parsed = parseWebSocketFrame(frameBuffer);
					if (parsed === null) return; // Incomplete frame, wait for more data

					// Remove processed bytes from buffer
					frameBuffer = frameBuffer.slice(parsed.consumed);

					if (parsed.type === "close") {
						socket.destroy(); // socket.on("close") will handle unregister
						return;
					}

					if (parsed.type === "ping") {
						// Respond with pong
						const pong = Buffer.alloc(2 + (parsed.data ? parsed.data.length : 0));
						pong[0] = 0x8a; // FIN + Pong opcode
						pong[1] = parsed.data ? parsed.data.length : 0;
						if (parsed.data) Buffer.from(parsed.data).copy(pong, 2);
						socket.write(pong);
						continue;
					}

					if (parsed.type === "pong") {
						// Pong frame — already consumed from buffer, continue
						continue;
					}

					if (parsed.type === "text" || parsed.type === "continuation") {
						fragmentedMessage += parsed.data;

						// Prevent unbounded message accumulation
						if (fragmentedMessage.length > MAX_MESSAGE_LENGTH) {
							console.error("[web] WS message exceeds size limit, closing connection");
							socket.destroy();
							return;
						}

						if (parsed.fin) {
							// Final frame — process complete message
							const message = fragmentedMessage;
							fragmentedMessage = "";
							try {
								const data = JSON.parse(message);
								if (isWsClientCommand(data)) {
									if (data.type === "prompt") {
										entry.runtime.session.prompt(data.message).catch((err: unknown) => {
											console.error(`[web] WS prompt error:`, err);
										});
									}
								}
							} catch {
								// Ignore unparseable messages
							}
						}
						// If !fin, wait for continuation frames
					}
				}
			} catch (err) {
				// Fatal frame parse error — close the connection
				console.error("[web] WS frame parse error:", err);
				socket.destroy();
			}
		});

		let wsClosed = false;
		socket.on("close", () => {
			if (wsClosed) return;
			wsClosed = true;
			connectionManager.unregister(sessionId, ws);
		});

		socket.on("error", () => {
			connectionManager.unregister(sessionId, ws);
			socket.destroy();
		});
	});

	return server;
}

// ============================================================================
// WebSocket protocol helpers
// ============================================================================

function createAcceptKey(key: string): string {
	const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
	return crypto
		.createHash("sha1")
		.update(key + GUID)
		.digest("base64");
}

function createWebSocketLike(socket: Socket): WebSocketLike {
	return {
		send(data: string): void {
			try {
				const frame = encodeWebSocketFrame(data);
				socket.write(frame);
			} catch {
				// Ignore
			}
		},
		close(): void {
			try {
				const closeFrame = Buffer.alloc(2);
				closeFrame[0] = 0x88;
				closeFrame[1] = 0x00;
				socket.write(closeFrame);
				socket.destroy();
			} catch {
				socket.destroy();
			}
		},
	};
}

function encodeWebSocketFrame(data: string): Buffer {
	const payload = Buffer.from(data, "utf-8");
	const length = payload.length;

	if (length < 126) {
		const frame = Buffer.alloc(2 + length);
		frame[0] = 0x81;
		frame[1] = length;
		payload.copy(frame, 2);
		return frame;
	}
	if (length < 65536) {
		const frame = Buffer.alloc(4 + length);
		frame[0] = 0x81;
		frame[1] = 126;
		frame.writeUInt16BE(length, 2);
		payload.copy(frame, 4);
		return frame;
	}
	const frame = Buffer.alloc(10 + length);
	frame[0] = 0x81;
	frame[1] = 127;
	frame.writeBigUInt64BE(BigInt(length), 2);
	payload.copy(frame, 10);
	return frame;
}

/** Maximum payload length for a single WebSocket frame (1 MiB) */
const MAX_FRAME_PAYLOAD = 1024 * 1024;

/** Maximum accumulated message length across fragmented frames (16 MiB) */
const MAX_MESSAGE_LENGTH = 16 * 1024 * 1024;

interface ParsedFrame {
	type: "text" | "continuation" | "close" | "ping" | "pong";
	data: string;
	/** true if this is a final (FIN) frame */
	fin: boolean;
	/** number of bytes consumed from the input buffer */
	consumed: number;
}

function parseWebSocketFrame(buffer: Buffer): ParsedFrame | null {
	if (buffer.length < 2) return null;

	const firstByte = buffer[0];
	const secondByte = buffer[1];
	const fin = (firstByte & 0x80) !== 0;
	const rsv = firstByte & 0x70;
	const opcode = firstByte & 0x0f;
	const masked = (secondByte & 0x80) !== 0;
	let payloadLength = secondByte & 0x7f;
	let offset = 2;

	// Client-to-server frames MUST be masked (RFC 6455 §5.1)
	if (!masked) {
		throw new Error("unmasked client frame");
	}

	// RSV bits must be zero without negotiated extensions
	if (rsv !== 0) {
		throw new Error("non-zero RSV bits");
	}

	if (payloadLength === 126) {
		if (buffer.length < 4) return null;
		payloadLength = buffer.readUInt16BE(2);
		offset = 4;
	} else if (payloadLength === 127) {
		if (buffer.length < 10) return null;
		payloadLength = Number(buffer.readBigUInt64BE(2));
		offset = 10;
	}

	// Enforce per-frame payload limit to prevent memory exhaustion
	if (payloadLength > MAX_FRAME_PAYLOAD) {
		throw new Error(`payload too large: ${payloadLength}`);
	}

	// Control frames must have payload <= 125 bytes and must not be fragmented (RFC 6455 §5.5)
	const isControlFrame = opcode === 0x8 || opcode === 0x9 || opcode === 0xa;
	if (isControlFrame && payloadLength > 125) {
		throw new Error("control frame payload exceeds 125 bytes");
	}

	// Check if complete frame is available (masked is guaranteed true here)
	if (buffer.length < offset + 4 + payloadLength) return null;

	const maskKey = buffer.slice(offset, offset + 4);
	offset += 4;
	const payload = buffer.slice(offset, offset + payloadLength);
	for (let i = 0; i < payload.length; i++) {
		payload[i] ^= maskKey[i % 4];
	}

	const consumed = offset + payloadLength;

	if (opcode === 0x8) return { type: "close", data: "", fin: true, consumed };
	if (opcode === 0x9) return { type: "ping", data: payload.toString("utf-8"), fin: true, consumed };
	if (opcode === 0xa) return { type: "pong", data: "", fin: true, consumed };
	if (opcode === 0x0) return { type: "continuation", data: payload.toString("utf-8"), fin, consumed };
	if (opcode === 0x1) return { type: "text", data: payload.toString("utf-8"), fin, consumed };

	throw new Error(`unknown opcode: ${opcode}`);
}
