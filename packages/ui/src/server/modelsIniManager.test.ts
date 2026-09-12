import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	parseIniSections,
	serializeSections,
	parseTrackingComment,
	buildTrackingComment,
	buildPresetSection,
	ensureVersionPreamble,
	parseFileVersion,
	ModelsIniManager,
	UnsupportedIniVersionError,
	SUPPORTED_INI_VERSION,
} from './modelsIniManager';
import { ModelPreset, MODEL_PRESETS } from './presets';

describe('modelsIniManager', () => {
	describe('parseTrackingComment', () => {
		it('parses a valid tracking comment with autoupdate on', () => {
			const result = parseTrackingComment('; managed: template=qwen3-4b, autoupdate=on, version=2');
			expect(result).toEqual({
				templateId: 'qwen3-4b',
				autoupdate: true,
				version: 2,
			});
		});

		it('parses a valid tracking comment with autoupdate off', () => {
			const result = parseTrackingComment('; managed: template=glm-4-7-flash, autoupdate=off, version=1');
			expect(result).toEqual({
				templateId: 'glm-4-7-flash',
				autoupdate: false,
				version: 1,
			});
		});

		it('returns null for non-tracking comments', () => {
			expect(parseTrackingComment('; This is a regular comment')).toBeNull();
			expect(parseTrackingComment('jinja = true')).toBeNull();
			expect(parseTrackingComment('')).toBeNull();
		});
	});

	describe('buildTrackingComment', () => {
		it('builds a tracking comment line', () => {
			const comment = buildTrackingComment('qwen3-4b', true, 3);
			expect(comment).toBe('; managed: template=qwen3-4b, autoupdate=on, version=3');
		});

		it('builds with autoupdate off', () => {
			const comment = buildTrackingComment('model-x', false, 1);
			expect(comment).toBe('; managed: template=model-x, autoupdate=off, version=1');
		});
	});

	describe('parseIniSections', () => {
		it('parses sections with tracking comments', () => {
			const content = `[qwen3-4b]
; managed: template=qwen3-4b, autoupdate=on, version=1
jinja = true
ctx-size = 32768

[my-custom-model]
jinja = true
hf = my/model`;

			const sections = parseIniSections(content);
			// Should find both sections
			const managed = sections.find(s => s.name === 'qwen3-4b');
			const custom = sections.find(s => s.name === 'my-custom-model');

			expect(managed).toBeDefined();
			expect(managed!.managed).toEqual({
				templateId: 'qwen3-4b',
				autoupdate: true,
				version: 1,
			});

			expect(custom).toBeDefined();
			expect(custom!.managed).toBeUndefined();
		});

		it('preserves all lines in sections', () => {
			const content = `[model-a]
; managed: template=model-a, autoupdate=on, version=1
jinja = true
ctx-size = 0`;

			const sections = parseIniSections(content);
			const section = sections.find(s => s.name === 'model-a');
			expect(section!.lines).toEqual([
				'[model-a]',
				'; managed: template=model-a, autoupdate=on, version=1',
				'jinja = true',
				'ctx-size = 0',
			]);
		});

		it('handles empty content', () => {
			const sections = parseIniSections('');
			expect(sections).toEqual([]);
		});

		it('preserves preamble-only content', () => {
			const sections = parseIniSections('version = 1\n');
			expect(sections).toEqual([{ name: '__preamble__', lines: ['version = 1', ''] }]);
		});
	});

	describe('parseFileVersion', () => {
		it('parses version 1 from preamble', () => {
			expect(parseFileVersion(parseIniSections('version = 1\n'))).toBe(1);
		});

		it('parses version 2 from preamble', () => {
			expect(parseFileVersion(parseIniSections('version = 2\n\n[model]\njinja = true'))).toBe(2);
		});

		it('returns null when version is missing', () => {
			expect(parseFileVersion(parseIniSections('[model]\njinja = true'))).toBeNull();
			expect(parseFileVersion([])).toBeNull();
		});
	});

	describe('serializeSections', () => {
		it('round-trips through parse and serialize', () => {
			const content = `[model-a]
; managed: template=model-a, autoupdate=on, version=1
jinja = true

[model-b]
hf = some/model`;

			const sections = parseIniSections(content);
			const result = serializeSections(sections);
			expect(result).toBe(content);
		});
	});

	describe('ensureVersionPreamble', () => {
		it('adds version preamble when missing', () => {
			const sections = parseIniSections(`[model-a]
jinja = true`);
			const result = ensureVersionPreamble(sections);
			expect(serializeSections(result)).toBe(`version = 1

[model-a]
jinja = true`);
		});

		it('preserves existing version preamble', () => {
			const sections = parseIniSections(`version = 1

[model-a]
jinja = true`);
			const result = ensureVersionPreamble(sections);
			expect(serializeSections(result)).toBe(`version = 1

[model-a]
jinja = true`);
		});

		it('creates version-only content for empty sections', () => {
			expect(serializeSections(ensureVersionPreamble([]))).toBe('version = 1\n');
		});
	});

	describe('buildPresetSection', () => {
		it('builds correct section lines', () => {
			const preset: ModelPreset = {
				id: 'test-model',
				displayName: 'Test Model',
				minRamMB: 4096,
				version: 2,
				iniLines: ['jinja = true', 'ctx-size = 0', 'hf = org/model-GGUF:Q8_0'],
			};

			const lines = buildPresetSection(preset, true);
			expect(lines).toEqual([
				'[test-model]',
				'; managed: template=test-model, autoupdate=on, version=2',
				'jinja = true',
				'ctx-size = 0',
				'hf = org/model-GGUF:Q8_0',
				'',
			]);
		});

		it('builds with autoupdate off', () => {
			const preset: ModelPreset = {
				id: 'x',
				displayName: 'X',
				minRamMB: 1024,
				version: 1,
				iniLines: ['hf = a/b'],
			};

			const lines = buildPresetSection(preset, false);
			expect(lines[1]).toBe('; managed: template=x, autoupdate=off, version=1');
		});
	});

	describe('ModelsIniManager write gating', () => {
		let tmpDir: string;
		let manager: ModelsIniManager;

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-ini-'));
			manager = new ModelsIniManager(tmpDir);
		});

		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		it('refuses to write when format version is higher than supported', async () => {
			const original = `version = 2

[custom]
jinja = true
`;
			await fs.writeFile(manager.getIniPath(), original, 'utf-8');

			await expect(manager.writeSections(parseIniSections(original))).rejects.toBeInstanceOf(UnsupportedIniVersionError);
			await expect(manager.enablePreset(MODEL_PRESETS[0].id)).rejects.toBeInstanceOf(UnsupportedIniVersionError);

			const after = await fs.readFile(manager.getIniPath(), 'utf-8');
			expect(after).toBe(original);
		});

		it('adds version = 1 when missing', async () => {
			await manager.writeSections(parseIniSections(`[custom]
jinja = true`));
			const content = await fs.readFile(manager.getIniPath(), 'utf-8');
			expect(content.startsWith('version = 1')).toBe(true);
			expect(content).toContain('[custom]');
		});

		it('writes successfully when version is supported', async () => {
			const original = `version = 1

[custom]
jinja = true`;
			await fs.writeFile(manager.getIniPath(), original, 'utf-8');

			await manager.writeSections(parseIniSections(original));
			const after = await fs.readFile(manager.getIniPath(), 'utf-8');
			expect(after).toContain('version = 1');
			expect(after).toContain('[custom]');
			expect(await manager.getIniFormatVersion()).toBe(SUPPORTED_INI_VERSION);
		});

		it('applyAutoupdates throws for unsupported format version', async () => {
			await fs.writeFile(manager.getIniPath(), 'version = 2\n', 'utf-8');
			await expect(manager.applyAutoupdates()).rejects.toBeInstanceOf(UnsupportedIniVersionError);
		});
	});
});
