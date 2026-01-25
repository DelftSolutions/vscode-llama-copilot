import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;
const CONFIG_SECTION = 'llamaCopilot';

/**
 * Initialize the logger with a VS Code output channel
 */
export function initializeLogger(channel: vscode.OutputChannel): void {
	outputChannel = channel;
}

/**
 * Check if a debug setting is enabled
 */
function isDebugEnabled(setting: string): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>(`debug.${setting}`, false);
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
			// First truncate attachments if present, then truncate thinking tokens to first 100 chars
			const attachmentTruncated = truncateAttachments(value);
			sanitized[key] = attachmentTruncated.length > 100 
				? `${attachmentTruncated.substring(0, 100)}... (${attachmentTruncated.length} chars total)`
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
 * Log an API request
 */
export function logRequest(
	method: string,
	url: string,
	headers?: Record<string, string>,
	body?: unknown
): void {
	if (!isDebugEnabled('modelListFetch')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] ${method} ${url}`);
	
	if (headers && Object.keys(headers).length > 0) {
		log(`Headers: ${formatJson(headers)}`);
	}
	
	if (body !== undefined) {
		log(`Request Body: ${formatJson(body)}`);
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
	if (!isDebugEnabled('modelListFetch')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] Response: ${status} ${statusText}`);
	
	if (body !== undefined) {
		log(`Response Body: ${formatJson(body)}`);
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
	if (!isDebugEnabled('completion')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] ${method} ${url} (Streaming)`);
	
	if (body !== undefined) {
		const sanitizedBody = sanitizeForLogging(body);
		log(`Request Body: ${formatJson(sanitizedBody)}`);
		
		// Log tool call summary if present
		if (typeof body === 'object' && body !== null && 'tools' in body) {
			const tools = (body as { tools?: unknown[] }).tools;
			if (Array.isArray(tools) && tools.length > 0) {
				log(`  Tools: ${tools.length} tool(s) available`);
			}
		}
	}
}

/**
 * Log a streaming response status
 */
export function logStreamResponse(status: number, statusText: string): void {
	if (!isDebugEnabled('completion')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] Stream Response: ${status} ${statusText}`);
}

/**
 * Log tokenization request
 */
export function logTokenizeRequest(
	url: string,
	headers?: Record<string, string>,
	body?: unknown
): void {
	if (!isDebugEnabled('tokenization')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] POST ${url} (Tokenization)`);
	
	if (headers && Object.keys(headers).length > 0) {
		log(`Headers: ${formatJson(headers)}`);
	}
	
	if (body !== undefined) {
		log(`Request Body: ${formatJson(body)}`);
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
	if (!isDebugEnabled('tokenization')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] Tokenization Response: ${status} ${statusText}`);
	
	if (tokenCount !== undefined) {
		log(`Token Count: ${tokenCount}`);
	}
}

/**
 * Log rules matching operation
 */
export function logRulesMatching(
	operation: string,
	details?: Record<string, unknown>
): void {
	if (!isDebugEnabled('rulesMatching')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] Rules Matching: ${operation}`);
	
	if (details) {
		log(`Details: ${formatJson(details)}`);
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
	if (!isDebugEnabled('toolCalls')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] Tool Call: ${toolName} (ID: ${callId})`);
	
	if (input !== undefined) {
		log(`Input: ${formatJson(input)}`);
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
	if (!isDebugEnabled('toolCalls')) {
		return;
	}
	
	const timestamp = getTimestamp();
	log(`[${timestamp}] Tool Call Result: ${toolName} (ID: ${callId})`);
	
	if (result !== undefined) {
		log(`Result: ${formatJson(result)}`);
	}
}
