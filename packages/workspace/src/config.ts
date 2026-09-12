import * as vscode from 'vscode';
import {
	CONFIG_SECTION,
	CONFIG_ENDPOINTS,
	DEFAULT_REQUEST_TIMEOUT_SECONDS,
	DEFAULT_INLINE_COMPLETION_PROMPT,
	DEBUG_MODEL_LIST_FETCH,
	DEBUG_COMPLETION,
	DEBUG_TOKENIZATION,
	DEBUG_RULES_MATCHING,
	DEBUG_TOOL_CALLS,
	DEBUG_INLINE_COMPLETION,
	type DebugCategory,
} from '@llama-copilot/shared';

// Re-export constants so downstream workspace code can import from './config.js'
export {
	CONFIG_SECTION,
	CONFIG_ENDPOINTS,
	DEFAULT_REQUEST_TIMEOUT_SECONDS,
	DEFAULT_INLINE_COMPLETION_PROMPT,
	DEBUG_MODEL_LIST_FETCH,
	DEBUG_COMPLETION,
	DEBUG_TOKENIZATION,
	DEBUG_RULES_MATCHING,
	DEBUG_TOOL_CALLS,
	DEBUG_INLINE_COMPLETION,
	type DebugCategory,
} from '@llama-copilot/shared';

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
 * Show status bar during prompt processing when estimated remaining time exceeds this many seconds.
 * Returns 0 = disabled. Default 120.
 */
export function getPromptProgressStatusBarThresholdSeconds(): number {
	return getConfig().get<number>('promptProgressStatusBarThresholdSeconds', 120);
}

/**
 * Whether to show all models without filtering slashed IDs.
 */
export function isShowAllModels(): boolean {
	return getConfig().get<boolean>('showAllModels', false);
}

/**
 * Minimum milliseconds of prompt processing before showing progress.
 * Default 10000 (10 seconds). Set to 0 to show progress immediately.
 */
export function getMinPromptProgressElapsedMs(): number {
	return getConfig().get<number>('minPromptProgressElapsedMs', 10000);
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

/**
 * Check if tool loop detection feature is enabled.
 */
export function isToolLoopDetectionEnabled(): boolean {
	return getConfig().get<boolean>('enableToolLoopDetection', true);
}

/**
 * Inline completion /infill prompt (trimmed). Empty string means omit the prompt field from the request.
 */
export function getInlineCompletionPrompt(): string {
	const v = getConfig().get<string>('inlineCompletionPrompt', DEFAULT_INLINE_COMPLETION_PROMPT);
	return (v ?? '').trim();
}

// --- Managed server settings ---

/**
 * Whether managed llama-server mode is enabled.
 */
export function isServerManaged(): boolean {
	return getConfig().get<boolean>('server.managed', false);
}

/**
 * Port for the managed llama-server instance.
 */
export function getServerPort(): number {
	return getConfig().get<number>('server.port', 8013);
}

/**
 * Whether to kill the managed server when VS Code deactivates.
 */
export function getStopOnDeactivate(): boolean {
	return getConfig().get<boolean>('server.stopOnDeactivate', true);
}

/**
 * Whether auto-update of the llama-server binary is enabled.
 */
export function isAutoUpdateEnabled(): boolean {
	return getConfig().get<boolean>('server.autoUpdate', true);
}

/**
 * Additional CLI arguments passed to the managed llama-server.
 */
export function getServerExtraArgs(): string[] {
	return getConfig().get<string[]>('server.extraArgs', []);
}
