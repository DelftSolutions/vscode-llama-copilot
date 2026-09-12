/**
 * SSH config parser/writer with Include support and safety features.
 *
 * Handles:
 *   - Recursive Include resolution with glob expansion
 *   - Source-file tracking per Host block (patch the correct file)
 *   - Backup/restore/diff preview before writes
 *   - Circular include detection
 *   - Graceful handling of unreadable included files
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { HostBlock } from './remoteAuthority.js';

export interface ResolvedSSHConfig {
	entries: ConfigEntry[];
	warnings: string[];
}

export interface ConfigEntry {
	sourceFile: string;
	lineNumber: number;
	raw: string;
	type: 'host' | 'include' | 'directive' | 'comment' | 'blank';
	key?: string;
	value?: string;
}

/**
 * Get the SSH config path from VS Code settings or default.
 */
export function getSSHConfigPath(): string {
	// VS Code's Remote SSH extension uses remote.SSH.configFile
	try {
		// Lazy import so unit tests can run without a vscode host
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const vscode = require('vscode') as typeof import('vscode');
		const configFile = vscode.workspace
			.getConfiguration('remote.SSH')
			.get('configFile') as string | undefined;
		if (configFile) {
			return configFile.replace(/^~/, os.homedir());
		}
	} catch {
		// Not in VS Code context
	}
	return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Load and recursively resolve an SSH config file, following Include directives.
 */
export async function loadSSHConfig(
	configPath: string,
	visited: Set<string> = new Set(),
): Promise<ResolvedSSHConfig> {
	const absPath = path.resolve(configPath.replace(/^~/, os.homedir()));
	const warnings: string[] = [];

	if (visited.has(absPath)) {
		warnings.push(`Circular Include detected: ${absPath}`);
		return { entries: [], warnings };
	}
	visited.add(absPath);

	let content: string;
	try {
		content = await fs.promises.readFile(absPath, 'utf-8');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`Could not read SSH config: ${absPath}: ${msg}`);
		return { entries: [], warnings };
	}

	const lines = content.split('\n');
	const entries: ConfigEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();

		if (!trimmed || trimmed.startsWith('#')) {
			entries.push({
				sourceFile: absPath,
				lineNumber: i + 1,
				raw,
				type: trimmed ? 'comment' : 'blank',
			});
			continue;
		}

		// Parse key-value: SSH config uses either whitespace or = as separator
		const match = trimmed.match(/^(\S+)\s*[=\s]\s*(.*)/);
		if (!match) {
			entries.push({
				sourceFile: absPath,
				lineNumber: i + 1,
				raw,
				type: 'directive',
			});
			continue;
		}

		const [, key, value] = match;
		const keyLower = key.toLowerCase();

		if (keyLower === 'include') {
			entries.push({
				sourceFile: absPath,
				lineNumber: i + 1,
				raw,
				type: 'include',
				key: 'Include',
				value,
			});

			// Skip Include paths with SSH tokens
			if (value.includes('%')) {
				warnings.push(`Include with SSH token not supported: ${value}`);
				continue;
			}

			// Resolve glob
			const expandedPath = value.replace(/^~/, os.homedir());
			const includeFiles = expandGlob(expandedPath);

			for (const file of includeFiles) {
				const sub = await loadSSHConfig(file, new Set(visited));
				entries.push(...sub.entries);
				warnings.push(...sub.warnings);
			}
		} else if (keyLower === 'host') {
			entries.push({
				sourceFile: absPath,
				lineNumber: i + 1,
				raw,
				type: 'host',
				key: 'Host',
				value,
			});
		} else {
			entries.push({
				sourceFile: absPath,
				lineNumber: i + 1,
				raw,
				type: 'directive',
				key,
				value,
			});
		}
	}

	return { entries, warnings };
}

/**
 * Expand a glob pattern for SSH config Include.
 * SSH config supports * and ? only (not **).
 */
