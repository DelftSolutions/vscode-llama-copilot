import { describe, it, expect } from 'vitest';
import { getPlatformAsset, getAssetFilename, getServerBinaryName, getCliBinaryName, isSupportedPlatform } from './platform';

describe('platform', () => {
	// Note: These tests verify the mapping logic. Actual platform values
	// depend on the test runner's OS, so we test the known combinations.

	describe('getAssetFilename', () => {
		it('produces correct filename for a build number', () => {
			// The actual suffix depends on the platform running the test,
			// so we just verify the pattern
			const filename = getAssetFilename('5000');
			expect(filename).toMatch(/^llama-b5000-bin-.+\.(tar\.gz|zip)$/);
		});
	});

	describe('getServerBinaryName', () => {
		it('returns platform-appropriate name', () => {
			const name = getServerBinaryName();
			if (process.platform === 'win32') {
				expect(name).toBe('llama-server.exe');
			} else {
				expect(name).toBe('llama-server');
			}
		});
	});

	describe('getCliBinaryName', () => {
		it('returns platform-appropriate name', () => {
			const name = getCliBinaryName();
			if (process.platform === 'win32') {
				expect(name).toBe('llama-cli.exe');
			} else {
				expect(name).toBe('llama-cli');
			}
		});
	});

	describe('isSupportedPlatform', () => {
		it('returns a boolean', () => {
			expect(typeof isSupportedPlatform()).toBe('boolean');
		});
	});
});
