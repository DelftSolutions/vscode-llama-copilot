import * as vscode from 'vscode';
import * as path from 'path';
import { ParsedRule, RuleMetadata } from './types';
import { globToRegex } from './globMatcher';
import { logRulesMatching } from '../logger';

/**
 * Parse YAML frontmatter from a string.
 * Simple parser for basic frontmatter format. Exported for testing.
 */
export function parseFrontmatter(content: string): { frontmatter: RuleMetadata; body: string } {
	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);
	
	if (!match) {
		return { frontmatter: {}, body: content };
	}
	
	const frontmatterStr = match[1];
	const body = match[2];
	const frontmatter: RuleMetadata = {};
	
	// Simple YAML parser for our use case
	const lines = frontmatterStr.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		
		const colonIndex = trimmed.indexOf(':');
		if (colonIndex === -1) {
			continue;
		}
		
		const key = trimmed.substring(0, colonIndex).trim();
		let value = trimmed.substring(colonIndex + 1).trim();
		
		// Remove quotes if present
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		
		if (key === 'description') {
			frontmatter.description = value;
		} else if (key === 'globs') {
			// Handle array format: globs: ["*.ts", "src/**"] or globs: - "*.ts" (YAML list)
			if (value.startsWith('[')) {
				// JSON array format
				const arrayContent = value.slice(1, -1);
				const items = arrayContent.split(',').map(item => {
					const trimmed = item.trim();
					return trimmed.replace(/^["']|["']$/g, '');
				});
				frontmatter.globs = items.filter(item => item.length > 0);
			} else if (value.includes(',')) {
				// Comma-separated values
				frontmatter.globs = value.split(',').map(item => item.trim().replace(/^["']|["']$/g, ''));
			} else {
				// Single value
				frontmatter.globs = [value.replace(/^["']|["']$/g, '')];
			}
		} else if (key === 'alwaysApply') {
			frontmatter.alwaysApply = value === 'true' || value === 'True';
		}
	}
	
	return { frontmatter, body };
}

/**
 * Read and parse a rule file
 */
async function parseRuleFile(
	fileUri: vscode.Uri,
	rulesDirUri: vscode.Uri
): Promise<ParsedRule | null> {
	try {
		const fileData = await vscode.workspace.fs.readFile(fileUri);
		const content = new TextDecoder('utf-8').decode(fileData);
		
		// Get relative path from rules directory
		const rulesPath = rulesDirUri.fsPath;
		const filePath = fileUri.fsPath;
		const relativePath = path.relative(rulesPath, filePath).replace(/\\/g, '/');
		
		const fileName = path.basename(relativePath);
		const name = path.basename(relativePath, path.extname(relativePath));
		
		// Check if it's an .mdc file (has frontmatter) or .md file
		const isMdc = fileName.endsWith('.mdc');
		let metadata: RuleMetadata = {};
		let body = content;
		
		if (isMdc) {
			const parsed = parseFrontmatter(content);
			metadata = parsed.frontmatter;
			body = parsed.body;
		}
		
		// Compile glob patterns to regex
		const regexPatterns = metadata.globs?.map(glob => globToRegex(glob));
		
		logRulesMatching('Parsed rule file', {
			path: relativePath,
			hasGlobs: !!metadata.globs && metadata.globs.length > 0,
			globs: metadata.globs,
			alwaysApply: metadata.alwaysApply
		});
		
		return {
			path: relativePath,
			name,
			fileName,
			metadata,
			content: body.trim(),
			regexPatterns,
		};
	} catch (error) {
		logRulesMatching('Failed to parse rule file', {
			filePath: fileUri.fsPath,
			error: error instanceof Error ? error.message : String(error)
		});
		console.error(`Failed to parse rule file ${fileUri.fsPath}:`, error);
		return null;
	}
}

/**
 * Recursively read all rule files from .cursor/rules/ directory
 */
export async function loadRules(workspaceFolder: vscode.WorkspaceFolder): Promise<ParsedRule[]> {
	const rulesDir = vscode.Uri.joinPath(workspaceFolder.uri, '.cursor', 'rules');
	const rules: ParsedRule[] = [];
	
	logRulesMatching('Checking for rules directory', {
		rulesDirPath: rulesDir.fsPath,
		workspaceFolder: workspaceFolder.name
	});
	
	try {
		// Check if directory exists
		try {
			const stat = await vscode.workspace.fs.stat(rulesDir);
			if (stat.type !== vscode.FileType.Directory) {
				logRulesMatching('Rules path exists but is not a directory', {
					rulesDirPath: rulesDir.fsPath
				});
				return rules;
			}
			
			logRulesMatching('Rules directory found', {
				rulesDirPath: rulesDir.fsPath
			});
		} catch {
			// Directory doesn't exist
			logRulesMatching('Rules directory not found', {
				rulesDirPath: rulesDir.fsPath
			});
			return rules;
		}
		
		// Recursively read directory
		await readDirectoryRecursive(rulesDir, rulesDir, rules);
		
		logRulesMatching('Finished reading rules directory', {
			rulesDirPath: rulesDir.fsPath,
			ruleCount: rules.length
		});
	} catch (error) {
		logRulesMatching('Failed to load rules', {
			rulesDirPath: rulesDir.fsPath,
			error: error instanceof Error ? error.message : String(error)
		});
		console.error('Failed to load rules:', error);
	}
	
	return rules;
}

/**
 * Recursively read directory and parse rule files
 */
async function readDirectoryRecursive(
	currentDir: vscode.Uri,
	rulesDir: vscode.Uri,
	rules: ParsedRule[]
): Promise<void> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(currentDir);
		
		for (const [name, type] of entries) {
			const entryUri = vscode.Uri.joinPath(currentDir, name);
			
			if (type === vscode.FileType.Directory) {
				// Recursively read subdirectories
				await readDirectoryRecursive(entryUri, rulesDir, rules);
			} else if (type === vscode.FileType.File) {
				// Check if it's a rule file (.md or .mdc)
				if (name.endsWith('.md') || name.endsWith('.mdc')) {
					const parsed = await parseRuleFile(entryUri, rulesDir);
					if (parsed) {
						rules.push(parsed);
					}
				}
			}
		}
	} catch (error) {
		console.error(`Failed to read directory ${currentDir.fsPath}:`, error);
	}
}
