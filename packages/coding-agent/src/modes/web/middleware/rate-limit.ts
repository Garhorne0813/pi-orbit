import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
	limit: number;
	windowMs: number;
}

interface Bucket {
	tokens: number;
	updatedAt: number;
}

export function createSessionRateLimit(options: RateLimitOptions): MiddlewareHandler {
	const buckets = new Map<string, Bucket>();
	const refillPerMillisecond = options.limit / options.windowMs;

	return async (context, next) => {
		const now = Date.now();
		const key = context.req.param("id") ?? context.req.param("runtimeId") ?? "";
		const previous = buckets.get(key) ?? { tokens: options.limit, updatedAt: now };
		const tokens = Math.min(options.limit, previous.tokens + (now - previous.updatedAt) * refillPerMillisecond);
		if (tokens < 1) {
			const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / refillPerMillisecond / 1000));
			context.header("Retry-After", String(retryAfterSeconds));
			return context.json({ error: "Too many prompt requests" } as const, 429);
		}

		buckets.set(key, { tokens: tokens - 1, updatedAt: now });
		await next();
	};
}
