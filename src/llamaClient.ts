import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelChatRequestMessage,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelChatTool,
	LanguageModelChatToolMode,
} from 'vscode';
import {
	ModelsResponse,
	Model,
	TokenizeRequest,
	TokenizeResponse,
	ApplyTemplateResponse,
	PreparedCompletionRequest,
	OpenAIChatMessage,
	OpenAIContentPart,
	OpenAITool,
	OpenAIToolCall,
	OpenAIChatCompletionChunk,
	OpenAIChatCompletionChunkWithProgress,
	OpenAIUsage,
	LlamaServerTimings,
	StreamToolCallDeltaAccumulator,
	InfillRequest,
	InfillResponse,
} from './types';
import { extractReasoningFromAssistantMessage, isNewUserMessage as isNewUserMessageCheck, type ReasoningSource } from './thinkingParts';
import { fetch, Agent } from 'undici';
import { logRequest, logResponse, logError, logStreamStart, logStreamResponse, logTokenizeRequest, logTokenizeResponse } from './logger';

import { normalizeFetchError, isConnectionResetError, describeFetchError } from './errorUtils';
import { parseServerError, formatServerErrorMessage } from './serverErrorUtils';
import { computeRateLimitDelayMs, RATE_LIMIT_RETRY_MAX_ATTEMPTS, RATE_LIMIT_RETRY_BASE_DELAY_MS } from './rateLimitUtils';
import { computeThinkingBudgetTokens } from './modelInfo';
import * as crypto from 'crypto';

type UndiciResponse = Awaited<ReturnType<typeof fetch>>;

const DEFAULT_REQUEST_TIMEOUT_MS = 1200 * 1000;

const CONNECTION_RESET_RETRY_MAX_ATTEMPTS = 4;
const CONNECTION_RESET_RETRY_BASE_DELAY_MS = 200;

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new DOMException('Aborted', 'AbortError'));
	}
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(t);
			reject(new DOMException('Aborted', 'AbortError'));
		}, { once: true });
	});
}

/**
 * Runs fn(); on ECONNRESET, retries up to maxAttempts times with exponential backoff.
 * Respects AbortSignal: does not wait/retry if signal is aborted.
 */
async function withConnectionResetRetry<T>(
	fn: () => Promise<T>,
	options?: { maxAttempts?: number; baseDelayMs?: number; signal?: AbortSignal }
): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? CONNECTION_RESET_RETRY_MAX_ATTEMPTS;
	const baseDelayMs = options?.baseDelayMs ?? CONNECTION_RESET_RETRY_BASE_DELAY_MS;
	const signal = options?.signal;
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (e) {
			lastError = e;
			if (!isConnectionResetError(e) || attempt === maxAttempts - 1) {
				throw e;
			}
			await delayMs(baseDelayMs * Math.pow(2, attempt), signal);
		}
	}
	throw lastError;
}

/**
 * Retries a fetch on HTTP 429 (rate limit) with exponential backoff or Retry-After.
 * Returns the final Response (which may still be 429 if all retries are exhausted).
 */
