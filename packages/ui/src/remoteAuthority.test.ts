import { describe, it, expect } from 'vitest';
import { decodeRemoteAuthority, findMatchingHostBlocks, type HostBlock } from './remoteAuthority';

describe('decodeRemoteAuthority', () => {
	it('returns null for non-SSH authorities', () => {
		expect(decodeRemoteAuthority('tunnel+abc')).toBeNull();
		expect(decodeRemoteAuthority('wsl+Ubuntu')).toBeNull();
	});

	it('decodes plain alias', () => {
		const result = decodeRemoteAuthority('ssh-remote+myserver');
		expect(result).not.toBeNull();
		expect(result!.host).toBe('myserver');
		expect(result!.user).toBeUndefined();
		expect(result!.hostCandidates).toEqual(['myserver']);
	});

	it('decodes user@host', () => {
		const result = decodeRemoteAuthority('ssh-remote+admin@10.0.0.5');
		expect(result).not.toBeNull();
		expect(result!.host).toBe('10.0.0.5');
		expect(result!.user).toBe('admin');
		expect(result!.hostCandidates).toContain('admin@10.0.0.5');
		expect(result!.hostCandidates).toContain('10.0.0.5');
	});

	it('handles user@host with trailing port', () => {
		const result = decodeRemoteAuthority('ssh-remote+admin@10.0.0.5:22');
		expect(result).not.toBeNull();
		expect(result!.host).toBe('10.0.0.5');
	});

	it('decodes hex-encoded JSON', () => {
		const json = JSON.stringify({ host: '10.0.0.5', user: 'admin', port: 22 });
		const hex = Buffer.from(json, 'utf-8').toString('hex');
		const result = decodeRemoteAuthority(`ssh-remote+${hex}`);
		expect(result).not.toBeNull();
		expect(result!.host).toBe('10.0.0.5');
		expect(result!.user).toBe('admin');
		expect(result!.port).toBe(22);
	});

	it('falls through on invalid hex', () => {
		// Odd length — not valid hex
		const result = decodeRemoteAuthority('ssh-remote+abc');
		expect(result).not.toBeNull();
		expect(result!.host).toBe('abc');
	});

	it('handles user with @ in it', () => {
		const result = decodeRemoteAuthority('ssh-remote+user@name@host');
		expect(result).not.toBeNull();
		expect(result!.host).toBe('host');
		expect(result!.user).toBe('user@name');
	});
});

describe('findMatchingHostBlocks', () => {
	const makeBlock = (pattern: string, hostName?: string): HostBlock => ({
		pattern,
		patterns: pattern.split(/\s+/),
		hostName,
		sourceFile: '/tmp/config',
		startLine: 1,
		endLine: 5,
		remoteForwards: [],
		directives: new Map(),
	});

	it('matches exact alias', () => {
		const info = decodeRemoteAuthority('ssh-remote+myserver')!;
		const blocks = [makeBlock('myserver'), makeBlock('other')];
		const matches = findMatchingHostBlocks(info, blocks);
		expect(matches).toHaveLength(1);
		expect(matches[0].pattern).toBe('myserver');
	});

	it('matches by HostName', () => {
		const info = decodeRemoteAuthority('ssh-remote+admin@10.0.0.5')!;
		const blocks = [makeBlock('myserver', '10.0.0.5')];
		const matches = findMatchingHostBlocks(info, blocks);
		expect(matches).toHaveLength(1);
	});

	it('matches wildcard pattern', () => {
		const info = decodeRemoteAuthority('ssh-remote+gpu.internal.example.com')!;
		const blocks = [makeBlock('*.internal.example.com')];
		const matches = findMatchingHostBlocks(info, blocks);
		expect(matches).toHaveLength(1);
	});

	it('rejects Host *', () => {
		const info = decodeRemoteAuthority('ssh-remote+myserver')!;
		const blocks = [makeBlock('*')];
		const matches = findMatchingHostBlocks(info, blocks);
		expect(matches).toHaveLength(0);
	});

	it('rejects Host *.*', () => {
		const info = decodeRemoteAuthority('ssh-remote+example.com')!;
		const blocks = [makeBlock('*.*')];
		const matches = findMatchingHostBlocks(info, blocks);
		expect(matches).toHaveLength(0);
	});

	it('sorts by specificity: exact > hostname > wildcard', () => {
		const info = decodeRemoteAuthority('ssh-remote+myserver')!;
		const blocks = [
			makeBlock('*.server', undefined), // would not match 'myserver' (no dot)
			makeBlock('prod', 'myserver'),     // hostname match
			makeBlock('myserver'),              // exact match
		];
		const matches = findMatchingHostBlocks(info, blocks);
		expect(matches[0].pattern).toBe('myserver');
	});
});
