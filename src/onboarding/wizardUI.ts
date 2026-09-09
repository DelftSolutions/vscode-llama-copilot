/**
 * Onboarding wizard webview panel.
 *
 * The panel markup lives in `media/onboarding/index.html` (static HTML, so
 * designers can edit the UI without touching TypeScript); interactivity
 * lives in `media/onboarding/wizard-controller.js`, built on the shared
 * kernel `media/js/webview-core.js`. The protocol between this file and the
 * webview — message types, state shape, lifecycle — is documented at the top
 * of that HTML file and enforced by `wizardHtml.test.ts`. The
 * `WizardState` / `WizardAction` types below are the single source of truth
 * for the contract.
 *
 * The HTML is a TEMPLATE: `loadWebviewHtml()` replaces two placeholders
 * (`__LLAMA_WEBVIEW_SCRIPTS__` → the two injected <script> tags,
 * `__LLAMA_ONBOARDING_ICON_URL__` → the icon webview URI) before assigning
 * it to `webview.html`.
 *
 * Data flow (one direction at a time):
 *   host → webview:  postMessage({ type: 'setState', state })   (full state, always)
 *   webview → host:  postMessage(action)                        (see WizardAction)
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Path of the wizard webview HTML, relative to the extension root. */
const WEBVIEW_HTML_RELATIVE_PATH = path.join('media', 'onboarding', 'index.html');

/** Shared webview kernel (Stimulus-like), relative to the extension root. */
const WEBVIEW_CORE_JS_RELATIVE_PATH = path.join('media', 'js', 'webview-core.js');

/** Wizard controller, relative to the extension root. */
const WIZARD_CONTROLLER_JS_RELATIVE_PATH = path.join('media', 'onboarding', 'wizard-controller.js');

/** Generated Tailwind CSS for the onboarding wizard, relative to the extension root. */
const TAILWIND_CSS_RELATIVE_PATH = path.join('media', 'onboarding', 'tailwind.css');

/** Placeholder in the HTML replaced with the webview URI of the llama icon (light theme). */
const ICON_URL_PLACEHOLDER = '__LLAMA_ONBOARDING_ICON_URL__';
/** Placeholder in the HTML replaced with the webview URI of the llama icon (dark theme). */
const ICON_URL_DARK_PLACEHOLDER = '__LLAMA_ONBOARDING_ICON_URL_DARK__';

/**
 * Placeholder in the HTML replaced with the two <script> tags (core first,
 * controller second) pointing at webview-origin URIs.
 */
const WEBVIEW_SCRIPTS_PLACEHOLDER = '__LLAMA_WEBVIEW_SCRIPTS__';

/** Placeholder in the HTML <style> block replaced with the generated Tailwind CSS. */
const TAILWIND_CSS_PLACEHOLDER = '__LLAMA_TAILWIND_CSS__';

/** The screen currently shown in the wizard. */
export type WizardStep = 'mode' | 'downloading' | 'model' | 'starting' | 'done';

/**
 * All wizard screens (mirrors the WizardStep union). wizardHtml.test.ts
 * uses this to verify the static HTML has one <section> per screen — keep
 * in sync when adding a step to WizardStep.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
	'mode',
	'downloading',
	'model',
	'starting',
	'done',
];

/** Mode selected on the first screen ('skip' is an action, not persisted as a mode). */
export type WizardModeChoice = 'managed' | 'advanced' | 'skip';

export interface WizardModelOption {
	id: string;
	displayName: string;
	minRamMB: number;
	/** Not recommended to enable on this machine (RAM gating, same rule as Models Manager). */
	exceedsRam: boolean;
	isRecommended: boolean;
}

export interface WizardSetupError {
	title: string;
	detail: string;
}

/** Full state of the wizard; the host pushes this on every change. */
export interface WizardState {
	step: WizardStep;

	// Screen 1 — mode
	selectedMode: WizardModeChoice | null;

	// Screen 1.1 — binary download
	downloadPercent: number | null;
	downloadError: WizardSetupError | null;

	// Screen 2 — model picker
	hardwareLine: string;
	recommendedReason: string | null;
	models: WizardModelOption[];
	selectedPresetId: string | null;
	showAllModels: boolean;

	// Screen 3 — starting
	systemChecked: boolean;
	serverStarted: boolean;
	loadingModelName: string | null;
	startError: WizardSetupError | null;
}

/** Actions the webview can send to the host. */
export type WizardAction =
	| { type: 'ready' }
	| { type: 'selectMode'; mode: WizardModeChoice }
	| { type: 'continue' }
	| { type: 'back' }
	| { type: 'retry' }
	| { type: 'selectModel'; presetId: string }
	| { type: 'toggleShowAll' }
	| { type: 'start' }
	| { type: 'close' }
	| { type: 'openChat' };

