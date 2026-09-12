/**
 * Shared types used by both UI and workspace extensions.
 * No vscode dependency — capabilities are defined inline.
 */

/**
 * Model capability overrides (mirrors LanguageModelChatCapabilities shape
 * without importing from vscode, so shared package stays vscode-free).
 */
export interface ModelCapabilities {
	imageInput?: boolean;
	toolCalling?: boolean | number;
}

export interface ModelConfig {
	headers?: Record<string, string>;
	requestBody?: Record<string, unknown>;
	contextSize?: number;
	maxOutputTokens?: number;
	thinkingBudgetFraction?: number;
	capabilities?: ModelCapabilities;
}

export interface EndpointConfig {
	url: string;
	apiToken?: string;
	headers?: Record<string, string>;
	requestBody?: Record<string, unknown>;
	thinkingBudgetFraction?: number;
	models?: Record<string, ModelConfig>;
}

export type EndpointsConfig = Record<string, EndpointConfig>;

export interface ModelsResponse {
	data: Model[];
	object: 'list';
}

export interface ModelMeta {
	n_ctx?: number;
	n_ctx_train?: number;
	n_embd?: number;
	n_params?: number;
	n_vocab?: number;
	vocab_type?: number;
	size?: number;
}

export interface Model {
	id: string;
	object: 'model';
	owned_by: string;
	created: number;
	status?: ModelStatus;
	meta?: ModelMeta;
}

export interface ModelStatus {
	value: 'unloaded' | 'loading' | 'loaded';
	args?: string[];
	preset?: string;
	failed?: boolean;
	exit_code?: number;
}

export interface TokenizeRequest {
	content: string;
	model?: string;
	add_special?: boolean;
	parse_special?: boolean;
	with_pieces?: boolean;
}

export interface TokenizeResponse {
	tokens: number[] | Array<{ id: number; piece: string | number[] }>;
}

export interface ApplyTemplateResponse {
	prompt: string;
}

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

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

export type OpenAIContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null | OpenAIContentPart[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

export interface PreparedCompletionRequest {
	openAIMessages: OpenAIChatMessage[];
	requestTokenCount: number;
	max_tokens: number;
}

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

export interface OpenAIChatCompletionChoice {
	index: number;
	delta?: OpenAIChatCompletionDelta;
	message?: OpenAIChatMessage;
	finish_reason?: 'stop' | 'length' | 'tool_calls' | null;
}

export interface StreamToolCallDeltaAccumulator {
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

export interface OpenAIChatCompletionChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: OpenAIChatCompletionChoice[];
}

export interface PromptProgress {
	total: number;
	cache: number;
	processed: number;
	time_ms: number;
}

export type OpenAIChatCompletionChunkWithProgress = OpenAIChatCompletionChunk & {
	prompt_progress?: PromptProgress;
	usage?: OpenAIUsage;
	timings?: LlamaServerTimings;
};

export interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

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

export interface InfillInputExtra {
	text: string;
	filename: string;
}

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

export interface InfillResponse {
	content: string;
	stop?: boolean;
	generation_settings?: unknown;
	model?: string;
	tokens_evaluated?: number;
	prompt?: string;
	truncated?: boolean;
}
