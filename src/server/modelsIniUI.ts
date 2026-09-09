/**
 * WebviewPanel-based Models Manager UI.
 * Shows presets with enabled/autoupdate checkboxes, RAM/VRAM gating,
 * deprecation badges, and upgrade buttons.
 *
 * The panel markup lives in `media/models-manager/index.html` (static HTML);
 * interactivity lives in `media/models-manager/models-manager-controller.js`,
 * built on the shared kernel `media/js/webview-core.js`. The protocol
 * between this file and the webview — message types, state shape, lifecycle —
 * is documented at the top of that HTML file and enforced by
 * `modelsIniHtml.test.ts`. The `WebviewState` / `WebviewMessage` types below
 * are the single source of truth for the contract.
 *
 * Data flow (one direction at a time):
 *   host → webview:  postMessage({ type: 'setState', state })   (full state, always)
 *   webview → host:  postMessage(action)                        (see WebviewMessage)
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MODEL_PRESETS, ModelPreset, getPresetById } from './presets';
import {
	ModelsIniManager,
	ManagedSection,
	UnsupportedIniVersionError,
	SUPPORTED_INI_VERSION,
} from './modelsIniManager';
import { SystemInfo, getCachedSystemInfo } from './deviceQuery';

/** Path of the models manager webview HTML, relative to the extension root. */
const WEBVIEW_HTML_RELATIVE_PATH = path.join('media', 'models-manager', 'index.html');

/** Shared webview kernel (Stimulus-like), relative to the extension root. */
const WEBVIEW_CORE_JS_RELATIVE_PATH = path.join('media', 'js', 'webview-core.js');

/** Models manager controller, relative to the extension root. */
const MODELS_MANAGER_CONTROLLER_JS_RELATIVE_PATH = path.join('media', 'models-manager', 'models-manager-controller.js');

/** Generated Tailwind CSS for the models manager, relative to the extension root. */
const TAILWIND_CSS_RELATIVE_PATH = path.join('media', 'models-manager', 'tailwind.css');

/**
 * Placeholder in the HTML replaced with the two <script> tags (core first,
 * controller second) pointing at webview-origin URIs.
 */
const WEBVIEW_SCRIPTS_PLACEHOLDER = '__LLAMA_WEBVIEW_SCRIPTS__';

/** Placeholder in the HTML <style> block replaced with the generated Tailwind CSS. */
const TAILWIND_CSS_PLACEHOLDER = '__LLAMA_TAILWIND_CSS__';

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

/**
 * All action `type` strings the host accepts (mirrors the WebviewMessage
 * union minus 'ready', which is posted by webview-core.js).
 * modelsIniHtml.test.ts uses this to verify the webview only posts known
 * actions — keep in sync when adding a variant to WebviewMessage.
 */
export const MODELS_MANAGER_ACTION_TYPES = [
	'toggleEnabled',
	'toggleAutoupdate',
	'upgrade',
	'migrate',
	'openIni',
] as const;

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
		'Llama Models Manager',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		}
	);

	// The HTML is loaded from disk asynchronously. Any setState posted before
	// the webview's scripts run is lost, but the webview sends
	// { type: 'ready' } once booted and the host responds by re-sending the
	// full current state (see the HTML file header).
	void loadWebviewHtml(currentPanel, extensionUri);

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

/**
 * Assemble the models manager webview from media/models-manager/index.html,
 * media/js/webview-core.js, and
 * media/models-manager/models-manager-controller.js, and assign it to the
 * panel.
 *
 * The HTML is a template: the `__LLAMA_WEBVIEW_SCRIPTS__` placeholder is
 * replaced with two <script> tags pointing at webview-origin URIs (the VS
 * Code CSP blocks remote content, so local files must be injected through
 * asWebviewUri) — core FIRST (defines LlamaWebview), controller second
 * (boots). The placeholder also occurs in the header documentation comments,
 * so the replace is global.
 */
async function loadWebviewHtml(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): Promise<void> {
	try {
		const htmlPath = vscode.Uri.joinPath(extensionUri, WEBVIEW_HTML_RELATIVE_PATH);
		const template = await fs.readFile(htmlPath.fsPath, 'utf8');

		const scriptTag = (relativePath: string): string => {
			const uri = panel.webview
				.asWebviewUri(vscode.Uri.joinPath(extensionUri, relativePath))
				.toString();
			return '<script src="' + uri + '"></script>';
		};
		const scripts =
			scriptTag(WEBVIEW_CORE_JS_RELATIVE_PATH) +
			scriptTag(MODELS_MANAGER_CONTROLLER_JS_RELATIVE_PATH);

		// Load generated Tailwind CSS (graceful fallback — empty string if missing).
		let tailwindCss = '';
		try {
			const cssPath = vscode.Uri.joinPath(extensionUri, TAILWIND_CSS_RELATIVE_PATH);
			tailwindCss = await fs.readFile(cssPath.fsPath, 'utf8');
		} catch {
			// CSS not built yet (e.g. dev before first compile). The placeholder
			// will be replaced with an empty string — the static CSS in the HTML
			// still provides all styling.
		}

		panel.webview.html = template
			.replace(new RegExp(TAILWIND_CSS_PLACEHOLDER, 'g'), tailwindCss)
			.replace(new RegExp(WEBVIEW_SCRIPTS_PLACEHOLDER, 'g'), scripts);
	} catch (err) {
		// The HTML ships with the extension; a read failure means a broken
		// install. Show a minimal error instead of a blank panel.
		const msg = err instanceof Error ? err.message : String(err);
		panel.webview.html =
			'<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); padding: 24px;">' +
			'<h1>Llama Models Manager</h1>' +
			'<p>Failed to load the models manager UI: ' + msg.replace(/[&<>]/g, '') + '</p></body></html>';
	}
}
