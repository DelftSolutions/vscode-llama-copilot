import * as vscode from 'vscode';

/** Configuration section for the extension (must match package.json contributes.configuration) */
export const CONFIG_SECTION = 'llamaCopilot';

/** Key for endpoints configuration object */
export const CONFIG_ENDPOINTS = 'endpoints';

/** Default request timeout in seconds (used when not overridden by user) */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 1200;

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

/**
 * Get the workspace configuration for this extension.
 */
export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * Get request timeout in milliseconds (from user setting or default).
 */
export function getRequestTimeoutMs(): number {
	const config = getConfig();
	const seconds = config.get<number>('requestTimeoutSeconds', DEFAULT_REQUEST_TIMEOUT_SECONDS);
	return seconds * 1000;
}

/**
 * Check if cursor rules feature is enabled.
 */
export function isCursorRulesEnabled(): boolean {
	return getConfig().get<boolean>('enableCursorRules', true);
}

/**
 * Check if a debug log category is enabled.
 */
export function isDebugEnabled(category: DebugCategory): boolean {
	return getConfig().get<boolean>(`debug.${category}`, false);
}

/**
 * Full configuration key for endpoints (for affectsConfiguration checks).
 */
export function endpointsConfigKey(): string {
	return `${CONFIG_SECTION}.${CONFIG_ENDPOINTS}`;
}

/**
 * Full configuration key for opening settings (e.g. workbench.action.openSettings).
 */
export function endpointsSettingsKey(): string {
	return `${CONFIG_SECTION}.${CONFIG_ENDPOINTS}`;
}

/**
 * Get the inline completion model ID (e.g. sweep-next-edit-1.5b@local). Empty string means disabled.
 */
export function getInlineCompletionModel(): string {
	return getConfig().get<string>('inlineCompletionModel', '')?.trim() ?? '';
}

/**
 * Get inline completion request timeout in milliseconds.
 */
export function getInlineCompletionTimeoutMs(): number {
	return getConfig().get<number>('inlineCompletionTimeoutMs', 5000);
}

/**
 * Get maximum input size in bytes (UTF-8) for inline completion (prefix + suffix + input_extra).
 */
export function getInlineCompletionMaxInputBytes(): number {
	return getConfig().get<number>('inlineCompletionMaxInputBytes', 16384);
}

/**
 * Get debounce delay in milliseconds for automatic inline completion requests.
 * Invoked (explicit) triggers are not debounced.
 */
export function getInlineCompletionDebounceMs(): number {
	return getConfig().get<number>('inlineCompletionDebounceMs', 2000);
}

/**
 * Whether to include Sweep-style context (current file path, optionally other files) in inline completion requests.
 */
export function isInlineCompletionContextEnabled(): boolean {
	return getConfig().get<boolean>('inlineCompletionIncludeContext', true);
}
