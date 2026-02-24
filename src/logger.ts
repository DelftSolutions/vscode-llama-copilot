import * as vscode from 'vscode';
import {
	isDebugEnabled,
	type DebugCategory,
	DEBUG_MODEL_LIST_FETCH,
	DEBUG_COMPLETION,
	DEBUG_TOKENIZATION,
	DEBUG_RULES_MATCHING,
	DEBUG_TOOL_CALLS,
} from './config';

export type { DebugCategory };

let outputChannel: vscode.OutputChannel | undefined;

/** Max length of reasoning/thinking content in debug logs to avoid clutter */
const REASONING_LOG_TRUNCATE_LENGTH = 100;

/**
 * Initialize the logger with a VS Code output channel
 */
export function initializeLogger(channel: vscode.OutputChannel): void {
	outputChannel = channel;
}

/**
 * Get the current timestamp in ISO format
 */
function getTimestamp(): string {
	return new Date().toISOString();
}

/**
 * Truncate attachment body content in strings while preserving metadata
 * Replaces the content between <attachment ...> and </attachment> with a truncation indicator
 */
function truncateAttachments(str: string): string {
	// Check if string contains attachment tags
	if (!str.includes('<attachment') && !str.includes('<attachments>')) {
		return str;
	}

	// Use regex to match <attachment> tags with their attributes and replace body content
	// Pattern matches: <attachment ...attributes...>content</attachment>
	// We use a non-greedy match to handle multiple attachments
	const attachmentPattern = /<attachment\s+([^>]*)>([\s\S]*?)<\/attachment>/g;
	
	return str.replace(attachmentPattern, (match, attributes, body) => {
		// Preserve the opening tag with attributes, but replace body with truncation indicator
		return `<attachment ${attributes}>[attachment body truncated]</attachment>`;
	});
}

/**
 * Format JSON for logging (pretty print with indentation)
 * Sanitizes thinking tokens to avoid cluttering logs
 */
function formatJson(obj: unknown): string {
	try {
		// Create a sanitized copy for logging
		const sanitized = sanitizeForLogging(obj);
		return JSON.stringify(sanitized, null, 2);
	} catch {
		return String(obj);
	}
}

/**
 * Sanitize object for logging - truncate thinking tokens and highlight tool calls
 */
function sanitizeForLogging(obj: unknown): unknown {
	if (obj === null || obj === undefined) {
		return obj;
	}

	// Handle string values - truncate attachments if present
	if (typeof obj === 'string') {
		return truncateAttachments(obj);
	}

	if (typeof obj !== 'object') {
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map(sanitizeForLogging);
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === 'reasoning_content' && typeof value === 'string') {
			const attachmentTruncated = truncateAttachments(value);
			sanitized[key] =
				attachmentTruncated.length > REASONING_LOG_TRUNCATE_LENGTH
					? `${attachmentTruncated.substring(0, REASONING_LOG_TRUNCATE_LENGTH)}... (${attachmentTruncated.length} chars total)`
					: attachmentTruncated;
		} else {
			sanitized[key] = sanitizeForLogging(value);
		}
	}

	return sanitized;
}

/**
 * Log a message to the output channel
 */
function log(message: string): void {
	if (outputChannel) {
		outputChannel.appendLine(message);
	}
}

/**
 * Log a debug message when the given category is enabled.
 * Single place for category check and timestamp/formatting.
 */
export function logDebug(
	category: DebugCategory,
	message: string,
	details?: unknown
): void {
	if (!isDebugEnabled(category)) return;
	const timestamp = getTimestamp();
	log(`[${timestamp}] ${message}`);
	if (details !== undefined) {
		log(details instanceof Error ? String(details) : formatJson(sanitizeForLogging(details)));
	}
}

/**
 * Log an API request
 */
