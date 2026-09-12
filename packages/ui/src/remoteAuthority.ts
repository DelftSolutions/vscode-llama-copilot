/**
 * Decode SSH remote authority into host info and match against SSH config
 * Host blocks.
 *
 * Authority format: <type>+<payload>
 * For SSH remotes, type is 'ssh-remote'.
 *
 * NOTE: vscode.env.remoteAuthority requires the `resolvers` proposed API.
 * Use {@link getRemoteAuthority} (stable) instead of reading the property
 * directly.
 */

import * as vscode from 'vscode';

/**
 * Retrieve the remote authority string using only stable VS Code APIs.
 *
 * Falls back through (1) workspace folder URI authority and (2) the
 * `VSCODE_REMOTE_AUTHORITY` environment variable.  Returns `undefined`
 * when there is no remote session.
 */
export function getRemoteAuthority(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		const { authority } = folder.uri;
		if (authority) return authority;
	}
	return process.env.VSCODE_REMOTE_AUTHORITY || undefined;
}

/**
 * Check whether the current session is an SSH remote using only stable APIs.
 */
export function isSSHRemoteSession(): boolean {
	return vscode.env.remoteName === 'ssh-remote';
}

export interface RemoteAuthorityInfo {
	type: 'ssh-remote';
	raw: string;
	host: string;
	user?: string;
	port?: number;
	hostCandidates: string[];
}

export interface HostBlock {
	pattern: string;
	patterns: string[];
	hostName?: string;
	sourceFile: string;
	startLine: number;
	endLine: number;
	remoteForwards: string[];
	directives: Map<string, string>;
}

/**
 * Decode the remoteAuthority string into structured SSH host info.
 *
 * Handles:
 *   1. Hex-encoded JSON payloads (VS Code Remote SSH's encoded authorities)
 *   2. user@host format
 *   3. Plain SSH config alias
 */
export function decodeRemoteAuthority(authority: string): RemoteAuthorityInfo | null {
	if (!authority.startsWith('ssh-remote+')) return null;

	const payload = authority.slice('ssh-remote+'.length);
	if (!payload) return null;

	// Try hex-encoded JSON
	if (/^[0-9a-fA-F]{4,}$/.test(payload) && payload.length % 2 === 0) {
		try {
			const bytes = new Uint8Array(payload.length / 2);
			for (let i = 0; i < payload.length; i += 2) {
				bytes[i / 2] = parseInt(payload.substring(i, i + 2), 16);
			}
			const decoded = new TextDecoder().decode(bytes);
			const obj = JSON.parse(decoded);
			if (typeof obj === 'object' && obj !== null) {
				const host = obj.host ?? obj.hostName;
				if (typeof host === 'string') {
					const user = obj.user ?? obj.username;
					const port = typeof obj.port === 'number' ? obj.port : undefined;
					const candidates = [host];
					if (typeof user === 'string') candidates.unshift(`${user}@${host}`);
					return {
						type: 'ssh-remote',
						raw: payload,
						host: stripPortSuffix(host),
						user: typeof user === 'string' ? user : undefined,
						port,
						hostCandidates: candidates,
					};
				}
			}
		} catch {
			// Not valid hex-encoded JSON, fall through
		}
	}

	// Try user@host
	if (payload.includes('@')) {
		const lastAt = payload.lastIndexOf('@');
		const user = payload.slice(0, lastAt);
		const host = stripPortSuffix(payload.slice(lastAt + 1));
		return {
			type: 'ssh-remote',
			raw: payload,
			host,
			user: user || undefined,
			hostCandidates: [payload, host],
		};
	}

	// Plain alias
	return {
		type: 'ssh-remote',
		raw: payload,
		host: stripPortSuffix(payload),
		hostCandidates: [payload],
	};
}

function stripPortSuffix(host: string): string {
	// Strip trailing :PORT (e.g. :22) from non-IPv6 addresses
	if (host.includes('[')) return host; // IPv6 in brackets
	const colonIdx = host.lastIndexOf(':');
	if (colonIdx > 0 && /^\d+$/.test(host.slice(colonIdx + 1))) {
		return host.slice(0, colonIdx);
	}
	return host;
}

/**
 * Check if a Host pattern is a catch-all that should never be patched.
 * Rejects: Host *, Host *.*, Host ?*, and similar universal patterns.
 */
function isCatchAllPattern(pattern: string): boolean {
	const p = pattern.trim();
	if (p === '*') return true;
	if (p === '*.*') return true;
	if (p === '?*') return true;
	// Any pattern where every non-empty hostname matches
	if (/^\*+$/.test(p)) return true;
	if (/^\?[\*\?]*$/.test(p)) return true;
	return false;
}

/**
 * Simple SSH-style glob matching (supports * and ? only).
 */
function sshGlobMatch(pattern: string, text: string): boolean {
	let re = '^';
	for (const c of pattern) {
		if (c === '*') re += '.*';
		else if (c === '?') re += '.';
		else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	re += '$';
	return new RegExp(re, 'i').test(text);
}

/**
 * Find Host blocks matching the decoded remote authority.
 *
 * Returns patchable matches sorted by specificity.
 * Catch-all blocks (Host *) are excluded from writable results.
 */
export function findMatchingHostBlocks(
	info: RemoteAuthorityInfo,
	blocks: HostBlock[],
): HostBlock[] {
	const scored: Array<{ block: HostBlock; score: number }> = [];

	for (const block of blocks) {
		// Skip catch-all patterns
		if (block.patterns.every(p => isCatchAllPattern(p))) continue;

		let bestScore = 0;

		for (const pattern of block.patterns) {
			if (isCatchAllPattern(pattern)) continue;

			for (const candidate of info.hostCandidates) {
				// Exact match
				if (pattern.toLowerCase() === candidate.toLowerCase()) {
					bestScore = Math.max(bestScore, 3);
				}
			}

			// HostName match
			if (block.hostName && block.hostName.toLowerCase() === info.host.toLowerCase()) {
				bestScore = Math.max(bestScore, 2);
			}

			// Wildcard match against decoded host
			if (pattern.includes('*') || pattern.includes('?')) {
				if (sshGlobMatch(pattern, info.host)) {
					bestScore = Math.max(bestScore, 1);
				}
				for (const candidate of info.hostCandidates) {
					if (sshGlobMatch(pattern, candidate)) {
						bestScore = Math.max(bestScore, 1);
					}
				}
			}
		}

		if (bestScore > 0) {
			scored.push({ block, score: bestScore });
		}
	}

	return scored
		.sort((a, b) => b.score - a.score)
		.map(s => s.block);
}
