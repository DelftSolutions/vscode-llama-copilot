/**
 * Orchestrates the SSH RemoteForward setup flow.
 *
 * Called from:
 *   - llamaCopilot.configureSSHForward command
 *   - Onboarding wizard "Set up Remote SSH" button
 *   - Proactively on UI extension activation in remote sessions
 */

import * as vscode from 'vscode';
import {
	deriveAllForwards,
	isPrivateOrLocalAddress,
	type Forward,
} from '@llama-copilot/shared';
import { decodeRemoteAuthority, getRemoteAuthority, findMatchingHostBlocks } from './remoteAuthority.js';
import {
	getSSHConfigPath,
	loadSSHConfig,
	parseHostBlocks,
	hasRemoteForward,
	addRemoteForward,
	createBackup,
	generateDiffPreview,
} from './sshConfig.js';
import type { EndpointsConfig } from '@llama-copilot/shared';

/**
 * Non-wizard SSH config check that runs on every UI extension activation
 * in a remote session. Silent when everything is configured.
 */
export async function checkSSHForwardsForCurrentSession(
	globalState: vscode.Memento,
	isManaged: boolean,
	managedPort: number | null,
	endpoints: EndpointsConfig,
): Promise<void> {
	if (vscode.env.remoteName !== 'ssh-remote') return;

	const authority = getRemoteAuthority();
	if (!authority) return;

	const decoded = decodeRemoteAuthority(authority);
	if (!decoded) return;

	const allForwards = deriveAllForwards(
		managedPort,
		endpoints,
		isPrivateOrLocalAddress,
	);
	if (allForwards.length === 0) return;

	const configPath = getSSHConfigPath();
	const resolvedConfig = await loadSSHConfig(configPath);
	const hostBlocks = parseHostBlocks(resolvedConfig);
	const matchingBlocks = findMatchingHostBlocks(decoded, hostBlocks);

	const missing = allForwards.filter(f =>
		!matchingBlocks.some(block =>
			hasRemoteForward(block, f.remotePort, f.localHost, f.localPort),
		),
	);

	if (missing.length === 0) return;

	const action = await vscode.window.showInformationMessage(
		`${missing.length} SSH tunnel forward(s) needed for this remote session.`,
		'Configure SSH Forwards',
		'Dismiss',
	);

	if (action === 'Configure SSH Forwards') {
		await vscode.commands.executeCommand('llamaCopilot.configureSSHForward');
	}
}

/**
 * Interactive SSH setup wizard (QuickPick-based, not the onboarding webview).
 * Used by the configureSSHForward command.
 */
