import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
	loadSSHConfig,
	parseHostBlocks,
	hasRemoteForward,
	addRemoteForward,
	createBackup,
	getLatestBackup,
	restoreBackup,
	generateDiffPreview,
} from './sshConfig';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-config-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(name: string, content: string): string {
	const p = path.join(tmpDir, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content, 'utf-8');
	return p;
}

describe('loadSSHConfig', () => {
	it('parses a simple config', async () => {
		const p = writeConfig('config', [
			'Host myserver',
			'  HostName 10.0.0.5',
			'  User admin',
			'',
			'Host other',
			'  HostName 192.168.1.1',
		].join('\n'));

		const result = await loadSSHConfig(p);
		expect(result.warnings).toHaveLength(0);
		expect(result.entries.length).toBeGreaterThan(0);
	});

	it('handles Include with glob', async () => {
		const mainConfig = writeConfig('config', `Include ${tmpDir}/conf.d/*\n\nHost main\n  HostName 1.2.3.4\n`);
		writeConfig('conf.d/hosts.conf', 'Host included\n  HostName 5.6.7.8\n');

		const result = await loadSSHConfig(mainConfig);
		expect(result.warnings).toHaveLength(0);
		const blocks = parseHostBlocks(result);
		const names = blocks.map(b => b.pattern);
		expect(names).toContain('included');
		expect(names).toContain('main');
	});

	it('detects circular includes', async () => {
		const p = writeConfig('config', `Include ${tmpDir}/config\n\nHost test\n  HostName 1.2.3.4\n`);

		const result = await loadSSHConfig(p);
		expect(result.warnings.some(w => w.includes('Circular'))).toBe(true);
	});

	it('warns on Include with SSH tokens', async () => {
		const p = writeConfig('config', 'Include ~/.ssh/%h.conf\n\nHost test\n  HostName 1.2.3.4\n');

		const result = await loadSSHConfig(p);
		expect(result.warnings.some(w => w.includes('SSH token'))).toBe(true);
	});

	it('handles missing Include files gracefully', async () => {
		const p = writeConfig('config', `Include ${tmpDir}/nonexistent/*.conf\n\nHost test\n  HostName 1.2.3.4\n`);

		const result = await loadSSHConfig(p);
		expect(result.warnings).toHaveLength(0);
		const blocks = parseHostBlocks(result);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].pattern).toBe('test');
	});
});

describe('parseHostBlocks', () => {
	it('extracts Host blocks with directives', async () => {
		const p = writeConfig('config', [
			'Host myserver',
			'  HostName 10.0.0.5',
			'  RemoteForward 127.0.0.1:48100 127.0.0.1:8013',
			'  User admin',
		].join('\n'));

		const result = await loadSSHConfig(p);
		const blocks = parseHostBlocks(result);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].pattern).toBe('myserver');
		expect(blocks[0].hostName).toBe('10.0.0.5');
		expect(blocks[0].remoteForwards).toHaveLength(1);
	});

	it('tracks source file per block', async () => {
		const mainConfig = writeConfig('config', `Include ${tmpDir}/extra.conf\n\nHost main\n  HostName 1.2.3.4\n`);
		writeConfig('extra.conf', 'Host extra\n  HostName 5.6.7.8\n');

		const result = await loadSSHConfig(mainConfig);
		const blocks = parseHostBlocks(result);
		const mainBlock = blocks.find(b => b.pattern === 'main');
		const extraBlock = blocks.find(b => b.pattern === 'extra');
		expect(mainBlock?.sourceFile).toContain('config');
		expect(extraBlock?.sourceFile).toContain('extra.conf');
	});
});

describe('hasRemoteForward', () => {
	it('detects existing forward', async () => {
		const p = writeConfig('config', [
			'Host test',
			'  RemoteForward 127.0.0.1:48100 127.0.0.1:8013',
		].join('\n'));

		const result = await loadSSHConfig(p);
		const blocks = parseHostBlocks(result);
		expect(hasRemoteForward(blocks[0], 48100, '127.0.0.1', 8013)).toBe(true);
	});

	it('returns false for missing forward', async () => {
		const p = writeConfig('config', [
			'Host test',
			'  HostName 10.0.0.5',
		].join('\n'));

		const result = await loadSSHConfig(p);
		const blocks = parseHostBlocks(result);
		expect(hasRemoteForward(blocks[0], 48100, '127.0.0.1', 8013)).toBe(false);
	});
});

describe('addRemoteForward', () => {
	it('adds a forward line to the correct file', async () => {
		const p = writeConfig('config', 'Host test\n  HostName 10.0.0.5\n');

		const result = await loadSSHConfig(p);
		const blocks = parseHostBlocks(result);
		const { modifiedFile, newContent } = await addRemoteForward(blocks[0], 48100, '127.0.0.1', 8013);

		expect(modifiedFile).toBe(p);
		expect(newContent).toContain('RemoteForward 127.0.0.1:48100 127.0.0.1:8013');
	});

	it('handles IPv6 local addresses', async () => {
		const p = writeConfig('config', 'Host test\n  HostName 10.0.0.5\n');

		const result = await loadSSHConfig(p);
		const blocks = parseHostBlocks(result);
		const { newContent } = await addRemoteForward(blocks[0], 48100, '::1', 8013);

		expect(newContent).toContain('[::1]:8013');
	});
});

describe('backup/restore', () => {
	it('creates timestamped backup', async () => {
		const p = writeConfig('config', 'Host test\n  HostName 10.0.0.5\n');
		const backupPath = await createBackup(p);
		expect(fs.existsSync(backupPath)).toBe(true);
		expect(backupPath).toContain('.llama-backup-');
	});

	it('restores from backup', async () => {
		const p = writeConfig('config', 'original content');
		const backupPath = await createBackup(p);
		fs.writeFileSync(p, 'modified content', 'utf-8');
		await restoreBackup(p, backupPath);
		expect(fs.readFileSync(p, 'utf-8')).toBe('original content');
	});

	it('finds latest backup', async () => {
		const p = writeConfig('config', 'content');
		await createBackup(p);
		await new Promise(r => setTimeout(r, 10));
		const second = await createBackup(p);
		const latest = await getLatestBackup(p);
		expect(latest).toBe(second);
	});

	it('prunes old backups', async () => {
		const p = writeConfig('config', 'content');
		for (let i = 0; i < 12; i++) {
			const ts = `2026-01-${String(i + 1).padStart(2, '0')}T00-00-00Z`;
			fs.writeFileSync(`${p}.llama-backup-${ts}`, 'backup', 'utf-8');
		}
		await createBackup(p);
		const files = fs.readdirSync(tmpDir).filter(f => f.includes('.llama-backup-'));
		expect(files.length).toBeLessThanOrEqual(10);
	});
});

describe('generateDiffPreview', () => {
	it('generates a readable preview', () => {
		const block = {
			pattern: 'myserver',
			patterns: ['myserver'],
			hostName: '10.0.0.5',
			sourceFile: '/tmp/config',
			startLine: 1,
			endLine: 3,
			remoteForwards: [],
			directives: new Map(),
		};

		const preview = generateDiffPreview(block, [
			{ remotePort: 48100, localBind: '127.0.0.1', localPort: 8013 },
		]);

		expect(preview).toContain('Host myserver');
		expect(preview).toContain('HostName 10.0.0.5');
		expect(preview).toContain('+ RemoteForward');
	});
});
