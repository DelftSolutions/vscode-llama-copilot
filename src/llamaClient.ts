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
	TokenizeRequest,
	TokenizeResponse,
	OpenAIChatMessage,
	OpenAITool,
	OpenAIToolCall,
} from './types';
import { logRequest, logResponse, logError, logStreamStart, logStreamResponse, logTokenizeRequest, logTokenizeResponse } from './logger';

/**
 * Fetch available models from llama-server
 */
export async function fetchModels(
	serverUrl: string,
	apiToken?: string,
	endpointHeaders?: Record<string, string>
): Promise<ModelsResponse> {
	const url = `${serverUrl}/models`;
	
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
		const response = await fetch(url, { headers });

		if (!response.ok) {
			logError(`Failed to fetch models: ${response.statusText}`, 'fetchModels');
			throw new Error(`Failed to fetch models: ${response.statusText}`);
		}

		const data = await response.json() as ModelsResponse;
		logResponse(response.status, response.statusText, data);
		return data;
	} catch (error) {
		if (error instanceof Error && error.message.includes('Failed to fetch models')) {
			throw error;
		}
		logError(error instanceof Error ? error : String(error), 'fetchModels');
		throw error;
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
	endpointRequestBody?: Record<string, unknown>
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

	try {
		logStreamStart('POST', url, requestBody);
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			logError(`Failed to stream chat completion: ${response.statusText}`, 'streamChatCompletion');
			throw new Error(`Failed to stream chat completion: ${response.statusText} - ${errorText}`);
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
		const toolCallAccumulators = new Map<number, {
			id?: string;
			type?: string;
			function?: {
				name?: string;
				arguments?: string;
			};
		}>();

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
							const chunk = JSON.parse(dataStr) as {
								id?: string;
								object?: string;
								created?: number;
								model?: string;
								choices?: Array<{
									index: number;
									delta?: {
										role?: string;
										content?: string | null;
										tool_calls?: Array<{
											index: number;
											id?: string;
											type?: string;
											function?: {
												name?: string;
												arguments?: string;
											};
										}>;
										reasoning_content?: string;
									};
									finish_reason?: string | null;
								}>;
							};

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
		if (error instanceof Error && (
			error.message.includes('Failed to stream chat completion') ||
			error.message.includes('Response body is null')
		)) {
			throw error;
		}
		logError(error instanceof Error ? error : String(error), 'streamChatCompletion');
		throw error;
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
	endpointRequestBody?: Record<string, unknown>
): Promise<number> {
	const url = `${serverUrl}/tokenize?model=${encodeURIComponent(modelId)}`;

	const requestBody: TokenizeRequest = {
		content,
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
		});

		if (!response.ok) {
			logError(`Failed to tokenize: ${response.statusText}`, 'tokenize');
			throw new Error(`Failed to tokenize: ${response.statusText}`);
		}

		const result = (await response.json()) as TokenizeResponse;
		const tokenCount = Array.isArray(result.tokens) ? result.tokens.length : 0;
		logTokenizeResponse(response.status, response.statusText, tokenCount);

		return tokenCount;
	} catch (error) {
		if (error instanceof Error && error.message.includes('Failed to tokenize')) {
			throw error;
		}
		logError(error instanceof Error ? error : String(error), 'tokenize');
		throw error;
	}
}
