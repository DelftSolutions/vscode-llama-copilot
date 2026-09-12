/**
 * Manages the models.ini file for the managed llama-server.
 * Handles reading, writing, adding/removing presets with tracking comments,
 * and autoupdate logic. Preserves user-added sections.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ModelPreset, getPresetById, MODEL_PRESETS } from './presets.js';

export interface ManagedSection {
	templateId: string;
	autoupdate: boolean;
	version: number;
}

export interface IniSection {
	/** Section name (without brackets) */
	name: string;
	/** The raw lines of the section (including header and any comments) */
	lines: string[];
	/** If this is a managed section, the parsed tracking info */
	managed?: ManagedSection;
}

const TRACKING_PREFIX = '; managed:';
const TRACKING_PATTERN = /^;\s*managed:\s*template=([^,]+),\s*autoupdate=(on|off),\s*version=(\d+)/;
export const SUPPORTED_INI_VERSION = 1;
const VERSION_LINE = `version = ${SUPPORTED_INI_VERSION}`;
const VERSION_PATTERN = /^\s*version\s*=\s*(\d+)/;

/**
 * Thrown when models.ini uses a format version newer than this extension supports.
 */
export class UnsupportedIniVersionError extends Error {
	readonly fileVersion: number;
	readonly supportedVersion: number;

	constructor(fileVersion: number, supportedVersion: number = SUPPORTED_INI_VERSION) {
		super(
			`This models.ini uses format version ${fileVersion}, but Llama Copilot only supports version ${supportedVersion}. Update the extension, or edit the file manually.`
		);
		this.name = 'UnsupportedIniVersionError';
		this.fileVersion = fileVersion;
		this.supportedVersion = supportedVersion;
	}
}

/**
 * Parse the models.ini format version from section preamble.
 * Returns null if no version line is present.
 */
export function parseFileVersion(sections: IniSection[]): number | null {
	const preamble = sections.find(s => s.name === '__preamble__');
	if (!preamble) return null;
	for (const line of preamble.lines) {
		const match = line.match(VERSION_PATTERN);
		if (match) return parseInt(match[1], 10);
	}
	return null;
}

/**
 * Parse a tracking comment line into structured data.
 */
export function parseTrackingComment(line: string): ManagedSection | null {
	const match = line.match(TRACKING_PATTERN);
	if (!match) return null;
	return {
		templateId: match[1],
		autoupdate: match[2] === 'on',
		version: parseInt(match[3], 10),
	};
}

/**
 * Build a tracking comment line.
 */
export function buildTrackingComment(templateId: string, autoupdate: boolean, version: number): string {
	return `${TRACKING_PREFIX} template=${templateId}, autoupdate=${autoupdate ? 'on' : 'off'}, version=${version}`;
}

/**
 * Parse a models.ini file into sections.
 */
export function parseIniSections(content: string): IniSection[] {
	if (!content.trim()) return [];

	const lines = content.split('\n');
	const sections: IniSection[] = [];
	let currentSection: IniSection | null = null;
	let preambleLines: string[] = [];

	for (const line of lines) {
		const sectionMatch = line.match(/^\[([^\]]+)\]/);
		if (sectionMatch) {
			if (currentSection) {
				sections.push(currentSection);
			}
			// If we had preamble lines, store them as a preamble section
			if (preambleLines.length > 0 && sections.length === 0) {
				sections.push({ name: '__preamble__', lines: preambleLines });
				preambleLines = [];
			}
			currentSection = {
				name: sectionMatch[1],
				lines: [line],
			};
		} else if (currentSection) {
			currentSection.lines.push(line);
			// Check for tracking comment (first non-empty line after header)
			if (!currentSection.managed && line.trim().startsWith(TRACKING_PREFIX)) {
				currentSection.managed = parseTrackingComment(line.trim()) ?? undefined;
			}
		} else {
			// Lines before any section header (preamble)
			preambleLines.push(line);
		}
	}

	if (preambleLines.length > 0 && !currentSection && sections.length === 0) {
		sections.push({ name: '__preamble__', lines: preambleLines });
	}

	if (currentSection) {
		sections.push(currentSection);
	}

	return sections;
}

/**
 * Ensure sections include a models.ini version preamble.
 */
