import * as vscode from 'vscode';
import { fetchModels } from './llamaClient';
import { EndpointsConfig, EndpointConfig, Model } from './types';

/** Default context size when not provided by server or config */
const DEFAULT_CONTEXT_SIZE = 128000;

/** Min/max bounds for calculated max output tokens */
const MAX_OUTPUT_TOKENS_MIN = 8192;
const MAX_OUTPUT_TOKENS_MAX = 128000;
/** Fraction of context size used for max output tokens */
const MAX_OUTPUT_TOKENS_FRACTION = 0.25;

/**
 * Parse model ID to extract endpoint identifier and base model ID.
 * Returns { baseModelId, endpointId } where endpointId is null if no @identifier found.
 */
export function parseModelId(modelId: string): { baseModelId: string; endpointId: string | null } {
	const atIndex = modelId.lastIndexOf('@');
	if (atIndex === -1 || atIndex === 0 || atIndex === modelId.length - 1) {
		return { baseModelId: modelId, endpointId: null };
	}
	return {
		baseModelId: modelId.substring(0, atIndex),
		endpointId: modelId.substring(atIndex + 1),
	};
}

/**
 * Get endpoint configuration by identifier.
 */
export function getEndpointConfig(endpoints: EndpointsConfig, endpointId: string): EndpointConfig {
	const config = endpoints[endpointId];
	if (!config) {
		throw new Error(
			`Endpoint "${endpointId}" not found in configuration. Available endpoints: ${Object.keys(endpoints).join(', ') || 'none'}`
		);
	}
	return config;
}

/**
 * Get model-specific configuration merged with endpoint config (model overrides endpoint).
 */
export function getMergedModelConfig(
	endpoints: EndpointsConfig,
	endpointId: string,
	baseModelId: string
): { headers: Record<string, string>; requestBody: Record<string, unknown> } {
	const endpointConfig = getEndpointConfig(endpoints, endpointId);
	const modelConfig = endpointConfig.models?.[baseModelId];

	const headers: Record<string, string> = {};
	if (endpointConfig.headers) Object.assign(headers, endpointConfig.headers);
	if (modelConfig?.headers) Object.assign(headers, modelConfig.headers);

	const requestBody: Record<string, unknown> = {};
	if (endpointConfig.requestBody) Object.assign(requestBody, endpointConfig.requestBody);
	if (modelConfig?.requestBody) Object.assign(requestBody, modelConfig.requestBody);

	return { headers, requestBody };
}

/** Check if model has embeddings flag (embeddings-only, not chat). */
export function hasEmbeddings(model: Model): boolean {
	return model.status.args?.includes('--embeddings') ?? false;
}

/** Extract context size from model args (--ctx-size). Returns null if not found or invalid. */
export function extractContextSize(model: Model): number | null {
	const args = model.status.args;
	if (!args) return null;
	const ctxSizeIndex = args.indexOf('--ctx-size');
	if (ctxSizeIndex === -1 || ctxSizeIndex === args.length - 1) return null;
	const ctxSizeValue = args[ctxSizeIndex + 1];
	const ctxSize = parseInt(ctxSizeValue, 10);
	if (isNaN(ctxSize) || ctxSize === 0) return null;
	return ctxSize;
}

/** Calculate max output tokens from context size (25% of context, clamped to [8192, 128000]). */
export function calculateMaxOutputTokens(contextSize: number): number {
	const maxOutput = Math.floor(contextSize * MAX_OUTPUT_TOKENS_FRACTION);
	return Math.max(MAX_OUTPUT_TOKENS_MIN, Math.min(MAX_OUTPUT_TOKENS_MAX, maxOutput));
}

/** Check if model is suitable for chat (not embeddings-only). */
export function isChatCapable(model: Model): boolean {
	return !hasEmbeddings(model);
}

/** Default capabilities for chat models. */
export function getDefaultCapabilities(): vscode.LanguageModelChatCapabilities {
	return { toolCalling: true, imageInput: false };
}

/** Merge model-specific capabilities with defaults. */
export function getMergedCapabilities(
	modelConfig?: { capabilities?: vscode.LanguageModelChatCapabilities }
): vscode.LanguageModelChatCapabilities {
	const defaults = getDefaultCapabilities();
	if (!modelConfig?.capabilities) return defaults;
	return { ...defaults, ...modelConfig.capabilities };
}

/** Create model info from config only (when model is not in server list). */
export function createModelInfoFromConfig(
	endpointId: string,
	modelId: string,
	modelConfig?: { contextSize?: number; maxOutputTokens?: number; capabilities?: vscode.LanguageModelChatCapabilities }
): vscode.LanguageModelChatInformation {
	const modelIdWithEndpoint = `${modelId}@${endpointId}`;
	const effectiveContextSize = modelConfig?.contextSize ?? DEFAULT_CONTEXT_SIZE;
	const maxOutputTokens =
		modelConfig?.maxOutputTokens ?? calculateMaxOutputTokens(effectiveContextSize);
	return {
		id: modelIdWithEndpoint,
		name: modelIdWithEndpoint,
		tooltip: `Model from llama-server endpoint "${endpointId}" (configured)`,
		family: 'llama-server',
		maxInputTokens: effectiveContextSize,
		maxOutputTokens,
		version: '1.0.0',
		capabilities: getMergedCapabilities(modelConfig),
	};
}

/**
 * Fetch and build language model chat information for all configured endpoints.
 */
export async function provideLanguageModelChatInformation(
	endpoints: EndpointsConfig,
	requestTimeoutMs: number
): Promise<vscode.LanguageModelChatInformation[]> {
	const allModels: vscode.LanguageModelChatInformation[] = [];

	for (const [endpointId, endpointConfig] of Object.entries(endpoints)) {
		const foundModelIds = new Set<string>();
		try {
			const response = await fetchModels(
				endpointConfig.url,
				endpointConfig.apiToken,
				endpointConfig.headers,
				requestTimeoutMs
			);
			const chatModels = response.data.filter(
				(model) => !model.id.includes('/') && isChatCapable(model)
			);
			for (const model of chatModels) {
				foundModelIds.add(model.id);
				const modelConfig = endpointConfig.models?.[model.id];
				const extractedContextSize = extractContextSize(model);
				const effectiveContextSize =
					modelConfig?.contextSize ?? extractedContextSize ?? DEFAULT_CONTEXT_SIZE;
				const maxOutputTokens =
					modelConfig?.maxOutputTokens ?? calculateMaxOutputTokens(effectiveContextSize);
				allModels.push({
					id: `${model.id}@${endpointId}`,
					name: `${model.id}@${endpointId}`,
					tooltip: `Model from llama-server endpoint "${endpointId}" (${model.status.value})`,
					family: 'llama-server',
					maxInputTokens: effectiveContextSize,
					maxOutputTokens,
					version: '1.0.0',
					capabilities: getMergedCapabilities(modelConfig),
				});
			}
		} catch (error) {
			console.error(`Failed to fetch models from endpoint "${endpointId}":`, error);
		}
		if (endpointConfig.models) {
			for (const [modelId, modelConfig] of Object.entries(endpointConfig.models)) {
				if (modelId.includes('/') || foundModelIds.has(modelId)) continue;
				allModels.push(createModelInfoFromConfig(endpointId, modelId, modelConfig));
			}
		}
	}
	return allModels;
}