async function fetchWithRateLimitRetry(
	doFetch: () => Promise<UndiciResponse>,
	options?: { signal?: AbortSignal; maxAttempts?: number; baseDelayMs?: number }
): Promise<UndiciResponse> {
	const maxAttempts = options?.maxAttempts ?? RATE_LIMIT_RETRY_MAX_ATTEMPTS;
	const baseDelayMs = options?.baseDelayMs ?? RATE_LIMIT_RETRY_BASE_DELAY_MS;
	const signal = options?.signal;

	for (let attempt = 0; ; attempt++) {
		const response = await doFetch();
		if (response.status !== 429 || attempt >= maxAttempts - 1) {
			return response;
		}
		await response.text().catch(() => {});
		const retryAfter = response.headers.get('retry-after');
		const delay = computeRateLimitDelayMs(attempt, retryAfter, baseDelayMs);
		logError(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`, 'rateLimitRetry');
		await delayMs(delay, signal);
	}
}

/**
 * Throw a formatted error if the response is not OK.
 * Reads the response body, parses llama-server JSON errors, and throws a user-friendly message.
 */
async function throwIfNotOk(response: UndiciResponse, context: string): Promise<void> {
	if (response.ok) return;
	const errorText = await response.text().catch(() => 'Unknown error');
	logError(`Failed in ${context}: ${response.statusText}`, context);
	const parsed = parseServerError(errorText);
	const formatted = formatServerErrorMessage(parsed, response.status, errorText || response.statusText);
	throw new Error(formatted);
}

/**
 * Centralized API error handling: rethrow known errors, log, normalize fetch errors, then rethrow.
 */
function handleApiError(
	error: unknown,
	context: string,
	knownMessagePrefixes: string | string[],
	url?: string
): never {
	const prefixes = Array.isArray(knownMessagePrefixes) ? knownMessagePrefixes : [knownMessagePrefixes];
	if (error instanceof Error && prefixes.some((p) => error.message.includes(p))) {
		throw error;
	}
	const normalized = normalizeFetchError(error, url);
	const details = describeFetchError(error);
	const urlDetail = url ? ` url=${url}` : '';
	const logDetails = [details.formattedSummary, urlDetail.trim()].filter(Boolean).join(' | ') || undefined;
	const logMessage = normalized ?? (error instanceof Error ? error.message : String(error));
	logError(logMessage, context, logDetails);
	if (normalized) {
		throw new Error(normalized);
	}
	throw error;
}
const dispatcherCache = new Map<number, Agent>();

function getDispatcher(timeoutMs: number): Agent {
	let agent = dispatcherCache.get(timeoutMs);
	if (!agent) {
		agent = new Agent({ bodyTimeout: timeoutMs, headersTimeout: timeoutMs });
		dispatcherCache.set(timeoutMs, agent);
	}
	return agent;
}

export { normalizeFetchError } from './errorUtils';

/**
 * Fetch available models from llama-server
 */
export async function fetchModels(
	serverUrl: string,
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	requestTimeoutMs?: number
): Promise<ModelsResponse> {
	const url = `${serverUrl}/models`;
	const timeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const dispatcher = getDispatcher(timeoutMs);

	const headers: Record<string, string> = {};
	if (apiToken) {
		headers['Authorization'] = `Bearer ${apiToken}`;
	}
	// Merge endpoint headers (endpoint headers take precedence)
	if (endpointHeaders) {
		Object.assign(headers, endpointHeaders);
	}
	
	try {
		return await withConnectionResetRetry(async () => {
			logRequest('GET', url, headers);
			const response = await fetchWithRateLimitRetry(
				() => fetch(url, { headers, dispatcher })
			);
			await throwIfNotOk(response, 'fetchModels');

			const data = await response.json() as ModelsResponse;
			logResponse(response.status, response.statusText, data);
			return data;
		});
	} catch (error) {
		handleApiError(error, 'fetchModels', ['Failed in fetchModels', 'Rate limit exceeded'], url);
	}
}

/** Short timeout for probing /models when building proxy-error suggestion (ms) */
const MODELS_PROBE_TIMEOUT_MS = 10_000;

/** Result of probing /models for --timeout: what we found and what to suggest */
type TimeoutProbeResult =
	| { serverHasTimeout: false; suggestedSeconds: number }
	| { serverHasTimeout: true; currentSeconds: number; suggestedSeconds: number };

/**
 * Fetch /models and derive timeout suggestion from the first model whose id contains '/'.
 * Returns what we found (and suggested value), or null on any failure.
 */
async function getSuggestedTimeoutFromModels(
	serverUrl: string,
	apiToken?: string,
	endpointHeaders?: Record<string, string>
): Promise<TimeoutProbeResult | null> {
	const url = `${serverUrl}/models`;
	const headers: Record<string, string> = {};
	if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
	if (endpointHeaders) Object.assign(headers, endpointHeaders);
	const dispatcher = getDispatcher(MODELS_PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, dispatcher });
		if (!response.ok) return null;
		const data = (await response.json()) as ModelsResponse;
		const modelWithSlash = data.data?.find((m: Model) => m.id.includes('/'));
		if (!modelWithSlash?.status?.args) return null;
		const args = modelWithSlash.status.args;
		const idx = args.indexOf('--timeout');
		if (idx === -1 || idx === args.length - 1) {
			return { serverHasTimeout: false, suggestedSeconds: 3600 };
		}
		const value = parseInt(args[idx + 1], 10);
		if (isNaN(value) || value < 0) {
			return { serverHasTimeout: false, suggestedSeconds: 3600 };
		}
		const suggested = Math.max(3600, value * 2);
		return { serverHasTimeout: true, currentSeconds: value, suggestedSeconds: suggested };
	} catch {
		return null;
	}
}

/**
 * Convert VS Code tools to OpenAI format
 */
export function convertVSCodeToolsToOpenAI(
	tools?: readonly LanguageModelChatTool[]
): OpenAITool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => {
		const inputSchema = (tool.inputSchema as {
			type?: string;
			properties?: Record<string, unknown>;
			required?: string[];
		}) || {};

		return {
			type: 'function' as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: {
					type: inputSchema.type || 'object',
					properties: inputSchema.properties || {},
					required: inputSchema.required || [],
				},
			},
		};
	});
}

/**
 * Convert a single VS Code input part to an OpenAI content part.
 * Returns undefined for parts that cannot be converted (thinking parts, unknown types).
 */
export function convertInputPartToOpenAI(
	part: unknown,
	options?: { allowMultimodal?: boolean }
): OpenAIContentPart | undefined {
	if (part instanceof LanguageModelTextPart) {
		return { type: 'text', text: part.value };
	}

	// Duck-type LanguageModelDataPart (has data: Uint8Array and mimeType: string)
	if (part != null && typeof part === 'object' && 'data' in part && 'mimeType' in part) {
		const dp = part as { data: Uint8Array; mimeType: string };
		if (!options?.allowMultimodal) return undefined;
		if (dp.mimeType.startsWith('image/')) {
			const b64 = Buffer.from(dp.data).toString('base64');
			return { type: 'image_url', image_url: { url: `data:${dp.mimeType};base64,${b64}` } };
		}
		return { type: 'text', text: new TextDecoder().decode(dp.data) };
	}

	// Duck-type LanguageModelPromptTsxPart (has value: unknown, constructor name check)
	if (part != null && typeof part === 'object' && 'value' in part &&
		(part.constructor?.name === 'LanguageModelPromptTsxPart')) {
		return { type: 'text', text: JSON.stringify((part as { value: unknown }).value) };
	}

	return undefined;
}

/**
 * Map VS Code LanguageModelChatToolMode to OpenAI tool_choice string.
 */
export function mapToolModeToToolChoice(
	toolMode: LanguageModelChatToolMode | undefined,
	hasTools: boolean
): 'none' | 'auto' | 'required' | undefined {
	if (!hasTools) return undefined;
	switch (toolMode) {
		case LanguageModelChatToolMode.Required:
			return 'required';
		default:
			return 'auto';
	}
}

/**
 * Convert VS Code messages to OpenAI format.
 * Extracts reasoning from LanguageModelThinkingPart in assistant messages (round-trip),
 * or from the ThinkingTokensTracker fallback when reasoningSource is 'tracker'.
 */
export function convertVSCodeMessagesToOpenAI(
	messages: readonly LanguageModelChatRequestMessage[],
	options?: {
		isNewUserMessage?: boolean;
		allowMultimodal?: boolean;
		reasoningSource?: ReasoningSource;
		getThinkingTokens?: (msg: LanguageModelChatRequestMessage) => string | undefined;
	}
): OpenAIChatMessage[] {
	const reasoningSource = options?.reasoningSource
		?? (options?.isNewUserMessage ? 'none' : 'roundtrip');
	const openAIMessages: OpenAIChatMessage[] = [];

	for (const msg of messages) {
		// Extract text content
		const textParts = msg.content
			.filter((part): part is LanguageModelTextPart => part instanceof LanguageModelTextPart)
			.map((part) => part.value)
			.join('');

		// Extract tool calls from assistant messages
		const toolCallParts = msg.content.filter(
			(part): part is LanguageModelToolCallPart => part instanceof LanguageModelToolCallPart
		);

		// Extract tool results from user messages
		const toolResultParts = msg.content.filter(
			(part): part is LanguageModelToolResultPart => part instanceof LanguageModelToolResultPart
		);

		// Convert role
		let role: 'system' | 'user' | 'assistant' | 'tool';
		if (msg.role === LanguageModelChatMessageRole.User) {
			role = 'user';
		} else if (msg.role === LanguageModelChatMessageRole.Assistant) {
			role = 'assistant';
		} else {
			role = 'system';
		}

		// Handle assistant messages with tool calls
		if (role === 'assistant' && toolCallParts.length > 0) {
			const toolCalls: OpenAIToolCall[] = toolCallParts.map((part) => ({
				id: part.callId,
				type: 'function' as const,
				function: {
					name: part.name,
					arguments: JSON.stringify(part.input),
				},
			}));

			const assistantMsg: OpenAIChatMessage = {
				role: 'assistant',
				content: textParts || null,
				tool_calls: toolCalls,
			};

			if (reasoningSource === 'roundtrip') {
				const reasoning = extractReasoningFromAssistantMessage(msg);
				if (reasoning) {
					assistantMsg.reasoning_content = reasoning;
				}
			} else if (reasoningSource === 'tracker' && options?.getThinkingTokens) {
				const reasoning = options.getThinkingTokens(msg);
				if (reasoning) {
					assistantMsg.reasoning_content = reasoning;
				}
			}

			openAIMessages.push(assistantMsg);
		}
		// Handle user messages with tool results
		else if (role === 'user' && toolResultParts.length > 0) {
			for (const toolResult of toolResultParts) {
				const toolContent = toolResult.content
					.filter((part): part is LanguageModelTextPart => part instanceof LanguageModelTextPart)
					.map((part) => part.value)
					.join('');

				openAIMessages.push({
					role: 'tool',
					content: toolContent,
					tool_call_id: toolResult.callId,
				});
			}

			if (textParts) {
				openAIMessages.push({
					role: 'user',
					content: textParts,
				});
			}
		}
		// Handle regular messages
		else {
			openAIMessages.push({
				role,
				content: textParts || null,
			});
		}
	}

	return openAIMessages;
}

/**
 * Convert OpenAI message format back to VS Code format
 * This is used for parsing responses, not for building requests
 */
export function convertOpenAIMessageToVSCode(
	message: OpenAIChatMessage
): {
	text: string;
	toolCalls: LanguageModelToolCallPart[];
	reasoningContent?: string;
} {
	let text: string;
	if (typeof message.content === 'string') {
		text = message.content;
	} else if (Array.isArray(message.content)) {
		text = message.content
			.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
			.map((p) => p.text)
			.join('');
	} else {
		text = '';
	}
	
	const toolCalls: LanguageModelToolCallPart[] = [];
	if (message.tool_calls) {
		for (const toolCall of message.tool_calls) {
			if (!toolCall.function || !toolCall.id) continue;
			const raw = toolCall.function.arguments ?? '';
			const argsStr = raw.trim() === '' ? '{}' : raw;
			try {
				const input = JSON.parse(argsStr);
				toolCalls.push(
					new LanguageModelToolCallPart(toolCall.id, toolCall.function.name, input)
				);
			} catch (e) {
				console.warn('Failed to parse tool call arguments:', toolCall.function.arguments);
				toolCalls.push(
					new LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {
						__error: `tool call parsing failed: ${e instanceof Error ? e.message : String(e)}`,
					})
				);
			}
		}
	}

	return {
		text,
		toolCalls,
		reasoningContent: message.reasoning_content,
	};
}

/**
 * Flush accumulated tool call deltas into LanguageModelToolCallPart array.
 * Sorts by index, treats missing/empty arguments as '{}', uses {} on parse failure.
 * Clears the map after building the list.
 */
function flushAccumulatedToolCalls(
	accumulators: Map<number, StreamToolCallDeltaAccumulator>
): LanguageModelToolCallPart[] {
	const result: LanguageModelToolCallPart[] = [];
	const sorted = [...accumulators.entries()].sort((a, b) => a[0] - b[0]);
	for (const [, acc] of sorted) {
		if (!acc.id || !acc.function?.name) continue;
		const argsRaw = acc.function.arguments ?? '';
		const argsStr = argsRaw.trim() === '' ? '{}' : argsRaw;
		let input: object;
		try {
			input = JSON.parse(argsStr);
		} catch (e) {
			console.warn('Failed to parse accumulated tool call:', acc);
			input = {};
		}
		result.push(new LanguageModelToolCallPart(acc.id, acc.function.name, input));
	}
	accumulators.clear();
	return result;
}

/**
 * Normalize usage from the best available source: the standard OpenAI usage object,
 * llama-server timings, or a fallback prompt token count from prepareCompletionRequest.
 * Returns undefined only when no usable data exists.
 */
export function normalizeStreamUsage(
	usage: OpenAIUsage | undefined,
	timings: LlamaServerTimings | undefined,
	fallbackPromptTokens?: number
): OpenAIUsage | undefined {
	if (usage) {
		const prompt = Math.max(0, usage.prompt_tokens);
		const completion = Math.max(0, usage.completion_tokens);
		return {
			prompt_tokens: prompt,
			completion_tokens: completion,
			total_tokens: Math.max(0, usage.total_tokens) || (prompt + completion),
			...(usage.prompt_tokens_details ? { prompt_tokens_details: usage.prompt_tokens_details } : {}),
		};
	}
	if (timings) {
		const prompt = Math.max(0, (timings.prompt_n ?? 0) + (timings.cache_n ?? 0));
		const completion = Math.max(0, timings.predicted_n ?? 0);
		if (prompt > 0 || completion > 0) {
			return {
				prompt_tokens: prompt,
				completion_tokens: completion,
				total_tokens: prompt + completion,
			};
		}
	}
	if (fallbackPromptTokens !== undefined && fallbackPromptTokens > 0) {
		return {
			prompt_tokens: fallbackPromptTokens,
			completion_tokens: 0,
			total_tokens: fallbackPromptTokens,
		};
	}
	return undefined;
}

/**
 * Stream chat completion from OpenAI-compatible /v1/chat/completions endpoint
 * Returns an async generator that yields response parts (text, tool calls, thinking tokens)
 */
export async function* streamChatCompletion(
	serverUrl: string,
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[],
	options: {
		tools?: readonly LanguageModelChatTool[];
		max_tokens?: number;
		toolMode?: LanguageModelChatToolMode;
		modelOptions?: Record<string, unknown>;
		isNewUserMessage?: boolean;
		preparedRequest?: PreparedCompletionRequest;
		thinkingBudgetFraction?: number;
	},
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number,
	signal?: AbortSignal
): AsyncGenerator<
	| { type: 'text'; content: string }
	| { type: 'toolCall'; toolCall: LanguageModelToolCallPart }
	| { type: 'thinking'; content: string }
	| { type: 'prompt_progress'; total: number; cache: number; processed: number; time_ms: number }
	| { type: 'usage'; usage: OpenAIUsage },
	void,
	unknown
> {
	const url = `${serverUrl}/v1/chat/completions`;

	// Use prepared request when provided; otherwise convert messages and use options.max_tokens
	const openAIMessages = options.preparedRequest?.openAIMessages ?? convertVSCodeMessagesToOpenAI(
		messages,
		{ isNewUserMessage: options.isNewUserMessage ?? false }
	);
	const max_tokens = options.preparedRequest?.max_tokens ?? options.max_tokens;

	// Convert tools to OpenAI format
	const openAITools = convertVSCodeToolsToOpenAI(options.tools);

	const requestBody: {
		model: string;
		messages: OpenAIChatMessage[];
		tools?: OpenAITool[];
		tool_choice?: 'none' | 'auto' | 'required';
		stream: boolean;
		max_tokens?: number;
		reasoning_format?: 'deepseek';
		parse_tool_calls?: boolean;
		parallel_tool_calls?: boolean;
		[key: string]: unknown;
	} = {
		model: modelId,
		messages: openAIMessages,
		stream: true,
		max_tokens,
		reasoning_format: 'deepseek',
		parse_tool_calls: true,
		parallel_tool_calls: true,
		cache_prompt: true,
		return_progress: true,
		stream_options: { include_usage: true },
	};

	if (openAITools && openAITools.length > 0) {
		requestBody.tools = openAITools;
		requestBody.tool_choice = mapToolModeToToolChoice(options.toolMode, true) ?? 'auto';
	}

	// Merge modelOptions from the provider into the request body
	if (options.modelOptions) {
		Object.assign(requestBody, options.modelOptions);
	}

	// Merge endpoint requestBody properties (endpoint config can override defaults)
	if (endpointRequestBody) {
		Object.assign(requestBody, endpointRequestBody);
	}

	// Auto-set thinking_budget_tokens unless the user already specified one explicitly
	if (
		options.thinkingBudgetFraction !== undefined &&
		requestBody.thinking_budget_tokens === undefined
	) {
		const effectiveMaxTokens = requestBody.max_tokens;
		if (typeof effectiveMaxTokens === 'number') {
			const budget = computeThinkingBudgetTokens(effectiveMaxTokens, options.thinkingBudgetFraction);
			if (budget !== undefined) {
				requestBody.thinking_budget_tokens = budget;
			}
		}
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (apiToken) {
		headers['Authorization'] = `Bearer ${apiToken}`;
	}
	// Merge endpoint headers (endpoint headers take precedence)
	if (endpointHeaders) {
		Object.assign(headers, endpointHeaders);
	}

	const timeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const dispatcher = getDispatcher(timeoutMs);

	try {
		const reader = await withConnectionResetRetry(async () => {
			logStreamStart('POST', url, requestBody);
			const response = await fetchWithRateLimitRetry(
				() => fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
					dispatcher,
					signal,
				}),
				{ signal }
			);

			if (!response.ok) {
				const errorText = await response.text().catch(() => 'Unknown error');
				logError(`Failed to stream chat completion: ${response.statusText}`, 'streamChatCompletion');
				if (response.status >= 500 && errorText.includes('Internal Server Error - proxy error')) {
					const probe = await getSuggestedTimeoutFromModels(serverUrl, apiToken, endpointHeaders);
					let message: string;
					if (probe) {
						if (probe.serverHasTimeout) {
							message = `Llama-server reported an internal timeout. Increase the extension Request timeout (Settings → Llama Copilot) to at least ${probe.suggestedSeconds} seconds. If the server still times out, increase llama-server's --timeout (currently ${probe.currentSeconds}) to at least ${probe.suggestedSeconds} (e.g. \`--timeout ${probe.suggestedSeconds}\`).`;
						} else {
							message = `Llama-server reported an internal timeout. Increase the extension Request timeout (Settings → Llama Copilot) to at least ${probe.suggestedSeconds} seconds. If the server still times out, add \`--timeout ${probe.suggestedSeconds}\` to your llama-server command.`;
						}
					} else {
						const fallbackSeconds = Math.max(3600, Math.floor(timeoutMs / 1000) * 2);
						message = `Llama-server reported an internal timeout. Increase the extension Request timeout (Settings → Llama Copilot) to at least ${fallbackSeconds} seconds. If the server still times out, add \`--timeout ${fallbackSeconds}\` (or higher) to your llama-server command.`;
					}
					throw new Error(message);
				}
				const parsed = parseServerError(errorText);
				const formatted = formatServerErrorMessage(parsed, response.status, errorText);
				throw new Error(formatted);
			}

			logStreamResponse(response.status, response.statusText);

			if (!response.body) {
				logError('Response body is null', 'streamChatCompletion');
				throw new Error('Response body is null');
			}

			return response.body.getReader();
		}, { signal });

		const decoder = new TextDecoder();
		let buffer = '';
		
		// Accumulators for tool calls (they may be split across chunks)
		const toolCallAccumulators = new Map<number, StreamToolCallDeltaAccumulator>();

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE format: lines starting with "data: "
				const lines = buffer.split('\n');
				buffer = lines.pop() || ''; // Keep incomplete line in buffer

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const dataStr = line.slice(6); // Remove "data: " prefix

						if (dataStr.trim() === '' || dataStr.trim() === '[DONE]') {
							continue;
						}

						try {
							const chunk = JSON.parse(dataStr) as OpenAIChatCompletionChunkWithProgress;

							// Yield prompt progress first if present (llama-server extension)
							if (chunk.prompt_progress) {
								const { total, cache, processed, time_ms } = chunk.prompt_progress;
								yield { type: 'prompt_progress', total, cache, processed, time_ms };
							}

							// Yield usage from the final stream chunk (sent when stream_options.include_usage is true).
							// llama-server sends this on a chunk with empty choices, so it must be checked before the guard below.
							// Also handle timings as a fallback source for usage.
							if (chunk.usage) {
								yield { type: 'usage', usage: chunk.usage };
							} else if (chunk.timings && (!chunk.choices || chunk.choices.length === 0)) {
								const usage = normalizeStreamUsage(undefined, chunk.timings);
								if (usage) {
									yield { type: 'usage', usage };
								}
							}

							if (!chunk.choices || chunk.choices.length === 0) {
								continue;
							}

							const choice = chunk.choices[0];
							const delta = choice.delta;

							if (!delta) {
								continue;
							}

							// Handle text content
							if (delta.content) {
								yield { type: 'text', content: delta.content };
							}

							// Handle thinking tokens (reasoning content)
							if (delta.reasoning_content) {
								yield { type: 'thinking', content: delta.reasoning_content };
							}

							// Handle tool calls (may be split across chunks)
							if (delta.tool_calls) {
								delta.tool_calls.forEach((toolCallDelta, arrayIndex) => {
									const index =
										toolCallDelta.index !== undefined && Number.isInteger(toolCallDelta.index)
											? toolCallDelta.index
											: arrayIndex;
									if (!toolCallAccumulators.has(index)) {
										toolCallAccumulators.set(index, {});
									}

									const accumulator = toolCallAccumulators.get(index)!;

									if (toolCallDelta.id !== undefined) {
										accumulator.id = toolCallDelta.id;
									}
									if (toolCallDelta.type !== undefined) {
										accumulator.type = toolCallDelta.type;
									}
									if (toolCallDelta.function) {
										if (!accumulator.function) {
											accumulator.function = {};
										}
										if (toolCallDelta.function.name !== undefined) {
											accumulator.function.name = toolCallDelta.function.name;
										}
										if (toolCallDelta.function.arguments !== undefined) {
											accumulator.function.arguments =
												(accumulator.function.arguments || '') + toolCallDelta.function.arguments;
										}
									}
								});
							}

							// Emit tool calls to the host only once the message is complete (or stream ended).
							// Matches Copilot: completed tool calls are sent only when finish_reason is set or on flush.
							const shouldFlushToolCalls =
								choice.finish_reason === 'tool_calls' ||
								choice.finish_reason === 'stop' ||
								choice.finish_reason === 'length';
							if (shouldFlushToolCalls && toolCallAccumulators.size > 0) {
								for (const toolCall of flushAccumulatedToolCalls(toolCallAccumulators)) {
									yield { type: 'toolCall', toolCall };
								}
								if (choice.finish_reason === 'stop') {
									return;
								}
							}
						} catch (e) {
							// Ignore JSON parse errors for malformed chunks
							console.warn('Failed to parse SSE chunk:', dataStr);
						}
					}
				}
			}

			// If stream ended without a finish_reason chunk, flush any accumulated tool calls so they are not lost.
			if (toolCallAccumulators.size > 0) {
				console.warn(
					'streamChatCompletion: stream ended without finish_reason; flushing accumulated tool calls'
				);
				for (const toolCall of flushAccumulatedToolCalls(toolCallAccumulators)) {
					yield { type: 'toolCall', toolCall };
				}
			}
		} finally {
			reader.releaseLock();
		}
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw error;
		}
		handleApiError(
			error,
			'streamChatCompletion',
			['Failed to stream chat completion', 'Response body is null', 'Rate limit exceeded', 'Llama-server reported an internal timeout'],
			url
		);
	}
}