/**
 * All action `type` strings the host accepts (mirrors the WizardAction union).
 * wizardHtml.test.ts uses this to verify the webview HTML only posts known
 * actions — keep in sync when adding a variant to WizardAction.
 */
export const WIZARD_ACTION_TYPES = [
	'ready',
	'selectMode',
	'continue',
	'back',
	'retry',
	'selectModel',
	'toggleShowAll',
	'start',
	'close',
	'openChat',
] as const;

/**
 * Singleton wizard panel. Create once (via the orchestrator), then
 * `reveal()` / `postState()` / `dispose()` as needed.
 */
export class OnboardingWizardPanel {
	private panel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onAction: (action: WizardAction) => void
	) { }

	/** Create the panel if needed, otherwise bring it to front. */
	reveal(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'llamaCopilot.onboarding',
			'Llama Copilot Setup',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		this.panel.webview.onDidReceiveMessage((msg: WizardAction) => {
			void this.onAction(msg);
		});

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});

		// The HTML is loaded from disk asynchronously. Any setState posted
		// before the webview's script runs is lost, but the webview sends
		// { type: 'ready' } once loaded and the host responds by re-sending
		// the full current state — see the lifecycle section in the HTML file.
		void this.loadWebviewHtml();
	}

	postState(state: WizardState): void {
		this.panel?.webview.postMessage({ type: 'setState', state });
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	/**
	 * Assemble the wizard webview from media/onboarding/index.html,
	 * media/js/webview-core.js, and media/onboarding/wizard-controller.js,
	 * and assign it to the panel.
	 *
	 * The HTML is a template: the `__LLAMA_WEBVIEW_SCRIPTS__` placeholder is
	 * replaced with two <script> tags pointing at webview-origin URIs (the
	 * VS Code CSP blocks remote content, so local files must be injected
	 * through asWebviewUri), and the two icon placeholders
	 * (`__LLAMA_ONBOARDING_ICON_URL__` and
	 * `__LLAMA_ONBOARDING_ICON_URL_DARK__` — the light/dark marks) with the
	 * icons' webview URIs. All placeholders also occur in the header
	 * documentation comments, so the replace is global.
	 *
	 * The load is async: state posted before the webview's scripts run is
	 * lost, but the webview sends { type: 'ready' } once booted and the
	 * host responds by re-sending the full current state (see the lifecycle
	 * section in the HTML file header).
	 */
	private async loadWebviewHtml(): Promise<void> {
		const panel = this.panel;
		if (!panel) return;

		try {
			const htmlPath = vscode.Uri.joinPath(this.extensionUri, WEBVIEW_HTML_RELATIVE_PATH);
			const template = await fs.readFile(htmlPath.fsPath, 'utf8');
			const iconUrl = panel.webview
				.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'llama-icon-light.png'))
				.toString();
			const iconDarkUrl = panel.webview
				.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'llama-icon-dark.png'))
				.toString();

			const scriptTag = (relativePath: string): string => {
				const uri = panel.webview
					.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, relativePath))
					.toString();
				return '<script src="' + uri + '"></script>';
			};
			// Core FIRST (defines LlamaWebview), controller second (boots).
			const scripts =
				scriptTag(WEBVIEW_CORE_JS_RELATIVE_PATH) +
				scriptTag(WIZARD_CONTROLLER_JS_RELATIVE_PATH);

			// Load generated Tailwind CSS (graceful fallback — empty string if missing).
			let tailwindCss = '';
			try {
				const cssPath = vscode.Uri.joinPath(this.extensionUri, TAILWIND_CSS_RELATIVE_PATH);
				tailwindCss = await fs.readFile(cssPath.fsPath, 'utf8');
			} catch {
				// CSS not built yet (e.g. dev before first compile). The placeholder
				// will be replaced with an empty string — the static CSS in the HTML
				// still provides all styling.
			}

			panel.webview.html = template
				.replace(new RegExp(TAILWIND_CSS_PLACEHOLDER, 'g'), tailwindCss)
				.replace(new RegExp(WEBVIEW_SCRIPTS_PLACEHOLDER, 'g'), scripts)
				.replace(new RegExp(ICON_URL_DARK_PLACEHOLDER, 'g'), iconDarkUrl)
				.replace(new RegExp(ICON_URL_PLACEHOLDER, 'g'), iconUrl);
		} catch (err) {
			// The HTML ships with the extension; a read failure means a broken
			// install. Show a minimal error instead of a blank panel.
			const msg = err instanceof Error ? err.message : String(err);
			panel.webview.html =
				'<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); padding: 24px;">' +
				'<h1>Llama Copilot Setup</h1>' +
				'<p>Failed to load the setup UI: ' + msg.replace(/[&<>]/g, '') + '</p></body></html>';
		}
	}
}
