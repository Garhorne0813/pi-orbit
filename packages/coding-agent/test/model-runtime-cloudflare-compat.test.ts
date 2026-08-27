import type { Model } from "@earendil-works/pi-ai";
import { resetApiProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const openAIState = vi.hoisted(() => ({ clientOptions: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			openAIState.clientOptions = options;
		}

		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse(): Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const cloudflareCompatModel: Model<"openai-completions"> = {
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

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();

		resetApiProviders();
		await modelRuntime.completeSimple(cloudflareCompatModel, { messages: [] });

		const clientOptions = openAIState.clientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();

		resetApiProviders();
		const auth = await modelRegistry.getApiKeyAndHeaders(cloudflareCompatModel);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		await modelRegistry.complete(cloudflareCompatModel, { messages: [] }, auth);

		const clientOptions = openAIState.clientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test-token");
		expect(clientOptions.defaultHeaders?.Authorization).toBeNull();
		expect(clientOptions.defaultHeaders?.["x-api-key"]).toBeNull();
	});
});
