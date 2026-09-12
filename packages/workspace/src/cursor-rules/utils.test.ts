import { describe, it, expect } from 'vitest';
import { normalizeRuleName } from './utils';

describe('normalizeRuleName', () => {
	it('strips rule: prefix', () => {
		expect(normalizeRuleName('rule:style-guidelines.mdc')).toBe('style-guidelines.mdc');
	});

	it('trims whitespace', () => {
		expect(normalizeRuleName('  rule:foo  ')).toBe('foo');
	});

	it('leaves name without prefix unchanged (except trim)', () => {
		expect(normalizeRuleName('coding-guidelines.md')).toBe('coding-guidelines.md');
	});

	it('handles empty string', () => {
		expect(normalizeRuleName('')).toBe('');
	});
});
