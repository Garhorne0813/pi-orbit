import { getBuiltinModels } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

export function hasCloudflareWorkersAICredentials(): boolean {
	return !!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID;
}

export function hasCloudflareAiGatewayCredentials(): boolean {
	return (
		!!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_GATEWAY_ID
	);
}

/** Return an available generated Cloudflare AI Gateway OpenAI-compatible model, if any. */
export function getCloudflareAiGatewayCompatModel(): Model<Api> | undefined {
	const models = getBuiltinModels("cloudflare-ai-gateway") as Model<Api>[];
	return models.find((model) => model.api === "openai-completions" && model.baseUrl.endsWith("/compat"));
}

/** Create a stable local fixture for tests that exercise the Cloudflare /compat request shape. */
export function createCloudflareAiGatewayCompatModel(): Model<"openai-completions"> {
	return {
		id: "test-workers-ai-model",
		name: "Test Workers AI model",
		api: "openai-completions",
		provider: "cloudflare-ai-gateway",
		baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
			sendSessionAffinityHeaders: true,
		},
	};
}
