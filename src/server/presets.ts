/**
 * Built-in model preset definitions for the Models Manager.
 * Each preset defines a model configuration that can be toggled on/off
 * in the managed models.ini.
 */

export interface ModelPreset {
	/** Unique identifier used as the ini section name */
	id: string;
	/** Human-readable display name */
	displayName: string;
	/** Minimum system RAM (MB) needed to run this model */
	minRamMB: number;
	/**
	 * Relative model quality (higher = better). Used by the onboarding
	 * recommendation to prefer quality over raw speed when picking a model
	 * that fits the machine.
	 */
	qualityRank: number;
	/** INI config lines (without section header or tracking comment) */
	iniLines: string[];
	/** Version number -- bumped when we change the preset config */
	version: number;
	/** If true, hidden from UI unless currently active in models.ini */
	deprecated?: true;
	/** ID of the replacement preset when deprecated (must not itself be deprecated) */
	successor?: string;
}

/**
 * All built-in model presets.
 * Order determines display order in the Models Manager UI.
 */
export const MODEL_PRESETS: readonly ModelPreset[] = [
	{
		id: 'qwen3-4b',
		displayName: 'Qwen 3 4B (Q8)',
		minRamMB: 5120,
		qualityRank: 2,
		version: 1,
		iniLines: [
			'jinja = true',
			'ctx-size = 32768',
			'temp = 0.6',
			'min-p = 0.0',
			'top-p = 0.95',
			'top-k = 20',
			'hf = unsloth/Qwen3-4B-128K-GGUF:Q8_K_XL',
		],
	},
	{
		id: 'glm-4.5-air-5bit',
		displayName: 'GLM 4.5 AIR (Q5)',
		qualityRank: 3,
		minRamMB: 10240,
		version: 1,
		iniLines: [
			'jinja = true',
			'ctx-size = 0',
			'temp = 0.6',
			'top-p = 0.95',
			'fit = on',
			'hf = unsloth/GLM-4.5-AIR-GGUF:Q5_K_XL',
		],
	},
	{
		id: 'nemotron-3-nano-30b',
		displayName: 'Nemotron 3 Nano 30B (BF16)',
		qualityRank: 6,
		minRamMB: 65536,
		version: 1,
		iniLines: [
			'jinja = true',
			'ctx-size = 256000',
			'temp = 1.0',
			'top-p = 1.00',
			'fit = on',
			'hf = unsloth/Nemotron-3-Nano-30B-A3B-GGUF:BF16',
			'stop-timeout = 120',
		],
	},
	{
		id: 'glm-4-7-flash',
		qualityRank: 4,
		displayName: 'GLM 4.7 Flash (BF16)',
		minRamMB: 16384,
		version: 1,
		iniLines: [
			'jinja = true',
			'ctx-size = 202752',
			'temp = 0.7',
			'top-p = 1.0',
			'min-p = 0.01',
			'repeat-penalty = 1.0',
			'hf = unsloth/GLM-4.7-Flash-GGUF:BF16',
			'stop-timeout = 120',
		],
	},
	{
		qualityRank: 5,
		id: 'qwen3-30b-a3b',
		displayName: 'Qwen 3 30B-A3B (Q5)',
		minRamMB: 24576,
		version: 1,
		iniLines: [
			'jinja = true',
			'ctx-size = 0',
			'temp = 0.6',
			'top-p = 0.95',
			'top-k = 20',
			'min-p = 0.0',
			'fit = on',
			'hf = unsloth/Qwen3-30B-A3B-GGUF:Q5_K_XL',
			'stop-timeout = 120',
		],
	},

];

/**
 * Get a preset by ID.
 */
export function getPresetById(id: string): ModelPreset | undefined {
	return MODEL_PRESETS.find(p => p.id === id);
}

/**
 * Validate that no deprecated preset's successor is also deprecated.
 * Used in tests as a compile-time assertion.
 */
export function validatePresetChains(): string[] {
	const errors: string[] = [];
	for (const preset of MODEL_PRESETS) {
		if (preset.deprecated && preset.successor) {
			const successor = getPresetById(preset.successor);
			if (!successor) {
				errors.push(`Preset "${preset.id}" has successor "${preset.successor}" which does not exist.`);
			} else if (successor.deprecated) {
				errors.push(`Preset "${preset.id}" has successor "${preset.successor}" which is also deprecated (deprecation chain).`);
			}
		}
	}
	return errors;
}
