/**
 * UI extension config accessors.
 * Reads llamaCopilot.server.* settings contributed by the workspace extension.
 */

import * as vscode from 'vscode';
import { CONFIG_SECTION, CONFIG_ENDPOINTS } from '@llama-copilot/shared';
import type { EndpointsConfig } from '@llama-copilot/shared';

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

export function isServerManaged(): boolean {
	return getConfig().get<boolean>('server.managed', false);
}

export function getServerPort(): number {
	return getConfig().get<number>('server.port', 8013);
}

export function getStopOnDeactivate(): boolean {
	return getConfig().get<boolean>('server.stopOnDeactivate', true);
}

export function isAutoUpdateEnabled(): boolean {
	return getConfig().get<boolean>('server.autoUpdate', true);
}

export function getServerExtraArgs(): string[] {
	return getConfig().get<string[]>('server.extraArgs', []);
}

export function getEndpoints(): EndpointsConfig {
	return getConfig().get<EndpointsConfig>(CONFIG_ENDPOINTS, {});
}

/**
 * Check for settings scope mismatches in remote sessions.
 * Logs a warning if tunnel-critical settings have workspace/remote overrides.
 */
export function checkSettingsScopeMismatch(): void {
	const config = getConfig();
	const criticalSettings = ['server.managed', 'server.port', CONFIG_ENDPOINTS];

	for (const key of criticalSettings) {
		const inspection = config.inspect(key);
		if (inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined) {
			const { logError } = require('@llama-copilot/shared');
			logError(
				`WARNING: llamaCopilot.${key} has a workspace/remote override. ` +
				'This may cause tunnel port mismatches. Move it to User settings.',
			);
			vscode.window.showWarningMessage(
				`llamaCopilot.${key} is set in Workspace/Remote settings. ` +
				'For SSH tunnel port consistency, move it to User settings (scope: application).',
			);
		}
	}
}