/**
 * Apply chat template to messages (POST /apply-template).
 * Returns the templated prompt string. Model in body for router mode.
 */
export async function applyTemplate(
	serverUrl: string,
	modelId: string,
	openAIMessages: OpenAIChatMessage[],
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number,
	signal?: AbortSignal
): Promise<string> {
	const url = `${serverUrl}/apply-template`;
	const timeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const dispatcher = getDispatcher(timeoutMs);

	const requestBody: Record<string, unknown> = {
		model: modelId,
		messages: openAIMessages,
		...(endpointRequestBody || {}),
	};

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (apiToken) {
		headers['Authorization'] = `Bearer ${apiToken}`;
	}
	if (endpointHeaders) {
		Object.assign(headers, endpointHeaders);
	}

	try {
		return await withConnectionResetRetry(async () => {
			const response = await fetchWithRateLimitRetry(
				() => fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
					dispatcher,
					signal,
				}),
				{ signal }
			);
			await throwIfNotOk(response, 'applyTemplate');

			const data = (await response.json()) as ApplyTemplateResponse;
			return typeof data.prompt === 'string' ? data.prompt : '';
		}, { signal });
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw error;
		}
		handleApiError(error, 'applyTemplate', ['Failed in applyTemplate', 'Rate limit exceeded'], url);
	}
}

