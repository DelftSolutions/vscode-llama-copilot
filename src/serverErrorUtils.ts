/**
 * Utilities for parsing and formatting llama-server JSON error responses.
 * Server returns { "error": { "message", "type", "code", ... } }; for
 * exceed_context_size_error also n_prompt_tokens and n_ctx.
 */

export interface ParsedServerError {
	message: string;
	type?: string;
	code?: number;
	n_prompt_tokens?: number;
	n_ctx?: number;
}

/**
 * Parse a llama-server error response body.
 * Returns null if body is not valid JSON or does not contain an error object.
 */
export function parseServerError(bodyText: string): ParsedServerError | null {
	if (!bodyText || typeof bodyText !== 'string') {
		return null;
	}
	const trimmed = bodyText.trim();
	if (!trimmed) {
		return null;
	}
	try {
		const data = JSON.parse(trimmed) as { error?: unknown };
		if (!data || typeof data.error !== 'object' || data.error === null) {
			return null;
		}
		const err = data.error as Record<string, unknown>;
		const message = typeof err.message === 'string' ? err.message : '';
		const parsed: ParsedServerError = { message: message || 'Unknown error' };
		if (typeof err.type === 'string') parsed.type = err.type;
		if (typeof err.code === 'number') parsed.code = err.code;
		if (typeof err.n_prompt_tokens === 'number') parsed.n_prompt_tokens = err.n_prompt_tokens;
		if (typeof err.n_ctx === 'number') parsed.n_ctx = err.n_ctx;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Format a server error for display to the user.
 * Uses parsed error when available; otherwise uses status and fallbackText.
 * Caller should handle "Internal Server Error - proxy error" separately (timeout probe) before calling this.
 */
export function formatServerErrorMessage(
	parsed: ParsedServerError | null,
	status: number,
	fallbackText: string
): string {
	const msg = parsed?.message?.trim() || fallbackText || 'Unknown error';
	const type = parsed?.type;

	switch (type) {
		case 'authentication_error':
			return `Invalid API key. Check the endpoint's apiToken in Settings → Llama Copilot.`;
		case 'not_found_error':
			return msg
				? `Not found: ${msg}. Check the model id and server URL.`
				: `Resource not found (${status}). Check the model id and server URL.`;
		case 'invalid_request_error':
			if (/model is not loaded/i.test(msg)) {
				return `Model is not loaded: ${msg}. Load the model via the server or check the model name.`;
			}
			return msg ? `Invalid request: ${msg}.` : `Invalid request (${status}).`;
		case 'exceed_context_size_error': {
			const n = parsed?.n_prompt_tokens;
			const ctx = parsed?.n_ctx;
			if (n != null && ctx != null) {
				return `Prompt exceeds context size (${n} tokens, context size ${ctx}). Shorten the conversation or use a model with a larger context (e.g. increase ctx-size for this model).`;
			}
			const prefix = msg || 'Prompt exceeds context size';
			return `${prefix}. Shorten the conversation or use a model with a larger context.`;
		}
		case 'server_error':
			// Proxy error is handled by caller; generic server error here
			return msg ? `Server error: ${msg}. Check server logs.` : `Server error (${status}). Check server logs.`;
		case 'unavailable_error':
			return `Server is still loading. Wait and try again, or check that the model is loading correctly.`;
		case 'not_supported_error':
			return msg
				? `This feature is not supported: ${msg}. Start the server with the required flag or use a different model.`
				: `This feature is not supported (${status}). Start the server with the required flag or use a different model.`;
		case 'permission_error':
			return msg ? `Permission denied: ${msg}.` : `Permission denied (${status}).`;
		default:
			// Unknown type or no type: show status and message
			if (msg && msg !== fallbackText) {
				return `${status >= 500 ? 'Server' : 'Request'} error: ${msg}.`;
			}
			return status >= 500
				? `Server error (${status}). ${fallbackText || 'Check server logs.'}`
				: `Request failed (${status}). ${fallbackText || 'Check the request.'}`;
	}
}
