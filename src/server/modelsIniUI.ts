/**
 * WebviewPanel-based Models Manager UI.
 * Shows presets with enabled/autoupdate checkboxes, RAM/VRAM gating,
 * deprecation badges, and upgrade buttons.
 */

import * as vscode from 'vscode';
import { MODEL_PRESETS, ModelPreset, getPresetById } from './presets';
import {
	ModelsIniManager,
	ManagedSection,
	UnsupportedIniVersionError,
	SUPPORTED_INI_VERSION,
} from './modelsIniManager';
import { SystemInfo, getCachedSystemInfo } from './deviceQuery';

interface PresetViewState {
	id: string;
	displayName: string;
	minRamMB: number;
	enabled: boolean;
	autoupdate: boolean;
	deprecated: boolean;
	successorName?: string;
	successorId?: string;
	version: number;
	currentVersion?: number;
	hasUpdate: boolean;
	exceedsRam: boolean;
	exceedsVram: boolean;
}

interface WebviewState {
	presets: PresetViewState[];
	userSections: string[];
	systemRamMB: number;
	totalVramMB: number;
	iniFormatError?: { fileVersion: number; supportedVersion: number };
}

type WebviewMessage =
	| { type: 'toggleEnabled'; presetId: string; enabled: boolean }
	| { type: 'toggleAutoupdate'; presetId: string; autoupdate: boolean }
	| { type: 'upgrade'; presetId: string }
	| { type: 'migrate'; presetId: string }
	| { type: 'openIni' }
	| { type: 'ready' };

let currentPanel: vscode.WebviewPanel | undefined;

export interface ModelsManagerUIOptions {
	extensionUri: vscode.Uri;
	modelsIniManager: ModelsIniManager;
	onModelsChanged: () => Promise<void>;
}

/**
 * Open or reveal the Models Manager webview panel.
 */
export async function openModelsManager(options: ModelsManagerUIOptions): Promise<void> {
	const { extensionUri, modelsIniManager, onModelsChanged } = options;

	if (currentPanel) {
		currentPanel.reveal();
		await updateWebviewState(currentPanel, modelsIniManager);
		return;
	}

	currentPanel = vscode.window.createWebviewPanel(
		'llamaCopilot.modelsManager',
		'LLaMA Models Manager',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		}
	);

	currentPanel.webview.html = getWebviewHtml();

	currentPanel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
		const runMutation = async (fn: () => Promise<void>, notifyChanged: boolean) => {
			try {
				await fn();
				await updateWebviewState(currentPanel!, modelsIniManager);
				if (notifyChanged) {
					await onModelsChanged();
				}
			} catch (err) {
				if (err instanceof UnsupportedIniVersionError) {
					vscode.window.showErrorMessage(err.message);
					await updateWebviewState(currentPanel!, modelsIniManager);
					return;
				}
				throw err;
			}
		};

		switch (msg.type) {
			case 'ready':
				await updateWebviewState(currentPanel!, modelsIniManager);
				break;
			case 'toggleEnabled':
				await runMutation(async () => {
					if (msg.enabled) {
						await modelsIniManager.enablePreset(msg.presetId);
					} else {
						await modelsIniManager.disablePreset(msg.presetId);
					}
				}, true);
				break;
			case 'toggleAutoupdate':
				await runMutation(async () => {
					await modelsIniManager.setAutoupdate(msg.presetId, msg.autoupdate);
				}, false);
				break;
			case 'upgrade':
				await runMutation(async () => {
					await modelsIniManager.upgradePreset(msg.presetId);
				}, true);
				break;
			case 'migrate':
				await runMutation(async () => {
					await modelsIniManager.migratePreset(msg.presetId);
				}, true);
				break;
			case 'openIni':
				await modelsIniManager.ensureExists();
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelsIniManager.getIniPath()));
				await vscode.window.showTextDocument(doc);
				break;
		}
	});

	currentPanel.onDidDispose(() => {
		currentPanel = undefined;
	});
}