const TOKEN_COUNT_CACHE_MAX = 3000;
const tokenCountCache = new Map<string, number>();

function canonicalStringify(obj: Record<string, unknown>): string {
	const keys = Object.keys(obj).sort();
	const sorted: Record<string, unknown> = {};
	for (const k of keys) {
		sorted[k] = obj[k];
	}
	return JSON.stringify(sorted);
}

function getTokenCountCacheKey(
	serverUrl: string,
	modelId: string,
	content: string,
	endpointRequestBody?: Record<string, unknown>
): string {
	const bodyOptions: Record<string, unknown> = {
		model: modelId,
		add_special: false,
		parse_special: true,
		with_pieces: false,
		...(endpointRequestBody || {}),
	};
	const canonical = canonicalStringify(bodyOptions);
	return crypto.createHash('sha256').update(serverUrl + modelId + content + canonical).digest('hex');
}

/**
 * Token count with LRU cache (max 3000 entries, keyed by hash of serverUrl, model, content, and body options).
 * Raw tokenize() remains uncached.
 */
export async function getTokenCount(
	serverUrl: string,
	modelId: string,
	content: string,
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number
): Promise<number> {
	const key = getTokenCountCacheKey(serverUrl, modelId, content, endpointRequestBody);
	const cached = tokenCountCache.get(key);
	if (cached !== undefined) {
		tokenCountCache.delete(key);
		tokenCountCache.set(key, cached);
		return cached;
	}
	const count = await tokenize(
		serverUrl,
		modelId,
		content,
		apiToken,
		endpointHeaders,
		endpointRequestBody,
		requestTimeoutMs
	);
	if (tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX) {
		const firstKey = tokenCountCache.keys().next().value;
		if (firstKey !== undefined) {
			tokenCountCache.delete(firstKey);
		}
	}
	tokenCountCache.set(key, count);
	return count;
}

