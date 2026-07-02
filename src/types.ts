import { LanguageModelChatMessage, LanguageModelChatCapabilities } from 'vscode';

/**
 * Model-specific configuration
 */
export interface ModelConfig {
	headers?: Record<string, string>;
	requestBody?: Record<string, unknown>;
	contextSize?: number;
	maxOutputTokens?: number;
	thinkingBudgetFraction?: number;
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
	thinkingBudgetFraction?: number;
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
 * Model metadata returned by single-model llama-server (no router/presets).
 */
export interface ModelMeta {
	n_ctx?: number;
	n_ctx_train?: number;
	n_embd?: number;
	n_params?: number;
	n_vocab?: number;
	vocab_type?: number;
	size?: number;
}

/**
 * Model information from /models endpoint.
 * In multi-model (router) mode, `status` is present with args/value.
 * In single-model mode, `status` is absent and `meta` provides context info.
 */
export interface Model {
	id: string;
	object: 'model';
	owned_by: string;
	created: number;
	status?: ModelStatus;
	meta?: ModelMeta;
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
 * Response from POST /apply-template (llama-server)
 */
export interface ApplyTemplateResponse {
	prompt: string;
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
 * Content part for multimodal OpenAI messages.
 */
export type OpenAIContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

/**
 * Chat message in OpenAI format
 */
export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null | OpenAIContentPart[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

/**
 * Result of prepareCompletionRequest: trimmed messages and computed max_tokens for /v1/chat/completions
 */
export interface PreparedCompletionRequest {
	openAIMessages: OpenAIChatMessage[];
	requestTokenCount: number;
	max_tokens: number;
}

/**
 * Request body for POST /v1/chat/completions
 */
export interface OpenAIChatCompletionRequest {
	model: string;
	messages: OpenAIChatMessage[];
	tools?: OpenAITool[];
	tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
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
	thinking_budget_tokens?: number;
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
		index?: number;
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
 * Prompt processing progress (llama-server extension when return_progress: true).
 * Sent in stream chunks as top-level prompt_progress.
 */
export interface PromptProgress {
	total: number;
	cache: number;
	processed: number;
	time_ms: number;
}

/**
 * SSE chunk from llama-server may include optional prompt_progress (when return_progress: true),
 * usage (when stream_options.include_usage is true), and timings.
 */
export type OpenAIChatCompletionChunkWithProgress = OpenAIChatCompletionChunk & {
	prompt_progress?: PromptProgress;
	usage?: OpenAIUsage;
	timings?: LlamaServerTimings;
};

/**
 * Token usage statistics returned by OpenAI-compatible APIs.
 */
export interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

/**
 * Timing information returned by llama-server in stream and non-stream responses.
 * Can be used as a fallback when the standard usage object is absent.
 */
export interface LlamaServerTimings {
	prompt_n?: number;
	cache_n?: number;
	predicted_n?: number;
	prompt_ms?: number;
	predicted_ms?: number;
	prompt_per_token_ms?: number;
	prompt_per_second?: number;
	predicted_per_token_ms?: number;
	predicted_per_second?: number;
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
	usage?: OpenAIUsage;
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
	/** Placed after the FIM_MID marker in the infill template (llama-server /infill). */
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
