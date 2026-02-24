import { LanguageModelChatMessage, LanguageModelChatCapabilities } from 'vscode';

/**
 * Model-specific configuration
 */
export interface ModelConfig {
	headers?: Record<string, string>;
	requestBody?: Record<string, unknown>;
	contextSize?: number;
	maxOutputTokens?: number;
	capabilities?: LanguageModelChatCapabilities;
}

/**
 * Endpoint configuration
 */
export interface EndpointConfig {
	url: string;
	apiToken?: string;
	headers?: Record<string, string>;
	requestBody?: Record<string, unknown>;
	models?: Record<string, ModelConfig>;
}

/**
 * Endpoints configuration mapping identifier to endpoint config
 */
export type EndpointsConfig = Record<string, EndpointConfig>;

/**
 * Response from GET /models endpoint
 */
export interface ModelsResponse {
	data: Model[];
	object: 'list';
}

/**
 * Model information from /models endpoint
 */
export interface Model {
	id: string;
	object: 'model';
	owned_by: string;
	created: number;
	status: ModelStatus;
}

/**
 * Model status with args array for detecting flags
 */
export interface ModelStatus {
	value: 'unloaded' | 'loading' | 'loaded';
	args?: string[];
	preset?: string;
	failed?: boolean;
	exit_code?: number;
}

/**
 * Request body for POST /tokenize
 * See llama.cpp server README: content (required), add_special, parse_special, with_pieces.
 * Optional model field is used for routing when the server runs in multi-model (router) mode.
 */
export interface TokenizeRequest {
	content: string;
	model?: string;
	add_special?: boolean;
	parse_special?: boolean;
	with_pieces?: boolean;
}

/**
 * Response from POST /tokenize
 */
export interface TokenizeResponse {
	tokens: number[] | Array<{ id: number; piece: string | number[] }>;
}

/**
 * OpenAI-compatible API types for /v1/chat/completions
 */

/**
 * Tool call structure in OpenAI format
 */
export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON string
	};
}

/**
 * Tool definition in OpenAI format
 */
export interface OpenAITool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters: {
			type: string;
			properties?: Record<string, unknown>;
			required?: string[];
		};
	};
}

/**
 * Chat message in OpenAI format
 */
export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string; // For tool role messages
	reasoning_content?: string; // For thinking tokens (llama-server extension)
}

/**
 * Request body for POST /v1/chat/completions
 */
export interface OpenAIChatCompletionRequest {
	model: string;
	messages: OpenAIChatMessage[];
	tools?: OpenAITool[];
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	max_tokens?: number;
	stop?: string[] | string;
	seed?: number;
	reasoning_format?: 'none' | 'deepseek' | 'deepseek-legacy';
	thinking_forced_open?: boolean;
	parse_tool_calls?: boolean;
	parallel_tool_calls?: boolean;
}

/**
 * Choice delta for streaming responses
 */
export interface OpenAIChatCompletionDelta {
	role?: 'assistant';
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: 'function';
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
	reasoning_content?: string;
}

/**
 * Choice in chat completion response (streaming or non-streaming)
 */
export interface OpenAIChatCompletionChoice {
	index: number;
	delta?: OpenAIChatCompletionDelta;
	message?: OpenAIChatMessage;
	finish_reason?: 'stop' | 'length' | 'tool_calls' | null;
}

/**
 * Accumulator for tool call deltas that may be split across streaming chunks
 */
export interface StreamToolCallDeltaAccumulator {
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

/**
 * Streaming response chunk from POST /v1/chat/completions
 */
export interface OpenAIChatCompletionChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: OpenAIChatCompletionChoice[];
}

/**
 * Non-streaming response from POST /v1/chat/completions
 */
export interface OpenAIChatCompletionResponse {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: OpenAIChatMessage;
		finish_reason: 'stop' | 'length' | 'tool_calls' | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

/**
 * Extra context item for POST /infill (other files, not the current document).
 */
export interface InfillInputExtra {
	text: string;
	filename: string;
}

/**
 * Request body for POST /infill (non-streaming)
 * See dev-docs/infill.md
 */
export interface InfillRequest {
	input_prefix: string;
	input_suffix: string;
	input_extra?: InfillInputExtra[];
	stream?: boolean;
	n_predict?: number;
	model?: string;
	prompt?: string;
	temperature?: number;
	[key: string]: unknown;
}

/**
 * Non-streaming response from POST /infill
 */
export interface InfillResponse {
	content: string;
	stop?: boolean;
	generation_settings?: unknown;
	model?: string;
	tokens_evaluated?: number;
	prompt?: string;
	truncated?: boolean;
}
