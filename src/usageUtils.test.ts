import { describe, it, expect } from 'vitest';
import { normalizeStreamUsage } from './llamaClient';
import { OpenAIUsage, LlamaServerTimings } from './types';

describe('normalizeStreamUsage', () => {
	it('passes through a full usage object with clamping', () => {
		const usage: OpenAIUsage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			prompt_tokens_details: { cached_tokens: 30 },
		};
		const result = normalizeStreamUsage(usage, undefined);
		expect(result).toEqual({
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			prompt_tokens_details: { cached_tokens: 30 },
		});
	});

	it('clamps negative values in usage', () => {
		const usage: OpenAIUsage = {
			prompt_tokens: -1,
			completion_tokens: -5,
			total_tokens: -6,
		};
		const result = normalizeStreamUsage(usage, undefined);
		expect(result).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		});
	});

	it('computes total_tokens from prompt + completion when total is 0', () => {
		const usage: OpenAIUsage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 0,
		};
		const result = normalizeStreamUsage(usage, undefined);
		expect(result).toEqual({
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
		});
	});

	it('derives usage from timings when usage is absent', () => {
		const timings: LlamaServerTimings = {
			prompt_n: 10,
			cache_n: 90,
			predicted_n: 25,
		};
		const result = normalizeStreamUsage(undefined, timings);
		expect(result).toEqual({
			prompt_tokens: 100,
			completion_tokens: 25,
			total_tokens: 125,
		});
	});

	it('prefers usage over timings when both are present', () => {
		const usage: OpenAIUsage = {
			prompt_tokens: 200,
			completion_tokens: 80,
			total_tokens: 280,
		};
		const timings: LlamaServerTimings = {
			prompt_n: 10,
			cache_n: 5,
			predicted_n: 3,
		};
		const result = normalizeStreamUsage(usage, timings);
		expect(result?.prompt_tokens).toBe(200);
		expect(result?.completion_tokens).toBe(80);
	});

	it('uses fallbackPromptTokens when neither usage nor timings are present', () => {
		const result = normalizeStreamUsage(undefined, undefined, 500);
		expect(result).toEqual({
			prompt_tokens: 500,
			completion_tokens: 0,
			total_tokens: 500,
		});
	});

	it('returns undefined when all inputs are empty', () => {
		expect(normalizeStreamUsage(undefined, undefined)).toBeUndefined();
		expect(normalizeStreamUsage(undefined, undefined, 0)).toBeUndefined();
	});

	it('handles timings with only cache_n', () => {
		const timings: LlamaServerTimings = { cache_n: 50 };
		const result = normalizeStreamUsage(undefined, timings);
		expect(result).toEqual({
			prompt_tokens: 50,
			completion_tokens: 0,
			total_tokens: 50,
		});
	});

	it('returns undefined for all-zero timings', () => {
		const timings: LlamaServerTimings = { prompt_n: 0, cache_n: 0, predicted_n: 0 };
		expect(normalizeStreamUsage(undefined, timings)).toBeUndefined();
	});
});
