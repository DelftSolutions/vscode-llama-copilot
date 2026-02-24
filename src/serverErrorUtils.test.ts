import { describe, it, expect } from 'vitest';
import {
	parseServerError,
	formatServerErrorMessage,
	type ParsedServerError,
} from './serverErrorUtils';

describe('parseServerError', () => {
	it('returns null for empty or non-string input', () => {
		expect(parseServerError('')).toBeNull();
		expect(parseServerError('   ')).toBeNull();
		expect(parseServerError(null as never)).toBeNull();
		expect(parseServerError(123 as never)).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(parseServerError('not json')).toBeNull();
		expect(parseServerError('{')).toBeNull();
		expect(parseServerError('[]')).toBeNull();
	});

	it('returns null when response has no error object', () => {
		expect(parseServerError('{}')).toBeNull();
		expect(parseServerError('{"data": []}')).toBeNull();
		expect(parseServerError('{"error": null}')).toBeNull();
	});

	it('parses minimal error object', () => {
		const parsed = parseServerError('{"error": {"message": "Something went wrong"}}');
		expect(parsed).toEqual({ message: 'Something went wrong' });
	});

	it('parses full error object with type and code', () => {
		const body = JSON.stringify({
			error: {
				message: 'Invalid API Key',
				type: 'authentication_error',
				code: 401,
			},
		});
		const parsed = parseServerError(body);
		expect(parsed).toEqual({
			message: 'Invalid API Key',
			type: 'authentication_error',
			code: 401,
		});
	});

	it('parses exceed_context_size_error with n_prompt_tokens and n_ctx', () => {
		const body = JSON.stringify({
			error: {
				message: 'prompt too long',
				type: 'exceed_context_size_error',
				code: 400,
				n_prompt_tokens: 50000,
				n_ctx: 32768,
			},
		});
		const parsed = parseServerError(body);
		expect(parsed).toEqual({
			message: 'prompt too long',
			type: 'exceed_context_size_error',
			code: 400,
			n_prompt_tokens: 50000,
			n_ctx: 32768,
		});
	});

	it('defaults message to Unknown error when missing', () => {
		const parsed = parseServerError('{"error": {"type": "server_error", "code": 500}}');
		expect(parsed?.message).toBe('Unknown error');
		expect(parsed?.type).toBe('server_error');
	});

	it('ignores non-string type and non-number code', () => {
		const body = '{"error": {"message": "x", "type": 123, "code": "500"}}';
		const parsed = parseServerError(body);
		expect(parsed).toEqual({ message: 'x' });
	});
});

describe('formatServerErrorMessage', () => {
	it('formats authentication_error without server message', () => {
		const parsed: ParsedServerError = { message: 'Invalid API Key', type: 'authentication_error', code: 401 };
		const msg = formatServerErrorMessage(parsed, 401, '');
		expect(msg).toContain('Invalid API key');
		expect(msg).toContain('Settings → Llama Copilot');
	});

	it('formats not_found_error with message', () => {
		const parsed: ParsedServerError = { message: 'model not found', type: 'not_found_error', code: 404 };
		const msg = formatServerErrorMessage(parsed, 404, '');
		expect(msg).toContain('Not found: model not found');
		expect(msg).toContain('model id and server URL');
	});

	it('formats invalid_request_error with "model is not loaded"', () => {
		const parsed: ParsedServerError = {
			message: 'model is not loaded',
			type: 'invalid_request_error',
			code: 400,
		};
		const msg = formatServerErrorMessage(parsed, 400, '');
		expect(msg).toContain('Model is not loaded');
		expect(msg).toContain('Load the model');
	});

	it('formats invalid_request_error generic', () => {
		const parsed: ParsedServerError = {
			message: 'missing field: model',
			type: 'invalid_request_error',
			code: 400,
		};
		const msg = formatServerErrorMessage(parsed, 400, '');
		expect(msg).toContain('Invalid request: missing field: model');
	});

	it('formats exceed_context_size_error with n_prompt_tokens and n_ctx', () => {
		const parsed: ParsedServerError = {
			message: 'prompt too long',
			type: 'exceed_context_size_error',
			code: 400,
			n_prompt_tokens: 50000,
			n_ctx: 32768,
		};
		const msg = formatServerErrorMessage(parsed, 400, '');
		expect(msg).toContain('50000 tokens');
		expect(msg).toContain('context size 32768');
		expect(msg).toContain('Shorten the conversation');
		expect(msg).toContain('ctx-size');
	});

	it('formats exceed_context_size_error without numbers', () => {
		const parsed: ParsedServerError = {
			message: 'prompt too long',
			type: 'exceed_context_size_error',
			code: 400,
		};
		const msg = formatServerErrorMessage(parsed, 400, '');
		expect(msg).toContain('Shorten the conversation');
	});

	it('formats server_error with message', () => {
		const parsed: ParsedServerError = { message: 'internal failure', type: 'server_error', code: 500 };
		const msg = formatServerErrorMessage(parsed, 500, '');
		expect(msg).toContain('Server error: internal failure');
		expect(msg).toContain('Check server logs');
	});

	it('formats unavailable_error', () => {
		const parsed: ParsedServerError = { message: 'Loading model', type: 'unavailable_error', code: 503 };
		const msg = formatServerErrorMessage(parsed, 503, '');
		expect(msg).toContain('Server is still loading');
	});

	it('formats not_supported_error with message', () => {
		const parsed: ParsedServerError = {
			message: 'Start it with `--embeddings`',
			type: 'not_supported_error',
			code: 501,
		};
		const msg = formatServerErrorMessage(parsed, 501, '');
		expect(msg).toContain('This feature is not supported');
		expect(msg).toContain('--embeddings');
	});

	it('formats permission_error', () => {
		const parsed: ParsedServerError = { message: 'access denied', type: 'permission_error', code: 403 };
		const msg = formatServerErrorMessage(parsed, 403, '');
		expect(msg).toContain('Permission denied: access denied');
	});

	it('uses fallback when parsed is null (5xx)', () => {
		const msg = formatServerErrorMessage(null, 500, 'Internal Server Error');
		expect(msg).toContain('Server error (500)');
		expect(msg).toContain('Internal Server Error');
	});

	it('uses fallback when parsed is null (4xx)', () => {
		const msg = formatServerErrorMessage(null, 404, 'Not Found');
		expect(msg).toContain('Request failed (404)');
		expect(msg).toContain('Not Found');
	});

	it('formats unknown type using message', () => {
		const parsed: ParsedServerError = { message: 'custom error', type: 'unknown_type', code: 418 };
		const msg = formatServerErrorMessage(parsed, 418, '');
		expect(msg).toContain('Request error: custom error');
	});
});
