import { describe, it, expect } from 'vitest';
import { MODEL_PRESETS, validatePresetChains, getPresetById } from './presets';

describe('presets', () => {
	describe('validatePresetChains', () => {
		it('no deprecated preset has a deprecated successor (no deprecation chains)', () => {
			const errors = validatePresetChains();
			expect(errors).toEqual([]);
		});
	});

	describe('MODEL_PRESETS', () => {
		it('all presets have unique IDs', () => {
			const ids = MODEL_PRESETS.map(p => p.id);
			const unique = new Set(ids);
			expect(unique.size).toBe(ids.length);
		});

		it('all presets have non-empty iniLines', () => {
			for (const preset of MODEL_PRESETS) {
				expect(preset.iniLines.length).toBeGreaterThan(0);
			}
		});

		it('all presets have positive minRamMB', () => {
			for (const preset of MODEL_PRESETS) {
				expect(preset.minRamMB).toBeGreaterThan(0);
			}
		});

		it('all presets have a positive, unique qualityRank', () => {
			const ranks = MODEL_PRESETS.map(p => p.qualityRank);
			for (const preset of MODEL_PRESETS) {
				expect(preset.qualityRank).toBeGreaterThanOrEqual(1);
			}
			expect(new Set(ranks).size).toBe(ranks.length);
		});

		it('all presets have version >= 1', () => {
			for (const preset of MODEL_PRESETS) {
				expect(preset.version).toBeGreaterThanOrEqual(1);
			}
		});

		it('deprecated presets with successors reference existing presets', () => {
			for (const preset of MODEL_PRESETS) {
				if (preset.successor) {
					const successor = getPresetById(preset.successor);
					expect(successor).toBeDefined();
				}
			}
		});
	});

	describe('getPresetById', () => {
		it('returns a preset by id', () => {
			const preset = getPresetById('qwen3-4b');
			expect(preset).toBeDefined();
			expect(preset!.id).toBe('qwen3-4b');
		});

		it('returns undefined for unknown id', () => {
			expect(getPresetById('nonexistent')).toBeUndefined();
		});
	});
});