/**
 * Tokenize text to count tokens
 */
export async function tokenize(
	serverUrl: string,
	modelId: string,
	content: string,
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number
): Promise<number> {
	// llama.cpp POST /tokenize: no query params; options in body only (content, add_special, parse_special, with_pieces).
	// Model in body for router/multi-model mode; single-model servers ignore it.
	const url = `${serverUrl}/tokenize`;
	const timeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const dispatcher = getDispatcher(timeoutMs);

	const requestBody: TokenizeRequest = {
		content,
		model: modelId,
		add_special: false,
		parse_special: true,
		with_pieces: false,
		// Merge endpoint requestBody properties
		...(endpointRequestBody || {}),
	};

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (apiToken) {
		headers['Authorization'] = `Bearer ${apiToken}`;
	}
	// Merge endpoint headers (endpoint headers take precedence)
	if (endpointHeaders) {
		Object.assign(headers, endpointHeaders);
	}

	try {
		return await withConnectionResetRetry(async () => {
			logTokenizeRequest(url, headers, requestBody);
			const response = await fetchWithRateLimitRetry(
				() => fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
					dispatcher,
				})
			);
			await throwIfNotOk(response, 'tokenize');

			const result = (await response.json()) as TokenizeResponse;
			const tokenCount = Array.isArray(result.tokens) ? result.tokens.length : 0;
			logTokenizeResponse(response.status, response.statusText, tokenCount);

			return tokenCount;
		});
	} catch (error) {
		handleApiError(error, 'tokenize', ['Failed in tokenize', 'Rate limit exceeded'], url);
	}
}

