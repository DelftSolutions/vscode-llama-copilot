/**
 * Logger shared between UI and workspace extensions.
 *
 * The isDebugEnabled check is injectable — each extension provides its
 * own implementation during initializeLogger() since it depends on
 * vscode.workspace.getConfiguration() which is extension-specific.
 */

import type { DebugCategory } from './configConstants.js';
import {
	DEBUG_MODEL_LIST_FETCH,
	DEBUG_COMPLETION,
	DEBUG_TOKENIZATION,
	DEBUG_RULES_MATCHING,
	DEBUG_TOOL_CALLS,
} from './configConstants.js';

export type { DebugCategory };

export {
	DEBUG_MODEL_LIST_FETCH,
	DEBUG_COMPLETION,
	DEBUG_TOKENIZATION,
	DEBUG_RULES_MATCHING,
	DEBUG_TOOL_CALLS,
};

interface OutputChannel {
	appendLine(value: string): void;
}

let outputChannel: OutputChannel | undefined;
let debugEnabledCheck: ((category: DebugCategory) => boolean) | undefined;

const REASONING_LOG_TRUNCATE_LENGTH = 100;

/**
 * Initialize the logger with a VS Code output channel and an optional
 * debug-enabled check function.
 */
export function initializeLogger(
	channel: OutputChannel,
	isDebugEnabled?: (category: DebugCategory) => boolean,
): void {
	outputChannel = channel;
	debugEnabledCheck = isDebugEnabled;
}

function isDebugEnabled(category: DebugCategory): boolean {
	return debugEnabledCheck ? debugEnabledCheck(category) : false;
}

function getTimestamp(): string {
	return new Date().toISOString();
}

function truncateAttachments(str: string): string {
	if (!str.includes('<attachment') && !str.includes('<attachments>')) {
		return str;
	}
	const attachmentPattern = /<attachment\s+([^>]*)>([\s\S]*?)<\/attachment>/g;
	return str.replace(attachmentPattern, (_match, attributes) => {
		return `<attachment ${attributes}>[attachment body truncated]</attachment>`;
	});
}

function formatJson(obj: unknown): string {
	try {
		const sanitized = sanitizeForLogging(obj);
		return JSON.stringify(sanitized, null, 2);
	} catch {
		return String(obj);
	}
}

function sanitizeForLogging(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj === 'string') return truncateAttachments(obj);
	if (typeof obj !== 'object') return obj;

	if (Array.isArray(obj)) return obj.map(sanitizeForLogging);

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

function log(message: string): void {
	if (outputChannel) outputChannel.appendLine(message);
}

export function logDebug(category: DebugCategory, message: string, details?: unknown): void {
	if (!isDebugEnabled(category)) return;
	const timestamp = getTimestamp();
	log(`[${timestamp}] ${message}`);
	if (details !== undefined) {
		log(details instanceof Error ? String(details) : formatJson(sanitizeForLogging(details)));
	}
}

export function logRequest(method: string, url: string, headers?: Record<string, string>, body?: unknown): void {
	logDebug(DEBUG_MODEL_LIST_FETCH, `${method} ${url}`);
	if (headers && Object.keys(headers).length > 0) logDebug(DEBUG_MODEL_LIST_FETCH, 'Headers', headers);
	if (body !== undefined) logDebug(DEBUG_MODEL_LIST_FETCH, 'Request Body', body);
}

export function logResponse(status: number, statusText: string, body?: unknown): void {
	logDebug(DEBUG_MODEL_LIST_FETCH, `Response: ${status} ${statusText}`);
	if (body !== undefined) logDebug(DEBUG_MODEL_LIST_FETCH, 'Response Body', body);
}

export function logError(error: Error | string, context?: string, details?: string): void {
	const timestamp = getTimestamp();
	const errorMessage = error instanceof Error ? error.message : error;
	const contextStr = context ? ` [${context}]` : '';
	log(`[${timestamp}] ERROR${contextStr}: ${errorMessage}`);
	if (details) log(`Details: ${details}`);
	if (error instanceof Error && error.stack) log(`Stack: ${error.stack}`);
}

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

export function logStreamResponse(status: number, statusText: string): void {
	logDebug(DEBUG_COMPLETION, `Stream Response: ${status} ${statusText}`);
}

export function logTokenizeRequest(url: string, headers?: Record<string, string>, body?: unknown): void {
	logDebug(DEBUG_TOKENIZATION, `POST ${url} (Tokenization)`);
	if (headers && Object.keys(headers).length > 0) logDebug(DEBUG_TOKENIZATION, 'Headers', headers);
	if (body !== undefined) logDebug(DEBUG_TOKENIZATION, 'Request Body', body);
}

export function logTokenizeResponse(status: number, statusText: string, tokenCount?: number): void {
	logDebug(DEBUG_TOKENIZATION, `Tokenization Response: ${status} ${statusText}`);
	if (tokenCount !== undefined) logDebug(DEBUG_TOKENIZATION, 'Token Count', tokenCount);
}

export function logRulesMatching(operation: string, details?: Record<string, unknown>): void {
	logDebug(DEBUG_RULES_MATCHING, `Rules Matching: ${operation}`);
	if (details) logDebug(DEBUG_RULES_MATCHING, 'Details', details);
}

export function logToolCall(toolName: string, callId: string, input?: unknown): void {
	logDebug(DEBUG_TOOL_CALLS, `Tool Call: ${toolName} (ID: ${callId})`);
	if (input !== undefined) logDebug(DEBUG_TOOL_CALLS, 'Input', input);
}

export function logToolCallResult(toolName: string, callId: string, result?: unknown): void {
	logDebug(DEBUG_TOOL_CALLS, `Tool Call Result: ${toolName} (ID: ${callId})`);
	if (result !== undefined) logDebug(DEBUG_TOOL_CALLS, 'Result', result);
}

export function logLoopDetection(detection: {
	trigger: string;
	cycleMembers: Array<{ toolName: string; windowCount: number; totalCount: number }>;
	toolsToFilter: string[];
}): void {
	const memberSummary = detection.cycleMembers
		.map(m => `${m.toolName} (window: ${m.windowCount}, total: ${m.totalCount})`)
		.join(', ');
	logDebug(
		DEBUG_TOOL_CALLS,
		`Loop detected: trigger=${detection.trigger}, members=[${memberSummary}]`
		+ (detection.toolsToFilter.length > 0
			? `, filtering tools: [${detection.toolsToFilter.join(', ')}]`
			: ''),
	);
}
