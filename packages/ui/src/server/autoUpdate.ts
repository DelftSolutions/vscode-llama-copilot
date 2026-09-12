/**
 * Auto-update logic for llama-server binaries.
 * Checks GitHub for new releases, downloads in background,
 * and restarts the server only when idle.
 */

import * as vscode from 'vscode';
import { BinaryManager } from './binaryManager.js';
import type { LlamaServerManager } from './serverManager.js';

export interface AutoUpdateOptions {
	binaryManager: BinaryManager;
	serverManager: LlamaServerManager;
	getAutoUpdateEnabled: () => boolean;
}

/**
 * Check for updates and apply if available.
 * Respects 24h cooldown unless forcedByUser is true.
 */
export async function checkForUpdate(
	options: AutoUpdateOptions,
	forcedByUser: boolean
): Promise<void> {
	const { binaryManager, serverManager, getAutoUpdateEnabled } = options;

	// Check cooldown (skip if user-initiated)
	if (!forcedByUser) {
		if (!getAutoUpdateEnabled()) return;
		const canCheck = await binaryManager.canCheckForUpdate();
		if (!canCheck) return;
	}

	// Record the check time
	await binaryManager.recordUpdateCheck();

	// Fetch latest version
	const latest = await binaryManager.latestVersion();
	if (!latest) {
		if (forcedByUser) {
			vscode.window.showWarningMessage('Could not check for llama-server updates. Check your network connection.');
		}
		return;
	}

	const current = await binaryManager.currentVersion();
	if (current === latest) {
		if (forcedByUser) {
			vscode.window.showInformationMessage(`llama-server is already up to date (b${current}).`);
		}
		return;
	}

	// Newer version available -- download
	const downloaded = await binaryManager.downloadWithProgress(latest);
	if (!downloaded) return; // cancelled

	// Apply update
	const state = serverManager.getState();
	if (state !== 'running') {
		// Server not running, just swapped via download already
		if (forcedByUser) {
			vscode.window.showInformationMessage(`llama-server updated to b${latest}.`);
		}
		return;
	}

	// Server is running -- need to restart
	if (serverManager.isIdle()) {
		// Idle -- prompt to restart
		const choice = await vscode.window.showInformationMessage(
			`llama-server update to b${latest} is ready. Restart now?`,
			'Restart',
			'Later'
		);
		if (choice === 'Restart') {
			await serverManager.restart();
		}
	} else {
		// Busy -- defer restart until idle
		vscode.window.showInformationMessage(
			`llama-server update to b${latest} downloaded. Will restart when current requests finish.`
		);
		await waitForIdleAndRestart(serverManager, latest);
	}
}

async function waitForIdleAndRestart(serverManager: LlamaServerManager, version: string): Promise<void> {
	const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

	const idlePromise = serverManager.onceIdle();
	const timeoutPromise = new Promise<'timeout'>(resolve =>
		setTimeout(() => resolve('timeout'), TIMEOUT_MS)
	);

	const result = await Promise.race([idlePromise.then(() => 'idle' as const), timeoutPromise]);

	if (result === 'idle') {
		await serverManager.restart();
	} else {
		// Timed out waiting -- prompt user
		const choice = await vscode.window.showWarningMessage(
			`llama-server update to b${version} is pending but requests are still in progress after 5 minutes. Restart now?`,
			'Restart Now',
			'Later'
		);
		if (choice === 'Restart Now') {
			await serverManager.restart();
		}
	}
}