async function updateWebviewState(
	panel: vscode.WebviewPanel,
	modelsIniManager: ModelsIniManager
): Promise<void> {
	const enabled = await modelsIniManager.getEnabledPresets();
	const userSections = await modelsIniManager.getUserSections();
	const systemInfo = getCachedSystemInfo();
	const fileVersion = await modelsIniManager.getIniFormatVersion();

	const systemRamMB = systemInfo?.systemRamMB ?? 0;
	const totalVramMB = systemInfo?.totalVramMB ?? 0;

	const presets: PresetViewState[] = [];

	for (const preset of MODEL_PRESETS) {
		const managedInfo = enabled.get(preset.id);
		const isEnabled = !!managedInfo;

		// Skip deprecated presets that aren't active
		if (preset.deprecated && !isEnabled) continue;

		const successorPreset = preset.successor ? getPresetById(preset.successor) : undefined;

		presets.push({
			id: preset.id,
			displayName: preset.displayName,
			minRamMB: preset.minRamMB,
			enabled: isEnabled,
			autoupdate: managedInfo?.autoupdate ?? true,
			deprecated: !!preset.deprecated,
			successorName: successorPreset?.displayName,
			successorId: preset.successor,
			version: preset.version,
			currentVersion: managedInfo?.version,
			hasUpdate: isEnabled && !managedInfo?.autoupdate && preset.version > (managedInfo?.version ?? 0),
			exceedsRam: systemRamMB > 0 && preset.minRamMB > (systemRamMB - 8192),
			exceedsVram: totalVramMB > 0 && preset.minRamMB > (totalVramMB - 2048),
		});
	}

	// Sort: enableable presets first (descending by RAM), then non-enableable (ascending by RAM)
	presets.sort((a, b) => {
		if (a.exceedsRam !== b.exceedsRam) {
			return a.exceedsRam ? 1 : -1; // enableable first
		}
		if (a.exceedsRam) {
			return a.minRamMB - b.minRamMB; // non-enableable: ascending (smallest overshoot first)
		}
		return b.minRamMB - a.minRamMB; // enableable: descending (largest first)
	});

	const state: WebviewState = {
		presets,
		userSections: userSections.map(s => s.name),
		systemRamMB,
		totalVramMB,
	};

	if (fileVersion !== null && fileVersion > SUPPORTED_INI_VERSION) {
		state.iniFormatError = {
			fileVersion,
			supportedVersion: SUPPORTED_INI_VERSION,
		};
	}

	panel.webview.postMessage({ type: 'setState', state });
}

function getWebviewHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLaMA Models Manager</title>
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 16px;
		margin: 0;
	}
	h1 {
		font-size: 1.4em;
		margin-bottom: 16px;
		font-weight: 600;
	}
	.preset-table {
		width: 100%;
		border-collapse: collapse;
	}
	.preset-table th {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 1px solid var(--vscode-widget-border);
		font-weight: 600;
		font-size: 0.85em;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--vscode-descriptionForeground);
	}
	.preset-table td {
		padding: 8px 12px;
		border-bottom: 1px solid var(--vscode-widget-border);
		vertical-align: middle;
	}
	.preset-row.disabled {
		opacity: 0.5;
	}
	.preset-row.deprecated td {
		background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.05));
	}
	.badge {
		display: inline-block;
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 0.75em;
		font-weight: 600;
		margin-left: 8px;
	}
	.badge-deprecated {
		background: var(--vscode-inputValidation-warningBackground);
		color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
		border: 1px solid var(--vscode-inputValidation-warningBorder);
	}
	.badge-warning {
		color: var(--vscode-editorWarning-foreground);
	}
	.ram-info {
		font-size: 0.85em;
		color: var(--vscode-descriptionForeground);
	}
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		padding: 4px 12px;
		border-radius: 2px;
		cursor: pointer;
		font-size: 0.85em;
	}
	button:hover {
		background: var(--vscode-button-hoverBackground);
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.secondary-btn {
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
	}
	.secondary-btn:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}
	input[type="checkbox"] {
		width: 16px;
		height: 16px;
		cursor: pointer;
	}
	input[type="checkbox"]:disabled {
		cursor: not-allowed;
	}
	.user-section {
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid var(--vscode-widget-border);
	}
	.user-section h2 {
		font-size: 1.1em;
		margin-bottom: 8px;
	}
	.user-model {
		padding: 4px 0;
		color: var(--vscode-descriptionForeground);
	}
	.footer {
		margin-top: 16px;
		padding-top: 12px;
		border-top: 1px solid var(--vscode-widget-border);
	}
	.tooltip {
		position: relative;
		cursor: help;
	}
	.tooltip .tooltip-text {
		visibility: hidden;
		background: var(--vscode-editorHoverWidget-background);
		color: var(--vscode-editorHoverWidget-foreground);
		border: 1px solid var(--vscode-editorHoverWidget-border);
		padding: 4px 8px;
		border-radius: 3px;
		position: absolute;
		z-index: 100;
		bottom: 125%;
		left: 0;
		white-space: nowrap;
		font-size: 0.85em;
	}
	.tooltip:hover .tooltip-text {
		visibility: visible;
	}
	.error-banner {
		background: var(--vscode-inputValidation-errorBackground);
		color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
		border: 1px solid var(--vscode-inputValidation-errorBorder);
		padding: 10px 12px;
		border-radius: 3px;
		margin-bottom: 16px;
	}