export function ensureVersionPreamble(sections: IniSection[]): IniSection[] {
	const result = sections.map(s =>
		s.name === '__preamble__' ? { ...s, lines: [...s.lines] } : s
	);
	const preamble = result.find(s => s.name === '__preamble__');
	const hasVersion =
		preamble?.lines.some(l => VERSION_PATTERN.test(l)) ||
		result.some(s => s.name !== '__preamble__' && s.lines.some(l => VERSION_PATTERN.test(l)));

	if (hasVersion) return result;

	if (preamble) {
		preamble.lines.unshift(VERSION_LINE);
		return result;
	}

	return [{ name: '__preamble__', lines: [VERSION_LINE, ''] }, ...result];
}

/**
 * Serialize sections back to ini file content.
 */
export function serializeSections(sections: IniSection[]): string {
	const parts: string[] = [];
	for (const section of sections) {
		if (section.name === '__preamble__') {
			parts.push(section.lines.join('\n'));
		} else {
			parts.push(section.lines.join('\n'));
		}
	}
	return parts.join('\n');
}

/**
 * Build a full section (header + tracking comment + ini lines) for a preset.
 */
export function buildPresetSection(preset: ModelPreset, autoupdate: boolean): string[] {
	const lines: string[] = [
		`[${preset.id}]`,
		buildTrackingComment(preset.id, autoupdate, preset.version),
		...preset.iniLines,
		'', // trailing blank line
	];
	return lines;
}

/**
 * Manager for the models.ini file.
 */
export class ModelsIniManager {
	private readonly iniPath: string;

	constructor(globalStoragePath: string) {
		this.iniPath = path.join(globalStoragePath, 'models.ini');
	}

	/**
	 * Get the path to the models.ini file.
	 */
	getIniPath(): string {
		return this.iniPath;
	}

