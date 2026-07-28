import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";
import type { WebSessionHost } from "./web-session-host.ts";

export type WebCommand =
	| { type: "prompt"; message: string }
	| { type: "abort" }
	| { type: "steer"; message: string; images?: ImageContent[] }
	| { type: "follow_up"; message: string; images?: ImageContent[] }
	| { type: "abort_bash" }
	| { type: "abort_retry" }
	| { type: "bash"; command: string }
	| { type: "compact" }
	| { type: "fork"; entryId?: string }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string }
	| { type: "cycle_model"; direction?: "forward" | "backward" }
	| { type: "cycle_thinking" }
	| { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { type: "set_auto_compaction"; enabled: boolean }
	| { type: "set_auto_retry"; enabled: boolean };

export class WebCommandError extends Error {
	readonly status: 400 | 404 | 500;
	readonly details: string | undefined;

	constructor(message: string, status: 400 | 404 | 500, details?: string) {
		super(message);
		this.name = "WebCommandError";
		this.status = status;
		this.details = details;
	}
}

export class WebCommandHandler {
	private readonly sessionHost: WebSessionHost;
	private readonly onBackgroundError: (message: string, error: unknown) => void;

	constructor(sessionHost: WebSessionHost, onBackgroundError?: (message: string, error: unknown) => void) {
		this.sessionHost = sessionHost;
		this.onBackgroundError = onBackgroundError ?? ((message, error) => console.error(`[web] ${message}:`, error));
	}

	async execute(sessionId: string, command: WebCommand): Promise<Record<string, unknown>> {
		const entry = this.sessionHost.get(sessionId);
		if (!entry) throw new WebCommandError("Session not found", 404);
		const runtime = entry.runtime;

		try {
			switch (command.type) {
				case "prompt":
					await new Promise<void>((resolve, reject) => {
						let preflightSucceeded = false;
						void runtime.session
							.prompt(command.message, {
								preflightResult: (didSucceed) => {
									if (didSucceed) {
										preflightSucceeded = true;
										resolve();
									}
								},
							})
							.catch((error: unknown) => {
								if (preflightSucceeded) {
									this.onBackgroundError(`Session ${sessionId} prompt failed`, error);
								} else {
									reject(error);
								}
							});
					});
					return { success: true };
				case "abort":
					runtime.session.abort();
					return { success: true };
				case "steer":
					await runtime.session.steer(command.message, command.images);
					return { success: true };
				case "follow_up":
					await runtime.session.followUp(command.message, command.images);
					return { success: true };
				case "abort_bash":
					runtime.session.abortBash();
					return { success: true };
				case "abort_retry":
					runtime.session.abortRetry();
					return { success: true };
				case "bash":
					return { ...(await runtime.session.executeBash(command.command)) };
				case "compact":
					return { ...(await runtime.session.compact()) };
				case "fork": {
					let targetEntryId = command.entryId;
					if (!targetEntryId) {
						const firstUserEntry = runtime.session.sessionManager
							.getEntries()
							.find((entry) => entry.type === "message" && entry.message.role === "user");
						targetEntryId = firstUserEntry?.id;
					}
					if (!targetEntryId) throw new WebCommandError("No entry to fork from", 400);
					const result = await runtime.fork(targetEntryId);
					return result.cancelled
						? { success: false, reason: "cancelled" }
						: { success: true, selectedText: result.selectedText };
				}
				case "set_model": {
					const model = (await runtime.services.modelRuntime.getAvailable()).find(
						(candidate: Model<Api>) =>
							candidate.provider === command.provider && candidate.id === command.modelId,
					);
					if (!model) throw new WebCommandError(`Model not found: ${command.provider}/${command.modelId}`, 404);
					await runtime.session.setModel(model);
					return { success: true, model: model.id };
				}
				case "set_thinking_level":
					if (!isValidThinkingLevel(command.level)) {
						throw new WebCommandError(
							"Invalid thinking level",
							400,
							"Must be one of: off, minimal, low, medium, high, xhigh",
						);
					}
					runtime.session.setThinkingLevel(command.level);
					return { success: true, level: command.level };
				case "cycle_model":
					return { result: (await runtime.session.cycleModel(command.direction)) ?? null };
				case "cycle_thinking":
					return { level: runtime.session.cycleThinkingLevel() ?? null };
				case "set_steering_mode":
					runtime.session.setSteeringMode(command.mode);
					return { success: true, mode: command.mode };
				case "set_follow_up_mode":
					runtime.session.setFollowUpMode(command.mode);
					return { success: true, mode: command.mode };
				case "set_auto_compaction":
					runtime.session.setAutoCompactionEnabled(command.enabled);
					return { success: true, enabled: command.enabled };
				case "set_auto_retry":
					runtime.session.setAutoRetryEnabled(command.enabled);
					return { success: true, enabled: command.enabled };
			}
		} catch (error) {
			if (error instanceof WebCommandError) throw error;
			const details = error instanceof Error ? error.message : String(error);
			throw new WebCommandError(`Failed to execute ${command.type} command`, 500, details);
		}
	}
}
