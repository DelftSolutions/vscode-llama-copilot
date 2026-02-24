import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelChatTool,
} from 'vscode';
import {
	ModelsResponse,
	Model,
	TokenizeRequest,
	TokenizeResponse,
	OpenAIChatMessage,
	OpenAITool,
	OpenAIToolCall,
	OpenAIChatCompletionChunk,
	StreamToolCallDeltaAccumulator,
	InfillRequest,
	InfillResponse,
} from './types';
import { fetch, Agent } from 'undici';
import { logRequest, logResponse, logError, logStreamStart, logStreamResponse, logTokenizeRequest, logTokenizeResponse } from './logger';

import { normalizeFetchError } from './errorUtils';
import { parseServerError, formatServerErrorMessage } from './serverErrorUtils';

const DEFAULT_REQUEST_TIMEOUT_MS = 1200 * 1000;

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
	logError(error instanceof Error ? error : String(error), context);
	const normalized = normalizeFetchError(error, url);
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
		logRequest('GET', url, headers);
		const response = await fetch(url, { headers, dispatcher });

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			logError(`Failed to fetch models: ${response.statusText}`, 'fetchModels');
			const parsed = parseServerError(errorText);
			const formatted = formatServerErrorMessage(parsed, response.status, errorText || response.statusText);
			throw new Error(formatted);
		}

		const data = await response.json() as ModelsResponse;
		logResponse(response.status, response.statusText, data);
		return data;
	} catch (error) {
		handleApiError(error, 'fetchModels', 'Failed to fetch models', url);
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
 * Convert VS Code messages to OpenAI format
 * Handles thinking tokens: includes them only for tool-call-related assistant messages
 * Removes thinking tokens when user sends a new message (by not including reasoning_content)
 * 
 * @param messages VS Code messages to convert
 * @param getThinkingTokens Optional function to retrieve thinking tokens for a message
 * @param isNewUserMessage Whether the last message is a new user message (not a tool result)
 */
export function convertVSCodeMessagesToOpenAI(
	messages: LanguageModelChatMessage[],
	getThinkingTokens?: (msg: LanguageModelChatMessage) => string | undefined,
	isNewUserMessage: boolean = false
): OpenAIChatMessage[] {
	const openAIMessages: OpenAIChatMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg instanceof Error) {
			throw new Error('Invalid message format');
		}

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
			// System role or other - map to system
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

			// Include thinking tokens for tool-call messages if:
			// 1. We have a function to get thinking tokens
			// 2. This is NOT a new user message (if new user message, exclude thinking tokens)
			// 3. We have thinking tokens available for this message
			if (getThinkingTokens && !isNewUserMessage) {
				const thinkingTokens = getThinkingTokens(msg);
				if (thinkingTokens) {
					assistantMsg.reasoning_content = thinkingTokens;
				}
			}

			openAIMessages.push(assistantMsg);
		}
		// Handle user messages with tool results
		else if (role === 'user' && toolResultParts.length > 0) {
			// Create tool role messages for each tool result
			for (const toolResult of toolResultParts) {
				const toolCallId = toolResult.callId;
				const toolContent = toolResult.content
					.filter((part): part is LanguageModelTextPart => part instanceof LanguageModelTextPart)
					.map((part) => part.value)
					.join('');

				openAIMessages.push({
					role: 'tool',
					content: toolContent,
					tool_call_id: toolCallId,
				});
			}

			// If there's also text content, add it as a user message
			if (textParts) {
				openAIMessages.push({
					role: 'user',
					content: textParts,
				});
			}
		}
		// Handle regular messages
		else {
			const openAIMsg: OpenAIChatMessage = {
				role,
				content: textParts || null,
			};

			// For assistant messages without tool calls, we don't include thinking tokens
			// (thinking tokens are only for tool-call messages)

			openAIMessages.push(openAIMsg);
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
	const text = typeof message.content === 'string' ? message.content : message.content || '';
	
	const toolCalls: LanguageModelToolCallPart[] = [];
	if (message.tool_calls) {
		for (const toolCall of message.tool_calls) {
			try {
				const input = JSON.parse(toolCall.function.arguments);
				toolCalls.push(
					new LanguageModelToolCallPart(toolCall.id, toolCall.function.name, input)
				);
			} catch (e) {
				console.warn('Failed to parse tool call arguments:', toolCall.function.arguments);
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
 * Stream chat completion from OpenAI-compatible /v1/chat/completions endpoint
 * Returns an async generator that yields response parts (text, tool calls, thinking tokens)
 */
export async function* streamChatCompletion(
	serverUrl: string,
	modelId: string,
	messages: LanguageModelChatMessage[],
	options: {
		tools?: readonly LanguageModelChatTool[];
		max_tokens?: number;
		getThinkingTokens?: (msg: LanguageModelChatMessage) => string | undefined;
		isNewUserMessage?: boolean;
	},
	apiToken?: string,
	endpointHeaders?: Record<string, string>,
	endpointRequestBody?: Record<string, unknown>,
	requestTimeoutMs?: number
): AsyncGenerator<
	| { type: 'text'; content: string }
	| { type: 'toolCall'; toolCall: LanguageModelToolCallPart }
	| { type: 'thinking'; content: string },
	void,
	unknown
> {
	const url = `${serverUrl}/v1/chat/completions`;

	// Convert messages to OpenAI format
	const openAIMessages = convertVSCodeMessagesToOpenAI(
		messages,
		options.getThinkingTokens,
		options.isNewUserMessage ?? false
	);

	// Convert tools to OpenAI format
	const openAITools = convertVSCodeToolsToOpenAI(options.tools);

	const requestBody: {
		model: string;
		messages: OpenAIChatMessage[];
		tools?: OpenAITool[];
		tool_choice?: 'auto' | 'none';
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
		max_tokens: options.max_tokens,
		reasoning_format: 'deepseek', // Enable thinking token extraction
		parse_tool_calls: true, // Enable tool call parsing
		parallel_tool_calls: true, // Enable parallel tool calls
		cache_prompt: true, // Enable prompt caching
	};

	if (openAITools && openAITools.length > 0) {
		requestBody.tools = openAITools;
		requestBody.tool_choice = 'auto';
	}

	// Merge endpoint requestBody properties (endpoint config can override defaults)
	if (endpointRequestBody) {
		Object.assign(requestBody, endpointRequestBody);
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
		logStreamStart('POST', url, requestBody);
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(requestBody),
			dispatcher,
		});

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

		const reader = response.body.getReader();
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
							const chunk = JSON.parse(dataStr) as OpenAIChatCompletionChunk;

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
								for (const toolCallDelta of delta.tool_calls) {
									const index = toolCallDelta.index;
									
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
								}
							}

							// If finished, emit any remaining tool calls
							if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
								for (const [index, accumulator] of toolCallAccumulators.entries()) {
									if (accumulator.id && accumulator.function?.name && accumulator.function.arguments) {
										try {
											const input = JSON.parse(accumulator.function.arguments);
											const toolCall = new LanguageModelToolCallPart(
												accumulator.id,
												accumulator.function.name,
												input
											);
											yield { type: 'toolCall', toolCall };
										} catch (e) {
											console.warn('Failed to parse accumulated tool call:', accumulator);
										}
									}
								}
								toolCallAccumulators.clear();
								
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
		} finally {
			reader.releaseLock();
		}
	} catch (error) {
		handleApiError(
			error,
			'streamChatCompletion',
			['Failed to stream chat completion', 'Response body is null'],
			url
		);
	}
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
		logTokenizeRequest(url, headers, requestBody);
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(requestBody),
			dispatcher,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			logError(`Failed to tokenize: ${response.statusText}`, 'tokenize');
			const parsed = parseServerError(errorText);
			const formatted = formatServerErrorMessage(parsed, response.status, errorText || response.statusText);
			throw new Error(formatted);
		}

		const result = (await response.json()) as TokenizeResponse;
		const tokenCount = Array.isArray(result.tokens) ? result.tokens.length : 0;
		logTokenizeResponse(response.status, response.statusText, tokenCount);

		return tokenCount;
	} catch (error) {
		handleApiError(error, 'tokenize', 'Failed to tokenize', url);
	}
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
	body: { input_prefix: string; input_suffix: string; input_extra?: Array<{ text: string; filename: string }> },
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
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(requestBody),
			dispatcher,
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			logError(`Failed to infill: ${response.statusText}`, 'requestInfill');
			const parsed = parseServerError(errorText);
			const formatted = formatServerErrorMessage(parsed, response.status, errorText || response.statusText);
			throw new Error(formatted);
		}

		const data = (await response.json()) as InfillResponse;
		return typeof data.content === 'string' ? data.content : '';
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw error;
		}
		handleApiError(error, 'requestInfill', ['Failed to infill'], url);
	}
}