	/**
	 * Check if models.ini exists.
	 */
	async exists(): Promise<boolean> {
		try {
			await fs.access(this.iniPath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get the models.ini format version, or null if missing / file absent.
	 */
	async getIniFormatVersion(): Promise<number | null> {
		if (!(await this.exists())) return null;
		return parseFileVersion(await this.readSections());
	}

	/**
	 * Ensure models.ini exists, creating it with a default header if missing.
	 */
	async ensureExists(): Promise<void> {
		if (await this.exists()) return;
		await this.writeSections([]);
	}

	/**
	 * Read and parse the current ini file.
	 */
	async readSections(): Promise<IniSection[]> {
		try {
			const content = await fs.readFile(this.iniPath, 'utf-8');
			return parseIniSections(content);
		} catch {
			return [];
		}
	}

	/**
	 * Write sections back to the ini file.
	 * Always ensures a version preamble is present when the format is supported.
	 * Refuses to write if the existing file uses a newer unsupported format version.
	 */
	async writeSections(sections: IniSection[]): Promise<void> {
		if (await this.exists()) {
			const existingVersion = parseFileVersion(await this.readSections());
			if (existingVersion !== null && existingVersion > SUPPORTED_INI_VERSION) {
				throw new UnsupportedIniVersionError(existingVersion);
			}
		}
		const content = serializeSections(ensureVersionPreamble(sections));
		await fs.mkdir(path.dirname(this.iniPath), { recursive: true });
		await fs.writeFile(this.iniPath, content, 'utf-8');
	}

	/**
	 * Get the list of currently enabled preset IDs.
	 */
	async getEnabledPresets(): Promise<Map<string, ManagedSection>> {
		const sections = await this.readSections();
		const enabled = new Map<string, ManagedSection>();
		for (const section of sections) {
			if (section.managed) {
				enabled.set(section.managed.templateId, section.managed);
			}
		}
		return enabled;
	}

	/**
	 * Enable a preset (add it to models.ini).
	 */
	async enablePreset(presetId: string, autoupdate = true): Promise<void> {
		const preset = getPresetById(presetId);
		if (!preset) throw new Error(`Unknown preset: ${presetId}`);

		const sections = await this.readSections();

		// Check if already exists
		const existing = sections.find(s => s.managed?.templateId === presetId);
		if (existing) return; // Already enabled

		// Append new section
		const newLines = buildPresetSection(preset, autoupdate);
		sections.push({
			name: preset.id,
			lines: newLines,
			managed: { templateId: presetId, autoupdate, version: preset.version },
		});

		await this.writeSections(sections);
	}

	/**
	 * Disable a preset (remove it from models.ini).
	 */
	async disablePreset(presetId: string): Promise<void> {
		const sections = await this.readSections();
		const filtered = sections.filter(s => s.managed?.templateId !== presetId);
		await this.writeSections(filtered);
	}

	/**
	 * Set the autoupdate flag for a managed section.
	 */
	async setAutoupdate(presetId: string, autoupdate: boolean): Promise<void> {
		const sections = await this.readSections();
		for (const section of sections) {
			if (section.managed?.templateId === presetId) {
				section.managed.autoupdate = autoupdate;
				// Rewrite the tracking comment line
				const trackingIdx = section.lines.findIndex(l => l.trim().startsWith(TRACKING_PREFIX));
				if (trackingIdx !== -1) {
					section.lines[trackingIdx] = buildTrackingComment(presetId, autoupdate, section.managed.version);
				}
				break;
			}
		}
		await this.writeSections(sections);
	}

	/**
	 * Replace a deprecated preset with its successor.
	 */
	async migratePreset(deprecatedId: string): Promise<string | null> {
		const deprecated = getPresetById(deprecatedId);
		if (!deprecated?.successor) return null;

		const successor = getPresetById(deprecated.successor);
		if (!successor) return null;

		const sections = await this.readSections();
		const idx = sections.findIndex(s => s.managed?.templateId === deprecatedId);
		if (idx === -1) return null;

		const autoupdate = sections[idx].managed?.autoupdate ?? true;

		// Remove old, add new
		sections.splice(idx, 1);
		const newLines = buildPresetSection(successor, autoupdate);
		sections.splice(idx, 0, {
			name: successor.id,
			lines: newLines,
			managed: { templateId: successor.id, autoupdate, version: successor.version },
		});

		await this.writeSections(sections);
		return successor.id;
	}

	/**
	 * Apply autoupdates: for each managed section with autoupdate=on,
	 * check if the preset version is newer and update the content.
	 * Returns the list of updated preset IDs.
	 */
	async applyAutoupdates(): Promise<string[]> {
		const sections = await this.readSections();
		const fileVersion = parseFileVersion(sections);
		if (fileVersion !== null && fileVersion > SUPPORTED_INI_VERSION) {
			throw new UnsupportedIniVersionError(fileVersion);
		}

		const updated: string[] = [];

		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			if (!section.managed || !section.managed.autoupdate) continue;

			const preset = getPresetById(section.managed.templateId);
			if (!preset) continue;
			if (preset.version <= section.managed.version) continue;

			// Preset has been updated -- rewrite section
			const newLines = buildPresetSection(preset, section.managed.autoupdate);
			sections[i] = {
				name: preset.id,
				lines: newLines,
				managed: { templateId: preset.id, autoupdate: section.managed.autoupdate, version: preset.version },
			};
			updated.push(preset.id);
		}

		if (updated.length > 0) {
			await this.writeSections(sections);
		}

		return updated;
	}

	/**
	 * Manually upgrade a specific preset to the latest version (regardless of autoupdate flag).
	 */
	async upgradePreset(presetId: string): Promise<boolean> {
		const preset = getPresetById(presetId);
		if (!preset) return false;

		const sections = await this.readSections();
		const idx = sections.findIndex(s => s.managed?.templateId === presetId);
		if (idx === -1) return false;

		const section = sections[idx];
		if (preset.version <= (section.managed?.version ?? 0)) return false;

		const autoupdate = section.managed?.autoupdate ?? true;
		const newLines = buildPresetSection(preset, autoupdate);
		sections[idx] = {
			name: preset.id,
			lines: newLines,
			managed: { templateId: preset.id, autoupdate, version: preset.version },
		};

		await this.writeSections(sections);
		return true;
	}

	/**
	 * Get user-added sections (those without a tracking comment).
	 */
	async getUserSections(): Promise<IniSection[]> {
		const sections = await this.readSections();
		return sections.filter(s => !s.managed && s.name !== '__preamble__');
	}
}