/**
 * Get token count of the templated prompt for the given OpenAI-format messages.
 * Uses apply-template then tokenize (not getTokenCount) to avoid cache side effects during trim loop.
 */
export async function getTemplatedPromptTokenCount(
	serverUrl: string,
	modelId: string,
	openAIMessages: OpenAIChatMessage[],
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number,
	signal?: AbortSignal
): Promise<number> {
	const prompt = await applyTemplate(
		serverUrl,
		modelId,
		openAIMessages,
		apiToken,
		endpointHeaders,
		endpointRequestBody,
		requestTimeoutMs,
		signal
	);
	return tokenize(
		serverUrl,
		modelId,
		prompt,
		apiToken,
		endpointHeaders,
		endpointRequestBody,
		requestTimeoutMs
	);
}

/**
 * Prepare completion request: ensure templated prompt fits within
 * maxInputTokens + 0.2 * maxOutputTokens by dropping oldest thinking blocks,
 * then compute max_tokens = min(maxOutputTokens, maxInputTokens + maxOutputTokens - requestTokenCount).
 */
export async function prepareCompletionRequest(
	serverUrl: string,
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[],
	options: {
		isNewUserMessage?: boolean;
		reasoningSource?: ReasoningSource;
		getThinkingTokens?: (msg: LanguageModelChatRequestMessage) => string | undefined;
	},
	modelLimits: { maxInputTokens: number; maxOutputTokens: number },
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number,
	signal?: AbortSignal
): Promise<PreparedCompletionRequest> {
	const openAIMessages = convertVSCodeMessagesToOpenAI(
		messages,
		{
			isNewUserMessage: options.isNewUserMessage ?? false,
			reasoningSource: options.reasoningSource,
			getThinkingTokens: options.getThinkingTokens,
		}
	);

	const limit = modelLimits.maxInputTokens + modelLimits.maxOutputTokens * 0.2;

	// Trim oldest reasoning_content until templated count <= limit
	let requestTokenCount: number;
	for (;;) {
		requestTokenCount = await getTemplatedPromptTokenCount(
			serverUrl,
			modelId,
			openAIMessages,
			apiToken,
			endpointHeaders,
			endpointRequestBody,
			requestTimeoutMs,
			signal
		);
		if (requestTokenCount <= limit) {
			break;
		}
		const idx = openAIMessages.findIndex(
			(m) => m.role === 'assistant' && m.reasoning_content !== undefined && m.reasoning_content !== ''
		);
		if (idx === -1) {
			break;
		}
		delete (openAIMessages[idx] as OpenAIChatMessage & { reasoning_content?: string }).reasoning_content;
	}

	const max_tokens = Math.max(
		0,
		Math.min(
			modelLimits.maxOutputTokens,
			modelLimits.maxInputTokens + modelLimits.maxOutputTokens - requestTokenCount
		)
	);

	return {
		openAIMessages,
		requestTokenCount,
		max_tokens,
	};
}

