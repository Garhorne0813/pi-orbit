/**
 * Authentication middleware for web mode.
 *
 * Supports Bearer token auth via:
 * - --auth-token CLI flag
 * - PI_WEB_AUTH_TOKEN environment variable
 *
 * When no token is configured, all requests are allowed (dev mode).
 * An empty or missing token disables authentication (dev mode).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export class WebAccessPolicy {
	private readonly configuredToken: string | undefined;

	constructor(authToken?: string) {
		this.configuredToken = authToken && authToken.length > 0 ? authToken : undefined;
	}

	get authenticationEnabled(): boolean {
		return this.configuredToken !== undefined;
	}

	createHttpMiddleware(): MiddlewareHandler {
		return async (context, next) => {
			if (!this.authenticationEnabled) {
				await next();
				return;
			}

			const authHeader = context.req.header("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return context.json({ error: "Unauthorized", details: "Missing or invalid Authorization header" }, 401);
			}
			if (!this.matches(authHeader.slice(7))) {
				return context.json({ error: "Unauthorized", details: "Invalid token" }, 401);
			}
			await next();
		};
	}

	createWebSocketMiddleware(): MiddlewareHandler {
		return async (context, next) => {
			if (!this.authenticationEnabled) {
				await next();
				return;
			}

			const authHeader = context.req.header("Authorization");
			const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
			if (!token || !this.matches(token)) {
				return context.json({ error: "Unauthorized", details: "Invalid token" }, 401);
			}
			await next();
		};
	}

	private matches(providedToken: string): boolean {
		if (!this.configuredToken) return true;
		const provided = createHash("sha256").update(providedToken).digest();
		const configured = createHash("sha256").update(this.configuredToken).digest();
		return timingSafeEqual(provided, configured);
	}
}
