import type { ParsedServerError } from './serverErrorUtils';

export const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 8;
export const RATE_LIMIT_RETRY_BASE_DELAY_MS = 1000;

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds ("120") and HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT") per RFC 7231.
 * Returns undefined if the header is missing, empty, or unparseable.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) {
		return undefined;
	}
	const trimmed = header.trim();
	if (!trimmed) {
		return undefined;
	}

	const seconds = Number(trimmed);
	if (!isNaN(seconds) && seconds >= 0) {
		return Math.ceil(seconds * 1000);
	}

	const date = Date.parse(trimmed);
	if (!isNaN(date)) {
		const deltaMs = date - Date.now();
		return deltaMs > 0 ? deltaMs : 0;
	}

	return undefined;
}

/**
 * True when the HTTP response indicates rate limiting (status 429 or error type rate_limit_error).
 */
export function isRateLimitResponse(status: number, parsed?: ParsedServerError | null): boolean {
	return status === 429 || parsed?.type === 'rate_limit_error';
}

/**
 * Compute the delay before the next retry attempt.
 * Prefers Retry-After header when present; otherwise uses exponential backoff.
 */
export function computeRateLimitDelayMs(
	attempt: number,
	retryAfterHeader: string | null,
	baseDelayMs: number = RATE_LIMIT_RETRY_BASE_DELAY_MS
): number {
	const fromHeader = parseRetryAfterMs(retryAfterHeader);
	if (fromHeader !== undefined) {
		return fromHeader;
	}
	return baseDelayMs * Math.pow(2, attempt);
}