/** Fixed n_predict for inline completion (FIM) requests */
const INFILL_N_PREDICT = 128;

/**
 * Non-streaming infill request (POST /infill).
 * Returns the generated content string. Throws on error, timeout, or abort.
 * Caller must pass an AbortSignal tied to cancellation token and timeout.
 */
export async function requestInfill(
	serverUrl: string,
	modelId: string,
	body: {
		input_prefix: string;
		input_suffix: string;
		input_extra?: Array<{ text: string; filename: string }>;
		prompt?: string;
	},
	timeoutMs: number,
	signal: AbortSignal,
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>
): Promise<string> {
	const url = `${serverUrl}/infill`;

	const requestBody: InfillRequest = {
		input_prefix: body.input_prefix,
		input_suffix: body.input_suffix,
		stream: false,
		n_predict: INFILL_N_PREDICT,
		model: modelId,
	};
	if (body.input_extra && body.input_extra.length > 0) {
		requestBody.input_extra = body.input_extra;
	}
	const infillPrompt = body.prompt?.trim();
	if (infillPrompt) {
		requestBody.prompt = infillPrompt;
	}
	if (endpointRequestBody) {
		Object.assign(requestBody, endpointRequestBody);
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (apiToken) {
		headers['Authorization'] = `Bearer ${apiToken}`;
	}
	if (endpointHeaders) {
		Object.assign(headers, endpointHeaders);
	}

	const dispatcher = getDispatcher(timeoutMs);

	try {
		return await withConnectionResetRetry(async () => {
			const response = await fetchWithRateLimitRetry(
				() => fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
					dispatcher,
					signal,
				}),
				{ signal }
			);
			await throwIfNotOk(response, 'requestInfill');

			const data = (await response.json()) as InfillResponse;
			return typeof data.content === 'string' ? data.content : '';
		}, { signal });
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw error;
		}
		handleApiError(error, 'requestInfill', ['Failed in requestInfill', 'Rate limit exceeded'], url);
	}
}
