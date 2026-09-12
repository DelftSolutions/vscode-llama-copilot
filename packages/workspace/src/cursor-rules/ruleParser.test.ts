import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
	workspace: { fs: {} },
	Uri: { joinPath: () => ({ fsPath: '' }) },
	FileType: { File: 1, Directory: 2 },
}));
vi.mock('../logger', () => ({ logRulesMatching: () => {} }));

import { parseFrontmatter } from './ruleParser';

describe('parseFrontmatter', () => {
	it('returns full content as body when no frontmatter', () => {
		const content = 'just some text';
		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter).toEqual({});
		expect(body).toBe(content);
	});

	it('parses description', () => {
		const content = `---
description: My rule
---
body here`;
		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter.description).toBe('My rule');
		expect(body.trim()).toBe('body here');
	});

	it('parses globs array format', () => {
		const content = `---
globs: ["*.ts", "src/**"]
---
body`;
		const { frontmatter } = parseFrontmatter(content);
		expect(frontmatter.globs).toEqual(['*.ts', 'src/**']);
	});

	it('parses alwaysApply true', () => {
		const content = `---
alwaysApply: true
---
x`;
		const { frontmatter } = parseFrontmatter(content);
		expect(frontmatter.alwaysApply).toBe(true);
	});
});