</style>
</head>
<body>
<h1>LLaMA Models Manager</h1>
<div id="content">Loading...</div>
<script>
(function() {
	const vscode = acquireVsCodeApi();
	let state = null;

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'setState') {
			state = msg.state;
			render();
		}
	});

	function render() {
		if (!state) return;
		const container = document.getElementById('content');
		let html = '';
		const readOnly = !!state.iniFormatError;

		if (state.iniFormatError) {
			html += '<div class="error-banner">This models.ini uses format version ' +
				state.iniFormatError.fileVersion +
				', but LLaMA Copilot only supports version ' +
				state.iniFormatError.supportedVersion +
				'. Update the extension, or edit the file manually.</div>';
		}

		html += '<table class="preset-table">';
		html += '<thead><tr><th>Enabled</th><th>Model</th><th>RAM</th><th>Auto-update</th><th></th></tr></thead>';
		html += '<tbody>';

		for (const preset of state.presets) {
			const rowClass = [
				'preset-row',
				preset.exceedsRam ? 'disabled' : '',
				preset.deprecated ? 'deprecated' : '',
			].filter(Boolean).join(' ');

			html += '<tr class="' + rowClass + '">';

			// Enabled checkbox
			html += '<td>';
			if (preset.deprecated && preset.enabled) {
				html += '<input type="checkbox" checked disabled title="Deprecated — use the migrate button">';
			} else {
				html += '<input type="checkbox"' +
					(preset.enabled ? ' checked' : '') +
					(readOnly || preset.exceedsRam ? ' disabled' : '') +
					(preset.exceedsRam ? ' title="Exceeds available system RAM"' : '') +
					(readOnly ? ' title="models.ini format version is unsupported"' : '') +
					' onchange="toggleEnabled(\\'' + preset.id + '\\', this.checked)">';
			}
			html += '</td>';

			// Name + badges
			html += '<td>';
			html += escapeHtml(preset.displayName);
			if (preset.deprecated) {
				html += ' <span class="badge badge-deprecated">Deprecated</span>';
			}
			if (preset.exceedsVram && !preset.exceedsRam) {
				html += ' <span class="badge badge-warning tooltip">⚠️ VRAM<span class="tooltip-text">Model exceeds GPU VRAM. Will use CPU offloading (slower).</span></span>';
			}
			html += '</td>';

			// RAM info
			html += '<td class="ram-info">';
			html += formatRam(preset.minRamMB);
			if (preset.exceedsRam) {
				html += ' <span class="tooltip">❌<span class="tooltip-text">Requires more RAM than available (system RAM minus 8GB headroom)</span></span>';
			}
			html += '</td>';

			// Autoupdate checkbox
			html += '<td>';
			html += '<input type="checkbox"' +
				(preset.autoupdate ? ' checked' : '') +
				(readOnly || !preset.enabled ? ' disabled' : '') +
				' onchange="toggleAutoupdate(\\'' + preset.id + '\\', this.checked)">';
			html += '</td>';

			// Action button
			html += '<td>';
			if (preset.deprecated && preset.enabled && preset.successorName) {
				html += '<button' + (readOnly ? ' disabled' : '') +
					' onclick="migrate(\\'' + preset.id + '\\')">Change to ' + escapeHtml(preset.successorName) + '</button>';
			} else if (preset.hasUpdate) {
				html += '<button class="secondary-btn"' + (readOnly ? ' disabled' : '') +
					' onclick="upgrade(\\'' + preset.id + '\\')">Upgrade</button>';
			}
			html += '</td>';

			html += '</tr>';
		}

		html += '</tbody></table>';

		// User sections
		if (state.userSections.length > 0) {
			html += '<div class="user-section">';
			html += '<h2>User-Added Models</h2>';
			for (const name of state.userSections) {
				html += '<div class="user-model">[' + escapeHtml(name) + ']</div>';
			}
			html += '</div>';
		}

		// Footer
		html += '<div class="footer">';
		html += '<button class="secondary-btn" onclick="openIni()">Edit models.ini</button>';
		if (state.systemRamMB > 0) {
			html += ' <span class="ram-info">System RAM: ' + formatRam(state.systemRamMB) + '</span>';
		}
		if (state.totalVramMB > 0) {
			html += ' <span class="ram-info"> | VRAM: ' + formatRam(state.totalVramMB) + '</span>';
		}
		html += '</div>';

		container.innerHTML = html;
	}

	function formatRam(mb) {
		if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
		return mb + ' MB';
	}

	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	window.toggleEnabled = function(presetId, enabled) {
		vscode.postMessage({ type: 'toggleEnabled', presetId, enabled });
	};
	window.toggleAutoupdate = function(presetId, autoupdate) {
		vscode.postMessage({ type: 'toggleAutoupdate', presetId, autoupdate });
	};
	window.upgrade = function(presetId) {
		vscode.postMessage({ type: 'upgrade', presetId });
	};
	window.migrate = function(presetId) {
		vscode.postMessage({ type: 'migrate', presetId });
	};
	window.openIni = function() {
		vscode.postMessage({ type: 'openIni' });
	};

	// Signal ready
	vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
