import { describe, it, expect } from 'vitest';
import { MODEL_PRESETS, type ModelPreset } from '../server/presets';
import {
	recommendModel,
	formatHardwareLine,
	RAM_FIT_FRACTION,
} from './recommendation';

const GB = 1024;

describe('recommendModel', () => {
	it('16 GB RAM → Qwen 3 4B (matches the onboarding sketch)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 40 * GB);
		expect(rec?.presetId).toBe('qwen3-4b');
		expect(rec?.reason).toContain('16 GB RAM');
	});

	it('18 GB RAM → Qwen 3 4B (matches the onboarding sketch)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 18 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('qwen3-4b');
	});

	it('32 GB RAM → GLM 4.7 Flash (highest quality under the 50% RAM limit)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 32 * GB }, 200 * GB);
		expect(rec?.presetId).toBe('glm-4-7-flash');
	});

	it('64 GB RAM → Gemma 3 27B IT', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 64 * GB }, 500 * GB);
		expect(rec?.presetId).toBe('gemma3-27b-it');
	});

	it('128 GB RAM → still the highest-ranked preset that fits (Nemotron 30B fits at this size)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 128 * GB }, 500 * GB);
		// 50% of 128 GB = 64 GB → Nemotron (64 GB) becomes a candidate,
		// but Gemma 3 27B has the highest qualityRank.
		expect(rec?.presetId).toBe('gemma3-27b-it');
	});

	it('low RAM (8 GB) → null (nothing fits the 50% limit)', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 8 * GB }, 100 * GB);
		expect(rec).toBeNull();
	});

	it('low free disk → null even when RAM is enough', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 4 * GB);
		expect(rec).toBeNull();
	});

	it('free disk below the 8 GB floor → null even when a model would fit', () => {
		// 7 GB free: the 4B models (~5 GB) would fit, but the safety floor blocks it.
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 7 * GB);
		expect(rec).toBeNull();
	});

	it('unknown disk (null) → recommendation based on RAM only', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, null);
		expect(rec?.presetId).toBe('qwen3-4b');
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
				successor: 'qwen3-4b',
			},
		];
		const rec = recommendModel(presets, { systemRamMB: 16 * GB }, 40 * GB);
		expect(rec?.presetId).toBe('qwen3-4b');
	});

	it('prefers quality over speed among fitting candidates', () => {
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 16 * GB }, 40 * GB);
		// Both Qwen 3 4B (rank 2) and Gemma 3 4B (rank 1) fit; Qwen wins.
		expect(rec?.presetId).toBe('qwen3-4b');
	});

	it('uses RAM_FIT_FRACTION of total RAM as the limit', () => {
		// 5120 MB (Qwen 3 4B min) fits exactly at 50% of 10240 MB
		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: 10240 }, 40 * GB);
		expect(rec?.presetId).toBe('qwen3-4b');
		// Just below the limit: nothing fits
		expect(recommendModel(MODEL_PRESETS, { systemRamMB: 10239 }, 40 * GB)).toBeNull();
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
