import { describe, it, expect } from 'vitest';
import { globToRegex, matchesGlob, matchesAnyGlob, extractFilePathFromAttachment } from './globMatcher';

describe('globToRegex', () => {
	it('matches exact path', () => {
		const re = globToRegex('src/foo.ts');
		expect(re.test('src/foo.ts')).toBe(true);
		expect(re.test('src/foo.js')).toBe(false);
	});

	it('matches single wildcard', () => {
		const re = globToRegex('src/*.ts');
		expect(re.test('src/foo.ts')).toBe(true);
		expect(re.test('src/bar.ts')).toBe(true);
		expect(re.test('src/a/b.ts')).toBe(false);
	});

	it('matches double wildcard across path segments', () => {
		const re = globToRegex('src/**/*.ts');
		expect(re.test('src/a/b.ts')).toBe(true);
		expect(re.test('src/sub/foo.ts')).toBe(true);
	});
});

describe('matchesGlob', () => {
	it('returns true when path matches', () => {
		expect(matchesGlob('src/logger.ts', '**/*.ts')).toBe(true);
		expect(matchesGlob('src/logger.ts', 'src/*.ts')).toBe(true);
	});

	it('returns false when path does not match', () => {
		expect(matchesGlob('src/logger.js', '**/*.ts')).toBe(false);
	});

	it('normalizes backslashes', () => {
		expect(matchesGlob('src\\logger.ts', 'src/*.ts')).toBe(true);
	});
});

describe('matchesAnyGlob', () => {
	it('returns true if any glob matches', () => {
		expect(matchesAnyGlob('src/foo.ts', ['*.js', '**/*.ts'])).toBe(true);
	});

	it('returns false if none match', () => {
		expect(matchesAnyGlob('src/foo.ts', ['*.js', 'lib/**'])).toBe(false);
	});
});

describe('extractFilePathFromAttachment', () => {
	it('extracts path from @path:line', () => {
		expect(extractFilePathFromAttachment('@src/logger.ts:32')).toBe('src/logger.ts');
	});

	it('extracts path from @path', () => {
		expect(extractFilePathFromAttachment('@src/foo.ts')).toBe('src/foo.ts');
	});

	it('returns null for invalid format', () => {
		expect(extractFilePathFromAttachment('src/foo.ts')).toBeNull();
	});
});
