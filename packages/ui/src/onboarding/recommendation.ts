/**
 * Model recommendation logic for the onboarding wizard.
 * Pure functions (no vscode imports) so they are trivially unit-testable.
 */

import type { ModelPreset } from '../server/presets.js';
import type { SystemInfo } from '../server/deviceQuery.js';

/**
 * Fraction of total system RAM a model's RAM requirement may use.
 * Leaves headroom for the OS and other apps (matches the Models Manager gating spirit).
 */
export const RAM_FIT_FRACTION = 0.5;

/**
 * Absolute floor on free disk (MB) before any model is recommended — covers
 * the llama-server binary plus a small model with headroom. On top of this,
 * each candidate's minRamMB (a conservative proxy for its on-disk size) must
 * also fit in the free space.
 */
export const MIN_FREE_DISK_MB = 8192;

export interface ModelRecommendation {
	presetId: string;
	reason: string;
}

/**
 * Pick the highest-quality preset that fits this machine:
 * non-deprecated, minRamMB ≤ systemRamMB × RAM_FIT_FRACTION, and (when
 * known) free disk ≥ MIN_FREE_DISK_MB with minRamMB ≤ free disk space.
 * Returns null when nothing fits.
 */
export function recommendModel(
	presets: readonly ModelPreset[],
	systemInfo: Pick<SystemInfo, 'systemRamMB'>,
	diskFreeMB: number | null
): ModelRecommendation | null {
	const ramLimitMB = systemInfo.systemRamMB * RAM_FIT_FRACTION;
	if (diskFreeMB !== null && diskFreeMB < MIN_FREE_DISK_MB) return null;

	const candidates = presets.filter(p => {
		if (p.deprecated) return false;
		if (p.minRamMB > ramLimitMB) return false;
		if (diskFreeMB !== null && p.minRamMB > diskFreeMB) return false;
		return true;
	});
	if (candidates.length === 0) return null;

	candidates.sort((a, b) => b.qualityRank - a.qualityRank);
	const best = candidates[0];
	const ramGB = Math.round(systemInfo.systemRamMB / 1024);
	return {
		presetId: best.id,
		reason: `↑ A good balance of quality and speed that fits comfortably on ${ramGB} GB RAM.`,
	};
}

/**
 * Human-readable hardware summary for the model screen, e.g.
 * "M3 Pro · 18 GB RAM · 40 GB free disk". Unknown parts are omitted.
 */
export function formatHardwareLine(
	cpuName: string | null,
	systemRamMB: number,
	diskFreeMB: number | null
): string {
	const parts: string[] = [];
	if (cpuName) parts.push(cpuName);
	if (systemRamMB > 0) parts.push(`${Math.round(systemRamMB / 1024)} GB RAM`);
	if (diskFreeMB !== null) parts.push(`${Math.round(diskFreeMB / 1024)} GB free disk`);
	return parts.join(' · ');
}
