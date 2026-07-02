import * as vscode from 'vscode';

/** Configuration section for the extension (must match package.json contributes.configuration) */
export const CONFIG_SECTION = 'llamaCopilot';

/** Memento key for tool call IDs already emailed */
export const MEMENTO_SMTP_EMAILED_CALL_IDS = 'llamaCopilot.smtpEmailedCallIds';

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
 * Inline completion /infill prompt (trimmed). Empty string means omit the prompt field from the request.
 */
export function getInlineCompletionPrompt(): string {
	const v = getConfig().get<string>('inlineCompletionPrompt', DEFAULT_INLINE_COMPLETION_PROMPT);
	return (v ?? '').trim();
}

/** Resolved SMTP settings from workspace configuration (unauthenticated SMTP). */
export interface SmtpToolEmailSettings {
	readonly enabled: boolean;
	readonly host: string;
	readonly port: number;
	readonly secure: boolean;
	readonly from: string;
	readonly toRaw: string;
	readonly tlsRejectUnauthorized: boolean;
	readonly toolNames: readonly string[];
	readonly subjectPrefix: string;
	readonly maxBodyChars: number;
}

/**
 * Read SMTP-related settings.
 */
export function getSmtpToolEmailSettings(): SmtpToolEmailSettings {
	const c = getConfig();
	const toolNames = c.get<string[]>('smtp.toolNames', ['invoke_agent']);
	return {
		enabled: c.get<boolean>('smtp.enabled', false),
		host: (c.get<string>('smtp.host', '') ?? '').trim(),
		port: c.get<number>('smtp.port', 587),
		secure: c.get<boolean>('smtp.secure', false),
		from: (c.get<string>('smtp.from', '') ?? '').trim(),
		toRaw: (c.get<string>('smtp.to', '') ?? '').trim(),
		tlsRejectUnauthorized: c.get<boolean>('smtp.tls.rejectUnauthorized', true),
		toolNames: Array.isArray(toolNames) ? [...toolNames] : ['invoke_agent'],
		subjectPrefix: c.get<string>('smtp.subjectPrefix', '[llama-copilot tool]') ?? '[llama-copilot tool]',
		maxBodyChars: c.get<number>('smtp.maxBodyChars', 500_000),
	};
}

/** Split comma-separated SMTP recipient list (trimmed, non-empty segments). */
export function parseSmtpRecipients(toRaw: string): string[] {
	return toRaw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}
