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

		it('every non-deprecated 256k preset has a -p3 twin with parallel=3 and ctx-size=786432', () => {
			const kept256k = MODEL_PRESETS.filter(
				p => !p.deprecated && p.id.includes('256k') && !p.id.endsWith('-p3')
			);
			for (const p1 of kept256k) {
				const p3 = getPresetById(p1.id + '-p3');
				expect(p3, `missing -p3 twin for ${p1.id}`).toBeDefined();
				expect(p3!.deprecated).toBeUndefined();
				expect(p3!.iniLines).toContain('parallel = 3');
				expect(p3!.iniLines).toContain('ctx-size = 786432');
			}
		});
	});

	describe('getPresetById', () => {
		it('returns a preset by id', () => {
			const preset = getPresetById('qwen-3.5-2b:q4-128k');
			expect(preset).toBeDefined();
			expect(preset!.id).toBe('qwen-3.5-2b:q4-128k');
		});

		it('returns undefined for unknown id', () => {
			expect(getPresetById('nonexistent')).toBeUndefined();
		});
	});
});
