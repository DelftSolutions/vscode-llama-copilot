import { describe, it, expect } from 'vitest';
import { levenshteinDistance, findClosestMatch } from './levenshtein';

describe('levenshteinDistance', () => {
	it('returns 0 for equal strings', () => {
		expect(levenshteinDistance('foo', 'foo')).toBe(0);
	});

	it('returns 1 for single insertion', () => {
		expect(levenshteinDistance('foo', 'fooo')).toBe(1);
	});

	it('returns 1 for single deletion', () => {
		expect(levenshteinDistance('foo', 'fo')).toBe(1);
	});

	it('returns 1 for single substitution', () => {
		expect(levenshteinDistance('foo', 'foe')).toBe(1);
	});

	it('is case-insensitive', () => {
		expect(levenshteinDistance('Foo', 'foo')).toBe(0);
	});

	it('returns full length when other string is empty', () => {
		expect(levenshteinDistance('hello', '')).toBe(5);
	});
});

describe('findClosestMatch', () => {
	it('returns exact match', () => {
		expect(findClosestMatch('bar', ['foo', 'bar', 'baz'], 8)).toBe('bar');
	});

	it('returns closest within max distance', () => {
		expect(findClosestMatch('baar', ['foo', 'bar', 'baz'], 8)).toBe('bar');
	});

	it('returns null when no match within distance', () => {
		expect(findClosestMatch('xyz', ['foo', 'bar'], 2)).toBeNull();
	});

	it('returns null for empty candidates', () => {
		expect(findClosestMatch('bar', [], 8)).toBeNull();
	});

	it('uses default max distance when not provided', () => {
		expect(findClosestMatch('bar', ['bar'])).toBe('bar');
	});
});
