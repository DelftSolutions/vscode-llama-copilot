import { describe, it, expect } from 'vitest';
import { MODEL_PRESETS, type ModelPreset } from '../server/presets';
import {
	recommendModel,
	formatHardwareLine,
	RAM_FIT_FRACTION,
} from './recommendation';

const GB = 1024;

describe('recommendModel', () => {
	it('16 GB RAM → Gemma 4 E4B (highest quality that fits 50% of 16 GB)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 40 * GB);
		expect(rec?.presetId).toBe('gemma-4-E4B-it:q4-128k');
		expect(rec?.reason).toContain('16 GB RAM');
	});

	it('32 GB RAM → Gemma 4 12B Q6 (highest quality under 16 GB limit)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 32 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('gemma-4-12B-it:q6-256k');
	});

	it('48 GB RAM → Gemma 4 26B-A4B Q4 (highest quality under 24 GB limit)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 48 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('gemma-4-26B-A4B-it:q4-256k');
	});

	it('96 GB RAM → Qwen 3.6 27B Q6 (dense 27B beats MoE 35B at this band)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 96 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('qwen-3.6-27b:q6-256k');
	});

	it('128 GB RAM → Qwen 3.6 27B BF16 (top of the single-slot ladder)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 128 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('qwen-3.6-27b:bf16-256k');
	});

	it('192 GB RAM → Qwen 3.6 27B BF16 p3 (subagent variant fits)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 192 * GB }, 400 * GB);
		expect(rec?.presetId).toBe('qwen-3.6-27b:bf16-256k-p3');
	});

	it('70 GB RAM → Gemma 4 26B-A4B Q4 p3 (subagent fits below 35B p1)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 70 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('gemma-4-26B-A4B-it:q4-256k-p3');
	});

	it('low RAM (4 GB) → null (nothing fits the 50% limit)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 4 * GB }, 100 * GB);
		expect(rec).toBeNull();
	});

	it('low free disk → null even when RAM is enough', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 2 * GB);
		expect(rec).toBeNull();
	});

	it('free disk below the 8 GB floor → null even when a model would fit', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 7 * GB);
		expect(rec).toBeNull();
	});

	it('unknown disk (null) → recommendation based on RAM only', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, null);
		expect(rec?.presetId).toBe('gemma-4-E4B-it:q4-128k');
	});

	it('excludes deprecated presets even when they fit', () => {
		const presets: readonly ModelPreset[] = [
			...MODEL_PRESETS,
			{
				id: 'legacy-huge-model',
				displayName: 'Legacy Huge Model',
				minRamMB: 1024,
				qualityRank: 999,
				iniLines: ['hf = example/legacy'],
				version: 1,
				deprecated: true,
				successor: 'qwen-3.5-2b:q4-128k',
			},
		];
		const rec = recommendModel(presets, { systemRamMB: 16 * GB }, 40 * GB);
		expect(rec?.presetId).toBe('gemma-4-E4B-it:q4-128k');
	});

	it('uses RAM_FIT_FRACTION of total RAM as the limit', () => {
		// 4096 MB (Qwen 3.5 2B Q4 min) fits exactly at 50% of 8192 MB
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 8192 }, 40 * GB);
		expect(rec?.presetId).toBe('qwen-3.5-2b:q4-128k');
		// Just below the limit: nothing fits
		expect(recommendModel(MODEL_PRESETS, { systemRamMB: 8191 }, 40 * GB)).toBeNull();
	});
});

describe('formatHardwareLine', () => {
	it('formats all parts', () => {
		expect(formatHardwareLine('M3 Pro', 18 * GB, 40 * GB)).toBe('M3 Pro · 18 GB RAM · 40 GB free disk');
	});

	it('omits unknown CPU', () => {
		expect(formatHardwareLine(null, 16 * GB, 40 * GB)).toBe('16 GB RAM · 40 GB free disk');
	});

	it('omits unknown disk', () => {
		expect(formatHardwareLine('M3 Pro', 16 * GB, null)).toBe('M3 Pro · 16 GB RAM');
	});

	it('rounds to whole GB', () => {
		expect(formatHardwareLine(null, 16500, 40960)).toBe('16 GB RAM · 40 GB free disk');
	});

	it('returns empty string when everything is unknown', () => {
		expect(formatHardwareLine(null, 0, null)).toBe('');
	});
});
