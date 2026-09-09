import { describe, it, expect } from 'vitest';
import { classifySetupError } from './errorCategorizer';

function errorWithCode(message: string, code: string): Error {
	const err = new Error(message);
	(err as { cause?: { code?: string } }).cause = { code };
	return err;
}

describe('classifySetupError', () => {
	describe('network', () => {
		it('classifies ENOTFOUND (via cause chain) as network', () => {
			const result = classifySetupError(errorWithCode('fetch failed', 'ENOTFOUND'));
			expect(result.kind).toBe('network');
			expect(result.title).toContain('Network');
			expect(result.retryable).toBe(true);
		});

		it('classifies ECONNRESET as network', () => {
			const result = classifySetupError(errorWithCode('fetch failed', 'ECONNRESET'));
			expect(result.kind).toBe('network');
		});

		it('classifies ETIMEDOUT as network', () => {
			const result = classifySetupError(errorWithCode('connect ETIMEDOUT 140.82.112.3:443', 'ETIMEDOUT'));
			expect(result.kind).toBe('network');
		});

		it('classifies undici timeout codes as network', () => {
			const result = classifySetupError(errorWithCode('fetch failed', 'UND_ERR_CONNECT_TIMEOUT'));
			expect(result.kind).toBe('network');
		});

		it('classifies generic fetch-failed messages as network', () => {
			const result = classifySetupError(new Error('fetch failed'));
			expect(result.kind).toBe('network');
		});

		it('classifies "Network error: ..." messages as network', () => {
			const result = classifySetupError(new Error('Network error: could not reach GitHub'));
			expect(result.kind).toBe('network');
		});

		it('classifies download-stalled errors as network', () => {
			const result = classifySetupError(
				new Error('Download stalled: no data received for 60s. Check your internet connection, proxy, or firewall.')
			);
			expect(result.kind).toBe('network');
		});
	});

	describe('disk', () => {
		it('classifies ENOSPC as disk', () => {
			const result = classifySetupError(errorWithCode('write ENOSPC', 'ENOSPC'));
			expect(result.kind).toBe('disk');
			expect(result.title).toContain('disk space');
		});
	});

	describe('port', () => {
		it('classifies EADDRINUSE as port conflict', () => {
			const result = classifySetupError(errorWithCode('listen EADDRINUSE', 'EADDRINUSE'));
			expect(result.kind).toBe('port');
			expect(result.detail).toContain('Port');
		});

		it('classifies "address already in use" messages as port conflict', () => {
			const result = classifySetupError(new Error('bind: address already in use'));
			expect(result.kind).toBe('port');
		});
	});

	describe('http', () => {
		it('classifies HTTP 404 as release-not-found', () => {
			const result = classifySetupError(new Error('Download failed: HTTP 404 for https://github.com/...'));
			expect(result.kind).toBe('http');
			expect(result.title).toContain('not found');
		});

		it('includes the attempted URL in the 404 detail and drops the transient hint', () => {
			const url = 'https://github.com/ggml-org/llama.cpp/releases/download/bv0.4.0/llama-bv0.4.0-bin-macos-arm64.tar.gz';
			const result = classifySetupError(new Error(`Download failed: HTTP 404 for ${url}`));
			expect(result.kind).toBe('http');
			expect(result.detail).toContain(url);
			expect(result.detail).not.toContain('may have just moved');
		});

		it('classifies HTTP 429 as rate limit', () => {
			const result = classifySetupError(new Error('Download failed: HTTP 429'));
			expect(result.kind).toBe('http');
			expect(result.title).toContain('rate limit');
		});

		it('classifies HTTP 500 as GitHub-side issue', () => {
			const result = classifySetupError(new Error('Download failed: HTTP 503'));
			expect(result.kind).toBe('http');
			expect(result.title).toContain('GitHub');
		});
	});

	describe('quarantine / permission', () => {
		it('classifies quarantine-mentioning errors as quarantine', () => {
			const result = classifySetupError(
				new Error('Failed to clear macOS quarantine on downloaded binaries: Operation not permitted')
			);
			expect(result.kind).toBe('quarantine');
			expect(result.detail).toContain('Privacy & Security');
		});

		it('classifies EACCES (non-macOS) as permission', () => {
			if (process.platform === 'darwin') return; // darwin maps EACCES to quarantine
			const result = classifySetupError(errorWithCode('open EACCES', 'EACCES'));
			expect(result.kind).toBe('permission');
		});
	});

	describe('unknown', () => {
		it('falls back to unknown for unrecognized errors', () => {
			const result = classifySetupError(new Error('something bizarre happened'));
			expect(result.kind).toBe('unknown');
			expect(result.detail).toBe('something bizarre happened');
			expect(result.retryable).toBe(true);
		});

		it('handles non-Error values', () => {
			const result = classifySetupError('plain string failure');
			expect(result.kind).toBe('unknown');
			expect(result.detail).toBe('plain string failure');
		});

		it('gives a generic detail for empty messages', () => {
			const result = classifySetupError(new Error(''));
			expect(result.detail).not.toBe('');
		});
	});

	it('port takes precedence over network in combined messages', () => {
		const result = classifySetupError(errorWithCode('connect ECONNREFUSED ... address already in use', 'ECONNREFUSED'));
		expect(result.kind).toBe('port');
	});
});
