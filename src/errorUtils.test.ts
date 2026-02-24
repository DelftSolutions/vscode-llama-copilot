import { describe, it, expect } from 'vitest';
import { getErrorCode, normalizeFetchError } from './errorUtils';

describe('getErrorCode', () => {
	it('returns code from error', () => {
		const err = new Error('test') as Error & { code: string };
		err.code = 'ECONNREFUSED';
		expect(getErrorCode(err)).toBe('ECONNREFUSED');
	});

	it('returns code from cause', () => {
		const cause = new Error() as Error & { code: string };
		cause.code = 'ENOTFOUND';
		const err = new Error('fetch failed', { cause });
		expect(getErrorCode(err)).toBe('ENOTFOUND');
	});

	it('returns undefined when no code', () => {
		expect(getErrorCode(new Error('x'))).toBeUndefined();
	});
});

describe('normalizeFetchError', () => {
	it('returns undefined for non-Error', () => {
		expect(normalizeFetchError('string')).toBeUndefined();
		expect(normalizeFetchError(null)).toBeUndefined();
	});

	it('returns undefined when message is not fetch-related and no cause', () => {
		expect(normalizeFetchError(new Error('something else'))).toBeUndefined();
	});

	it('normalizes ECONNREFUSED', () => {
		const err = new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } } as never);
		const msg = normalizeFetchError(err);
		expect(msg).toContain('Cannot connect to the server');
		expect(msg).toContain('llama-server running');
	});

	it('appends request URL when provided', () => {
		const err = new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } } as never);
		const msg = normalizeFetchError(err, 'http://localhost:8013');
		expect(msg).toContain('Request URL: http://localhost:8013');
	});

	it('normalizes ENOTFOUND', () => {
		const err = new Error('fetch failed', { cause: { code: 'ENOTFOUND' } } as never);
		expect(normalizeFetchError(err)).toContain('Host could not be found');
	});

	it('normalizes ETIMEDOUT', () => {
		const err = new Error('fetch failed', { cause: { code: 'ETIMEDOUT' } } as never);
		const msg = normalizeFetchError(err);
		expect(msg).toContain('request timed out');
		expect(msg).toContain('Increase the extension Request timeout');
		expect(msg).toContain('Settings → Llama Copilot');
		expect(msg).toContain('--timeout');
	});

	it('normalizes UND_ERR_BODY_TIMEOUT as timeout', () => {
		const err = new Error('Body timeout', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } } as never);
		const msg = normalizeFetchError(err);
		expect(msg).toContain('request timed out');
		expect(msg).toContain('--timeout');
	});

	it('treats message containing "timeout" as timeout', () => {
		const err = new Error('fetch failed: headers timeout', { cause: new Error() });
		const msg = normalizeFetchError(err);
		expect(msg).toContain('request timed out');
	});

	it('normalizes ECONNRESET', () => {
		const err = new Error('fetch failed', { cause: { code: 'ECONNRESET' } } as never);
		expect(normalizeFetchError(err)).toContain('Connection was reset');
	});

	it('normalizes generic fetch failed message', () => {
		const err = new Error('fetch failed');
		const msg = normalizeFetchError(err);
		expect(msg).toContain('Connection to the server failed');
	});

	it('treats error with cause as fetch error', () => {
		const err = new Error('other', { cause: new Error() });
		const msg = normalizeFetchError(err);
		expect(msg).toBeDefined();
	});
});
