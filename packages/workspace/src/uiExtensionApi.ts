import * as vscode from 'vscode';

/**
 * Typed API exported by the UI extension (llama-copilot-ui).
 * Available via vscode.extensions.getExtension().exports in local sessions only.
 */
export interface LlamaCopilotUIAPI {
	getServerState(): string;  // 'running' | 'stopped' | 'starting' | ...
	getServerPort(): number;
	onServerStateChanged: vscode.Event<string>;
}

const UI_EXT_ID = 'delft-solutions.llama-copilot-ui';

/**
 * Get the UI extension's exported API. Only works in local sessions
 * where both extensions share the same extension host.
 */
export function getUIExtensionAPI(): LlamaCopilotUIAPI | undefined {
	const ext = vscode.extensions.getExtension<LlamaCopilotUIAPI>(UI_EXT_ID);
	return ext?.isActive ? ext.exports : undefined;
}

/**
 * Try to get the UI extension API with retry. The UI extension may not
 * be active yet when the workspace extension activates (the two
 * extensions are soft-coupled via extensionPack, not
 * extensionDependencies, so activation order is not guaranteed).
 */
export async function getUIExtensionAPIWithRetry(
	maxRetries = 3,
	delayMs = 500,
): Promise<LlamaCopilotUIAPI | undefined> {
	for (let i = 0; i <= maxRetries; i++) {
		const api = getUIExtensionAPI();
		if (api) return api;

		// Try activating the extension
		const ext = vscode.extensions.getExtension<LlamaCopilotUIAPI>(UI_EXT_ID);
		if (ext && !ext.isActive) {
			try {
				return await ext.activate();
			} catch {
				// Activation failed — retry after delay
			}
		}

		if (i < maxRetries) {
			await new Promise(r => setTimeout(r, delayMs));
		}
	}
	return undefined;
}