function expandGlob(pattern: string): string[] {
	const dir = path.dirname(pattern);
	const base = path.basename(pattern);

	if (!base.includes('*') && !base.includes('?')) {
		// Not a glob, check if the file exists
		if (fs.existsSync(pattern)) return [pattern];
		return [];
	}

	try {
		if (!fs.existsSync(dir)) return [];
		const files = fs.readdirSync(dir);
		const re = new RegExp(
			'^' + base.replace(/[.*+?^${}()|[\]\\]/g, (c) => {
				if (c === '*') return '.*';
				if (c === '?') return '.';
				return '\\' + c;
			}) + '$',
		);
		return files
			.filter(f => re.test(f))
			.map(f => path.join(dir, f))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Parse Host blocks from resolved SSH config entries.
 * Each block includes source file and line range for targeted patching.
 */
export function parseHostBlocks(config: ResolvedSSHConfig): HostBlock[] {
	const blocks: HostBlock[] = [];
	let current: HostBlock | null = null;

	for (const entry of config.entries) {
		if (entry.type === 'host' && entry.value) {
			// Finish previous block
			if (current) {
				blocks.push(current);
			}

			const patterns = entry.value.split(/\s+/).filter(Boolean);
			current = {
				pattern: entry.value,
				patterns,
				sourceFile: entry.sourceFile,
				startLine: entry.lineNumber,
				endLine: entry.lineNumber,
				remoteForwards: [],
				directives: new Map(),
			};
		} else if (current && entry.sourceFile === current.sourceFile) {
			current.endLine = entry.lineNumber;

			if (entry.key) {
				const keyLower = entry.key.toLowerCase();
				if (keyLower === 'hostname' && entry.value) {
					current.hostName = entry.value;
				}
				if (keyLower === 'remoteforward' && entry.value) {
					current.remoteForwards.push(entry.value);
				}
				current.directives.set(keyLower, entry.value ?? '');
			}
		} else if (current && entry.sourceFile !== current.sourceFile) {
			// New file boundary, close block
			blocks.push(current);
			current = null;
		}
	}

	if (current) {
		blocks.push(current);
	}

	return blocks;
}

/**
 * Check if a specific RemoteForward already exists in a Host block.
 */
export function hasRemoteForward(
	block: HostBlock,
	remotePort: number,
	localBind: string,
	localPort: number,
): boolean {
	const targetPrefix = `${remotePort}`;
	const targetSuffix = `${localBind}:${localPort}`;

	for (const rf of block.remoteForwards) {
		const parts = rf.trim().split(/\s+/);
		if (parts.length >= 2) {
			// RemoteForward <remoteAddr>:<remotePort> <localAddr>:<localPort>
			// or RemoteForward <remotePort> <localAddr>:<localPort>
			const remotePart = parts[0];
			const localPart = parts[1];

			const rPort = remotePart.includes(':')
				? remotePart.split(':').pop()
				: remotePart;

			if (rPort === targetPrefix && localPart === targetSuffix) {
				return true;
			}
			// Also check with bind address
			if (remotePart === `127.0.0.1:${remotePort}` && localPart === targetSuffix) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Add a RemoteForward line to the correct source file for a Host block.
 * Returns the modified file path and new content.
 */
export async function addRemoteForward(
	block: HostBlock,
	remotePort: number,
	localBind: string,
	localPort: number,
): Promise<{ modifiedFile: string; newContent: string }> {
	const content = await fs.promises.readFile(block.sourceFile, 'utf-8');
	const lines = content.split('\n');

	// Format: IPv6 localBind needs brackets
	const formattedLocal = localBind.includes(':') ? `[${localBind}]:${localPort}` : `${localBind}:${localPort}`;
	const forwardLine = `  RemoteForward 127.0.0.1:${remotePort} ${formattedLocal}`;

	// Insert after the last directive in this Host block (before the next Host or end)
	const insertIdx = block.endLine; // 1-based, insert after this line
	lines.splice(insertIdx, 0, forwardLine);

	const newContent = lines.join('\n');
	return { modifiedFile: block.sourceFile, newContent };
}

/**
 * Create a timestamped backup of an SSH config file.
 * At most 10 backups retained; oldest pruned.
 */
export async function createBackup(configPath: string): Promise<string> {
	const timestamp = new Date().toISOString()
		.replace(/:/g, '-')
		.replace(/\.\d{3}Z$/, 'Z');
	const backupPath = `${configPath}.llama-backup-${timestamp}`;

	await fs.promises.copyFile(configPath, backupPath);

	// Prune old backups (keep at most 10)
	const dir = path.dirname(configPath);
	const base = path.basename(configPath);
	const files = await fs.promises.readdir(dir);
	const backups = files
		.filter(f => f.startsWith(`${base}.llama-backup-`))
		.sort()
		.reverse();

	for (const old of backups.slice(10)) {
		try {
			await fs.promises.unlink(path.join(dir, old));
		} catch {
			// best-effort cleanup
		}
	}

	return backupPath;
}

/**
 * Find the most recent backup for an SSH config file.
 */
export async function getLatestBackup(configPath: string): Promise<string | null> {
	const dir = path.dirname(configPath);
	const base = path.basename(configPath);

	try {
		const files = await fs.promises.readdir(dir);
		const backups = files
			.filter(f => f.startsWith(`${base}.llama-backup-`))
			.sort()
			.reverse();

		return backups.length > 0 ? path.join(dir, backups[0]) : null;
	} catch {
		return null;
	}
}

/**
 * Restore an SSH config file from a backup.
 */
export async function restoreBackup(configPath: string, backupPath: string): Promise<void> {
	const backupContent = await fs.promises.readFile(backupPath, 'utf-8');
	await fs.promises.writeFile(configPath, backupContent, 'utf-8');
}

/**
 * Generate a diff preview string showing what RemoteForward lines
 * will be added to which Host blocks.
 */
export function generateDiffPreview(
	block: HostBlock,
	forwards: Array<{ remotePort: number; localBind: string; localPort: number }>,
): string {
	const lines: string[] = [];
	lines.push(`  Host ${block.pattern}`);
	if (block.hostName) {
		lines.push(`    HostName ${block.hostName}`);
	}
	for (const existing of block.remoteForwards) {
		lines.push(`    RemoteForward ${existing}`);
	}
	for (const fw of forwards) {
		const local = fw.localBind.includes(':')
			? `[${fw.localBind}]:${fw.localPort}`
			: `${fw.localBind}:${fw.localPort}`;
		lines.push(`  + RemoteForward 127.0.0.1:${fw.remotePort} ${local}`);
	}
	return lines.join('\n');
}
