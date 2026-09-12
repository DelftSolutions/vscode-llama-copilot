/**
 * Categorizes setup errors (binary download / server startup) into
 * actionable, user-facing messages. The onboarding spec requires surfacing
 * the actual cause (network vs disk vs quarantine vs port), not a one-liner.
 * Pure (no vscode imports) so it is unit-testable.
 */

import { getErrorCode } from '@llama-copilot/shared';

export type SetupErrorKind =
	| 'network'
	| 'http'
	| 'disk'
	| 'permission'
	| 'quarantine'
	| 'port'
	| 'unknown';

export interface ClassifiedSetupError {
	kind: SetupErrorKind;
	title: string;
	detail: string;
	retryable: boolean;
}

const NETWORK_CODES = new Set([
	'ENOTFOUND',
	'ECONNREFUSED',
	'ECONNRESET',
	'ECONNABORTED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'EPIPE',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_SOCKET',
]);

/**
 * Classify an error from the setup flow into a user-facing cause + guidance.
 */
export function classifySetupError(error: unknown): ClassifiedSetupError {
	const message = error instanceof Error ? error.message : String(error);
	const code = getErrorCode(error);

	if (code === 'EADDRINUSE' || /address already in use/i.test(message)) {
		return {
			kind: 'port',
			title: 'Port is already in use',
			detail:
				'Another process is listening on the llama-server port. Stop that process, ' +
				'or change the port in Settings → Llama Copilot → Server → Port, then retry.',
			retryable: true,
		};
	}

	if (code === 'ENOSPC') {
		return {
			kind: 'disk',
			title: 'Not enough disk space',
			detail:
				'There is not enough free disk space to download llama-server and the model. ' +
				'Free up space and try again.',
			retryable: true,
		};
	}

	if (/quarantine/i.test(`${message} ${code ?? ''}`)) {
		return {
			kind: 'quarantine',
			title: 'macOS blocked the downloaded binary',
			detail:
				'macOS Gatekeeper quarantined the binary. Try again — if it keeps happening, ' +
				'allow the app in System Settings → Privacy & Security.',
			retryable: true,
		};
	}

	if (process.platform === 'darwin' && (code === 'EPERM' || code === 'EACCES')) {
		return {
			kind: 'quarantine',
			title: 'macOS is blocking the binary',
			detail:
				'macOS may be blocking the downloaded binary (Gatekeeper/quarantine). Try again — ' +
				'if it persists, open System Settings → Privacy & Security and allow it.',
			retryable: true,
		};
	}

	if (code === 'EACCES' || code === 'EPERM') {
		return {
			kind: 'permission',
			title: 'Permission denied',
			detail:
				'The extension does not have permission to write the downloaded files. ' +
				'Check the folder permissions and try again.',
			retryable: true,
		};
	}

	const httpMatch = message.match(/HTTP (\d{3})/);
	if (httpMatch) {
		const status = Number(httpMatch[1]);
		if (status === 404) {
			const urlMatch = message.match(/(https?:\/\/\S+)/);
			return {
				kind: 'http',
				title: 'Release not found on GitHub',
				detail:
					'The requested llama-server file does not exist on GitHub -- this is not transient, so retrying alone will not help. ' +
					(urlMatch ? `Attempted URL: ${urlMatch[1]}. ` : '') +
					'If you are behind a proxy or firewall, make sure it can reach github.com. ' +
					'Full details are in the "Llama Server API" output channel.',
				retryable: true,
			};
		}
		if (status === 403 || status === 429) {
			return {
				kind: 'http',
				title: 'GitHub rate limit reached',
				detail: 'GitHub is throttling requests. Wait a minute or two and try again.',
				retryable: true,
			};
		}
		if (status >= 500) {
			return {
				kind: 'http',
				title: 'GitHub is having issues',
				detail: `GitHub returned an error (HTTP ${status}). Wait a bit and try again.`,
				retryable: true,
			};
		}
		return {
			kind: 'http',
			title: `Download failed (HTTP ${status})`,
			detail: message,
			retryable: true,
		};
	}

	if (code !== undefined && NETWORK_CODES.has(code)) {
		return {
			kind: 'network',
			title: 'Network problem',
			detail:
				`Could not reach GitHub (${code}). Check your internet connection, ` +
				'proxy, or firewall, then try again.',
			retryable: true,
		};
	}

	if (/fetch failed|Failed to fetch|network error|Download stalled/i.test(message)) {
		return {
			kind: 'network',
			title: 'Network problem',
			detail:
				'Could not reach GitHub. Check your internet connection, proxy, or firewall, ' +
				'then try again.',
			retryable: true,
		};
	}

	return {
		kind: 'unknown',
		title: 'Something went wrong',
		detail: message || 'An unexpected error occurred during setup.',
		retryable: true,
	};
}
