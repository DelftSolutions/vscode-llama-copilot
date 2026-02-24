/** Error with optional cause (Node/undici) */
export interface ErrorWithCause extends Error {
	cause?: unknown;
	code?: string;
}

/**
 * Get the system error code from an error or its cause (Node/undici).
 * Checks the error itself, then cause, then cause.cause for serialized or wrapped errors.
 */
export function getErrorCode(error: unknown): string | undefined {
	for (let current: unknown = error; current && typeof current === 'object'; current = (current as { cause?: unknown }).cause) {
		if ('code' in current && typeof (current as { code: unknown }).code === 'string') {
			return (current as { code: string }).code;
		}
	}
	return undefined;
}

/**
 * Normalize fetch/network errors into a user-friendly message.
 * Returns undefined if the error is not a network/fetch error (caller should rethrow original).
 */
export function normalizeFetchError(error: unknown, requestUrl?: string): string | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}
	const err = error as ErrorWithCause;
	const isFetchError =
		err.message.includes('fetch failed') ||
		err.message.includes('Failed to fetch') ||
		err.cause !== undefined;
	if (!isFetchError) {
		return undefined;
	}

	const code = getErrorCode(error);
	const urlSuffix = requestUrl ? ` Request URL: ${requestUrl}.` : '';
	const rawMessage = (err.message || String(error)).trim();

	// Timeout errors: our request timeout (extension setting) was exceeded. Suggest increasing it first, then server --timeout.
	const isTimeout =
		code === 'ETIMEDOUT' ||
		code === 'UND_ERR_BODY_TIMEOUT' ||
		code === 'UND_ERR_HEADERS_TIMEOUT' ||
		code === 'UND_ERR_CONNECT_TIMEOUT' ||
		/timeout/i.test(rawMessage);
	if (isTimeout) {
		return `The request timed out. Increase the extension Request timeout (Settings → Llama Copilot).`;
	}

	switch (code) {
		case 'ECONNREFUSED':
			return `Cannot connect to the server. Is llama-server running?${urlSuffix}`;
		case 'ENOTFOUND':
			return `Host could not be found. Check the server URL and network.${urlSuffix}`;
		case 'ECONNRESET':
			return `Connection was reset. The server may have closed the connection.${urlSuffix}`;
		default:
			if (/fetch\s+failed/i.test(rawMessage) || /Failed\s+to\s+fetch/i.test(rawMessage)) {
				return `Connection to the server failed. Check the URL and that llama-server is running.${urlSuffix}`;
			}
			return `Network error: ${rawMessage || 'Unknown error'}.${urlSuffix}`;
	}
}
