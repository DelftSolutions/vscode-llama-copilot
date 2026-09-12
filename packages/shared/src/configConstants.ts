/** Configuration section for the extension (must match package.json contributes.configuration) */
export const CONFIG_SECTION = 'llamaCopilot';

/** Key for endpoints configuration object */
export const CONFIG_ENDPOINTS = 'endpoints';

/** Default request timeout in seconds (used when not overridden by user) */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 1200;

/** Default /infill prompt text (must match package.json default for inlineCompletionPrompt) */
export const DEFAULT_INLINE_COMPLETION_PROMPT = 'Limit completion to a few words.';

/** Debug log categories (keys under llamaCopilot.debug.*) */
export const DEBUG_MODEL_LIST_FETCH = 'modelListFetch';
export const DEBUG_COMPLETION = 'completion';
export const DEBUG_TOKENIZATION = 'tokenization';
export const DEBUG_RULES_MATCHING = 'rulesMatching';
export const DEBUG_TOOL_CALLS = 'toolCalls';
export const DEBUG_INLINE_COMPLETION = 'inlineCompletion';

export type DebugCategory =
	| typeof DEBUG_MODEL_LIST_FETCH
	| typeof DEBUG_COMPLETION
	| typeof DEBUG_TOKENIZATION
	| typeof DEBUG_RULES_MATCHING
	| typeof DEBUG_TOOL_CALLS
	| typeof DEBUG_INLINE_COMPLETION;
