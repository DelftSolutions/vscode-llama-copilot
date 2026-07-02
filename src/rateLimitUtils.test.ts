import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	parseRetryAfterMs,
	isRateLimitResponse,
	computeRateLimitDelayMs,
} from './rateLimitUtils';

describe('parseRetryAfterMs', () => {
	it('returns undefined for null or empty input', () => {
		expect(parseRetryAfterMs(null)).toBeUndefined();
		expect(parseRetryAfterMs('')).toBeUndefined();
		expect(parseRetryAfterMs('   ')).toBeUndefined();
	});

	it('parses integer seconds', () => {
		expect(parseRetryAfterMs('120')).toBe(120_000);
		expect(parseRetryAfterMs('0')).toBe(0);
		expect(parseRetryAfterMs('1')).toBe(1000);
	});

	it('parses fractional seconds (rounds up)', () => {
		expect(parseRetryAfterMs('1.5')).toBe(1500);
		expect(parseRetryAfterMs('0.1')).toBe(100);
	});

	it('parses HTTP-date format', () => {
		const futureDate = new Date(Date.now() + 60_000).toUTCString();
		const result = parseRetryAfterMs(futureDate);
		expect(result).toBeDefined();
		expect(result!).toBeGreaterThan(50_000);
		expect(result!).toBeLessThanOrEqual(60_000);
	});

	it('returns 0 for a past HTTP-date', () => {
		const pastDate = new Date(Date.now() - 10_000).toUTCString();
		expect(parseRetryAfterMs(pastDate)).toBe(0);
	});

	it('returns undefined for garbage input', () => {
		expect(parseRetryAfterMs('not-a-number-or-date')).toBeUndefined();
	});

	it('treats negative seconds as 0 (retry immediately)', () => {
		expect(parseRetryAfterMs('-5')).toBe(0);
	});
});

describe('isRateLimitResponse', () => {
	it('returns true for status 429', () => {
		expect(isRateLimitResponse(429)).toBe(true);
		expect(isRateLimitResponse(429, null)).toBe(true);
	});

	it('returns true for rate_limit_error type', () => {
		expect(isRateLimitResponse(200, { message: 'x', type: 'rate_limit_error' })).toBe(true);
	});

	it('returns false for other statuses and types', () => {
		expect(isRateLimitResponse(500)).toBe(false);
		expect(isRateLimitResponse(400, { message: 'x', type: 'invalid_request_error' })).toBe(false);
		expect(isRateLimitResponse(200, null)).toBe(false);
	});
});

describe('computeRateLimitDelayMs', () => {
	it('uses Retry-After header when present', () => {
		expect(computeRateLimitDelayMs(0, '5', 1000)).toBe(5000);
		expect(computeRateLimitDelayMs(3, '2', 1000)).toBe(2000);
	});

	it('falls back to exponential backoff without header', () => {
		expect(computeRateLimitDelayMs(0, null, 1000)).toBe(1000);
		expect(computeRateLimitDelayMs(1, null, 1000)).toBe(2000);
		expect(computeRateLimitDelayMs(2, null, 1000)).toBe(4000);
		expect(computeRateLimitDelayMs(3, null, 1000)).toBe(8000);
	});

	it('uses default base delay', () => {
		expect(computeRateLimitDelayMs(0, null)).toBe(1000);
		expect(computeRateLimitDelayMs(1, null)).toBe(2000);
	});
});
