import type { Context } from "hono";
import { WebCommandError } from "../commands.ts";

export async function executeCommand(context: Context, command: () => Promise<Record<string, unknown>>) {
	try {
		return context.json(await command());
	} catch (error) {
		if (error instanceof WebCommandError) {
			return context.json({ error: error.message, details: error.details }, error.status);
		}
		return context.json({ error: "Internal server error" } as const, 500);
	}
}
