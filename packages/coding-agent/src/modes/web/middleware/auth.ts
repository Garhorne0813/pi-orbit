/**
 * Authentication middleware for web mode.
 *
 * Supports Bearer token auth via:
 * - --auth-token CLI flag
 * - PI_ORBIT_AUTH_TOKEN environment variable
 *
 * When no token is configured, all requests are allowed (dev mode).
 * An empty or missing token disables authentication (dev mode).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export const WEB_AUTH_COOKIE_NAME = "pi_web_auth";

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
			if (!this.isRequestAuthorized(context.req.header("Authorization"), context.req.header("Cookie"))) {
				return context.json({ error: "Unauthorized", details: "Missing or invalid Authorization header" }, 401);
			}
			await next();
		};
	}

	createWebSocketMiddleware(): MiddlewareHandler {
		return async (context, next) => {
			if (!this.isRequestAuthorized(context.req.header("Authorization"), context.req.header("Cookie"))) {
				return context.json({ error: "Unauthorized", details: "Invalid token" }, 401);
			}
			await next();
		};
	}

	isRequestAuthorized(authorizationHeader?: string, cookieHeader?: string): boolean {
		if (!this.authenticationEnabled) return true;
		const bearerToken = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice(7) : undefined;
		if (bearerToken && this.matches(bearerToken)) return true;
		const cookieToken = this.readCookie(cookieHeader);
		return cookieToken !== undefined && this.matches(cookieToken);
	}

	createSessionCookie(): string | undefined {
		if (!this.configuredToken) return undefined;
		return `${WEB_AUTH_COOKIE_NAME}=${encodeURIComponent(this.configuredToken)}; Path=/; HttpOnly; SameSite=Strict`;
	}

	clearSessionCookie(): string {
		return `${WEB_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
	}

	private readCookie(cookieHeader: string | undefined): string | undefined {
		if (!cookieHeader) return undefined;
		for (const item of cookieHeader.split(";")) {
			const separator = item.indexOf("=");
			if (separator === -1 || item.slice(0, separator).trim() !== WEB_AUTH_COOKIE_NAME) continue;
			try {
				return decodeURIComponent(item.slice(separator + 1).trim());
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	private matches(providedToken: string): boolean {
		if (!this.configuredToken) return true;
		const provided = createHash("sha256").update(providedToken).digest();
		const configured = createHash("sha256").update(this.configuredToken).digest();
		return timingSafeEqual(provided, configured);
	}
}
