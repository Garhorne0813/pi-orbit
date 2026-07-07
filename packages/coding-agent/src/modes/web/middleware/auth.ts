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

import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

/** Create Hono middleware that validates Bearer token auth */
export function createAuthMiddleware(authToken?: string) {
	// Treat null/undefined/empty-string as "not configured" (open dev mode)
	const rawToken = authToken ?? process.env.PI_WEB_AUTH_TOKEN ?? undefined;
	const configuredToken = rawToken && rawToken.length > 0 ? rawToken : undefined;

	return async function authMiddleware(c: Context, next: Next): Promise<void> {
		// Bypass auth only when no token is configured
		if (configuredToken === undefined) {
			await next();
			return;
		}

		const authHeader = c.req.header("Authorization");
		if (!authHeader || !authHeader.startsWith("Bearer ")) {
			c.json({ error: "Unauthorized", details: "Missing or invalid Authorization header" }, 401);
			return;
		}

		const providedToken = authHeader.slice(7);
		// Constant-time comparison to prevent timing attacks
		const a = Buffer.from(providedToken);
		const b = Buffer.from(configuredToken);
		if (a.length !== b.length || !timingSafeEqual(a, b)) {
			c.json({ error: "Unauthorized", details: "Invalid token" }, 401);
			return;
		}

		await next();
	};
}