export function logRequest(
	method: string,
	url: string,
	headers?: Record<string, string>,
	body?: unknown
): void {
	logDebug(DEBUG_MODEL_LIST_FETCH, `${method} ${url}`);
	if (headers && Object.keys(headers).length > 0) {
		logDebug(DEBUG_MODEL_LIST_FETCH, 'Headers', headers);
	}
	if (body !== undefined) {
		logDebug(DEBUG_MODEL_LIST_FETCH, 'Request Body', body);
	}
}

/**
 * Log an API response
 */
export function logResponse(
	status: number,
	statusText: string,
	body?: unknown
): void {
	logDebug(DEBUG_MODEL_LIST_FETCH, `Response: ${status} ${statusText}`);
	if (body !== undefined) {
		logDebug(DEBUG_MODEL_LIST_FETCH, 'Response Body', body);
	}
}

/**
 * Log an API error
 */
export function logError(error: Error | string, context?: string): void {
	const timestamp = getTimestamp();
	const errorMessage = error instanceof Error ? error.message : error;
	const contextStr = context ? ` [${context}]` : '';
	log(`[${timestamp}] ERROR${contextStr}: ${errorMessage}`);
	
	if (error instanceof Error && error.stack) {
		log(`Stack: ${error.stack}`);
	}
}

/**
 * Log a streaming request start
 */
export function logStreamStart(method: string, url: string, body?: unknown): void {
	logDebug(DEBUG_COMPLETION, `${method} ${url} (Streaming)`);
	if (body !== undefined) {
		logDebug(DEBUG_COMPLETION, 'Request Body', sanitizeForLogging(body));
		if (typeof body === 'object' && body !== null && 'tools' in body) {
			const tools = (body as { tools?: unknown[] }).tools;
			if (Array.isArray(tools) && tools.length > 0) {
				logDebug(DEBUG_COMPLETION, `Tools: ${tools.length} tool(s) available`);
			}
		}
	}
}

/**
 * Log a streaming response status
 */
export function logStreamResponse(status: number, statusText: string): void {
	logDebug(DEBUG_COMPLETION, `Stream Response: ${status} ${statusText}`);
}

/**
 * Log tokenization request
 */
export function logTokenizeRequest(
	url: string,
	headers?: Record<string, string>,
	body?: unknown
): void {
	logDebug(DEBUG_TOKENIZATION, `POST ${url} (Tokenization)`);
	if (headers && Object.keys(headers).length > 0) {
		logDebug(DEBUG_TOKENIZATION, 'Headers', headers);
	}
	if (body !== undefined) {
		logDebug(DEBUG_TOKENIZATION, 'Request Body', body);
	}
}

/**
 * Log tokenization response
 */
export function logTokenizeResponse(
	status: number,
	statusText: string,
	tokenCount?: number
): void {
	logDebug(DEBUG_TOKENIZATION, `Tokenization Response: ${status} ${statusText}`);
	if (tokenCount !== undefined) {
		logDebug(DEBUG_TOKENIZATION, 'Token Count', tokenCount);
	}
}

/**
 * Log rules matching operation
 */
export function logRulesMatching(
	operation: string,
	details?: Record<string, unknown>
): void {
	logDebug(DEBUG_RULES_MATCHING, `Rules Matching: ${operation}`);
	if (details) {
		logDebug(DEBUG_RULES_MATCHING, 'Details', details);
	}
}

/**
 * Log tool call
 */
export function logToolCall(
	toolName: string,
	callId: string,
	input?: unknown
): void {
	logDebug(DEBUG_TOOL_CALLS, `Tool Call: ${toolName} (ID: ${callId})`);
	if (input !== undefined) {
		logDebug(DEBUG_TOOL_CALLS, 'Input', input);
	}
}

/**
 * Log tool call result
 */
export function logToolCallResult(
	toolName: string,
	callId: string,
	result?: unknown
): void {
	logDebug(DEBUG_TOOL_CALLS, `Tool Call Result: ${toolName} (ID: ${callId})`);
	if (result !== undefined) {
		logDebug(DEBUG_TOOL_CALLS, 'Result', result);
	}
}
