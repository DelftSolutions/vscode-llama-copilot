import { describe, it, expect } from 'vitest';
import { getErrorCode, normalizeFetchError, isConnectionResetError, describeFetchError } from './errorUtils';

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

describe('isConnectionResetError', () => {
	it('returns true when error has code ECONNRESET', () => {
		const err = new Error('test') as Error & { code: string };
		err.code = 'ECONNRESET';
		expect(isConnectionResetError(err)).toBe(true);
	});

	it('returns true when cause has code ECONNRESET', () => {
		const err = new Error('fetch failed', { cause: { code: 'ECONNRESET' } } as never);
		expect(isConnectionResetError(err)).toBe(true);
	});

	it('returns false for other error codes', () => {
		expect(isConnectionResetError(new Error('x', { cause: { code: 'ECONNREFUSED' } } as never))).toBe(false);
		expect(isConnectionResetError(new Error('x', { cause: { code: 'ETIMEDOUT' } } as never))).toBe(false);
	});

	it('returns false when no code', () => {
		expect(isConnectionResetError(new Error('fetch failed'))).toBe(false);
	});

	it('returns false for non-Error', () => {
		expect(isConnectionResetError('string')).toBe(false);
		expect(isConnectionResetError(null)).toBe(false);
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
	});

	it('normalizes UND_ERR_BODY_TIMEOUT as timeout', () => {
		const err = new Error('Body timeout', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } } as never);
		const msg = normalizeFetchError(err);
		expect(msg).toContain('request timed out');
		expect(msg).toContain('Increase the extension Request timeout');
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

	it('includes cause message in generic fetch failed fallback', () => {
		const cause = Object.assign(new Error('connect ECONNABORTED 10.0.0.1:443'), { code: 'ECONNABORTED' });
		const err = new Error('fetch failed', { cause });
		const msg = normalizeFetchError(err)!;
		expect(msg).toContain('connect ECONNABORTED 10.0.0.1:443');
		expect(msg).toContain('Connection to the server failed');
	});

	it('treats error with cause as fetch error', () => {
		const err = new Error('other', { cause: new Error() });
		const msg = normalizeFetchError(err);
		expect(msg).toBeDefined();
	});
});

describe('describeFetchError', () => {
	it('extracts code, syscall, address, port from cause', () => {
		const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
			code: 'ECONNREFUSED',
			syscall: 'connect',
			address: '127.0.0.1',
			port: 8080,
		});
		const err = new Error('fetch failed', { cause });
		const details = describeFetchError(err);
		expect(details.code).toBe('ECONNREFUSED');
		expect(details.syscall).toBe('connect');
		expect(details.address).toBe('127.0.0.1');
		expect(details.port).toBe(8080);
		expect(details.causeMessage).toBe('connect ECONNREFUSED 127.0.0.1:8080');
		expect(details.formattedSummary).toContain('code=ECONNREFUSED');
		expect(details.formattedSummary).toContain('address=127.0.0.1');
		expect(details.formattedSummary).toContain('port=8080');
	});

	it('extracts hostname from cause', () => {
		const cause = Object.assign(new Error('getaddrinfo ENOTFOUND badhost.local'), {
			code: 'ENOTFOUND',
			hostname: 'badhost.local',
			syscall: 'getaddrinfo',
		});
		const err = new Error('fetch failed', { cause });
		const details = describeFetchError(err);
		expect(details.hostname).toBe('badhost.local');
		expect(details.formattedSummary).toContain('hostname=badhost.local');
	});

	it('walks nested causes (cause.cause)', () => {
		const inner = Object.assign(new Error('connect ECONNREFUSED ::1:8080'), {
			code: 'ECONNREFUSED',
			syscall: 'connect',
			address: '::1',
			port: 8080,
		});
		const middle = new Error('wrapper', { cause: inner });
		const outer = new Error('fetch failed', { cause: middle });
		const details = describeFetchError(outer);
		expect(details.code).toBe('ECONNREFUSED');
		expect(details.address).toBe('::1');
		expect(details.port).toBe(8080);
		expect(details.causeMessage).toBe('wrapper');
	});

	it('returns empty summary for non-fetch errors', () => {
		const err = new Error('something else');
		const details = describeFetchError(err);
		expect(details.formattedSummary).toBe('');
		expect(details.code).toBeUndefined();
	});

	it('returns cause message only when no system fields exist', () => {
		const cause = new Error('some network problem');
		const err = new Error('fetch failed', { cause });
		const details = describeFetchError(err);
		expect(details.causeMessage).toBe('some network problem');
		expect(details.formattedSummary).toBe('some network problem');
	});

	it('handles non-Error values gracefully', () => {
		expect(describeFetchError(null).formattedSummary).toBe('');
		expect(describeFetchError(undefined).formattedSummary).toBe('');
		expect(describeFetchError('string').formattedSummary).toBe('');
	});
});