export async function runSSHSetupWizard(
	isManaged: boolean,
	managedPort: number | null,
	endpoints: EndpointsConfig,
): Promise<void> {
	const authority = getRemoteAuthority();

	const allForwards = deriveAllForwards(
		managedPort,
		endpoints,
		isPrivateOrLocalAddress,
	);

	if (allForwards.length === 0) {
		vscode.window.showInformationMessage('No endpoints need SSH tunnel forwarding.');
		return;
	}

	// Step 1: Let user select which forwards to configure
	const forwardItems = allForwards.map(f => ({
		label: `127.0.0.1:${f.remotePort} → ${f.localHost}:${f.localPort}`,
		description: f.label,
		forward: f,
		picked: true,
	}));

	const selectedForwards = await vscode.window.showQuickPick(forwardItems, {
		canPickMany: true,
		placeHolder: 'Select forwards to add to SSH config',
		title: 'SSH RemoteForward Configuration',
	});

	if (!selectedForwards || selectedForwards.length === 0) return;

	// Step 2: Load SSH config and find matching Host blocks
	const configPath = getSSHConfigPath();
	const resolvedConfig = await loadSSHConfig(configPath);
	const hostBlocks = parseHostBlocks(resolvedConfig);

	let targetBlocks = hostBlocks;
	if (authority) {
		const decoded = decodeRemoteAuthority(authority);
		if (decoded) {
			const matched = findMatchingHostBlocks(decoded, hostBlocks);
			if (matched.length > 0) {
				targetBlocks = matched;
			}
		}
	}

	if (targetBlocks.length === 0) {
		// No matching Host block — offer to create one
		const alias = authority?.startsWith('ssh-remote+')
			? authority.slice('ssh-remote+'.length)
			: undefined;

		const hostAlias = await vscode.window.showInputBox({
			prompt: 'Enter the SSH Host alias to add forwards to',
			value: alias,
			placeHolder: 'e.g., myserver',
		});

		if (!hostAlias) return;

		await createNewHostBlock(
			configPath,
			hostAlias,
			selectedForwards.map(s => s.forward),
		);
		return;
	}

	// Step 3: Select target Host blocks
	const blockItems = targetBlocks.map(b => ({
		label: `Host ${b.pattern}`,
		description: b.hostName ? `(HostName: ${b.hostName})` : undefined,
		detail: `${b.sourceFile}:${b.startLine}`,
		block: b,
		picked: true,
	}));

	const selectedBlocks = await vscode.window.showQuickPick(blockItems, {
		canPickMany: true,
		placeHolder: 'Select SSH Host blocks to add forwards to',
		title: 'Target Host Blocks',
	});

	if (!selectedBlocks || selectedBlocks.length === 0) return;

	// Step 4: Generate preview and ask for confirmation
	const forwards = selectedForwards.map(s => s.forward);
	const previews = selectedBlocks.map(s => {
		const newForwards = forwards.filter(
			f => !hasRemoteForward(s.block, f.remotePort, f.localHost, f.localPort),
		);
		return {
			block: s.block,
			forwards: newForwards,
			preview: newForwards.length > 0
				? generateDiffPreview(s.block, newForwards.map(f => ({
					remotePort: f.remotePort,
					localBind: f.localHost,
					localPort: f.localPort,
				})))
				: null,
		};
	}).filter(p => p.preview !== null);

	if (previews.length === 0) {
		vscode.window.showInformationMessage('All selected forwards are already configured.');
		return;
	}

	const previewText = previews.map(p => p.preview).join('\n\n');
	const confirm = await vscode.window.showInformationMessage(
		`Add ${forwards.length} RemoteForward line(s) to SSH config?`,
		{ modal: true, detail: previewText },
		'Apply Changes',
	);

	if (confirm !== 'Apply Changes') return;

	// Step 5: Backup and apply
	try {
		await createBackup(configPath);

		for (const p of previews) {
			for (const fw of p.forwards) {
				const result = await addRemoteForward(
					p.block,
					fw.remotePort,
					fw.localHost,
					fw.localPort,
				);
				const { writeFile } = await import('node:fs/promises');
				await writeFile(result.modifiedFile, result.newContent, 'utf-8');
			}
		}

		const reconnect = await vscode.window.showInformationMessage(
			'SSH config updated. Reconnect to apply the new forwards.',
			'Reconnect',
			'Later',
		);

		if (reconnect === 'Reconnect') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (err) {
		// Write failed — copy to clipboard
		const lines = forwards.map(f => {
			const local = f.localHost.includes(':')
				? `[${f.localHost}]:${f.localPort}`
				: `${f.localHost}:${f.localPort}`;
			return `RemoteForward 127.0.0.1:${f.remotePort} ${local}`;
		});

		await vscode.env.clipboard.writeText(lines.join('\n'));
		vscode.window.showWarningMessage(
			'Could not write to SSH config. The required lines have been copied to your clipboard. '
			+ 'Paste them into your SSH config manually.',
		);
	}
}

async function createNewHostBlock(
	configPath: string,
	hostAlias: string,
	forwards: Forward[],
): Promise<void> {
	try {
		await createBackup(configPath);

		const { readFile, writeFile } = await import('node:fs/promises');
		let content = '';
		try {
			content = await readFile(configPath, 'utf-8');
		} catch {
			// File doesn't exist yet
		}

		const lines = [`\nHost ${hostAlias}`];
		for (const fw of forwards) {
			const local = fw.localHost.includes(':')
				? `[${fw.localHost}]:${fw.localPort}`
				: `${fw.localHost}:${fw.localPort}`;
			lines.push(`  RemoteForward 127.0.0.1:${fw.remotePort} ${local}`);
		}
		lines.push('');

		const newContent = content.trimEnd() + '\n' + lines.join('\n');
		await writeFile(configPath, newContent, 'utf-8');

		const reconnect = await vscode.window.showInformationMessage(
			`Added Host ${hostAlias} block to SSH config. Reconnect to apply.`,
			'Reconnect',
			'Later',
		);

		if (reconnect === 'Reconnect') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (err) {
		const lines = forwards.map(f => {
			const local = f.localHost.includes(':')
				? `[${f.localHost}]:${f.localPort}`
				: `${f.localHost}:${f.localPort}`;
			return `RemoteForward 127.0.0.1:${f.remotePort} ${local}`;
		});
		await vscode.env.clipboard.writeText(`Host ${hostAlias}\n` + lines.map(l => `  ${l}`).join('\n'));
		vscode.window.showWarningMessage(
			'Could not write to SSH config. The required lines have been copied to your clipboard.',
		);
	}
}
