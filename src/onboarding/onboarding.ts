/**
 * Onboarding orchestrator: drives the wizard webview through the managed setup
 * flow — mode choice → binary download → model pick → server start → done.
 *
 * - State is persisted in globalState, so the wizard resumes where the user
 *   left off on the next launch.
 * - `llamaCopilot.server.managed` is written to true ONLY when the managed
 *   path completes .
 * - Upgrading users with an already-working setup are silently marked done
 *   and never see the wizard.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import { CONFIG_SECTION } from '../config';
import { isSupportedPlatform } from '../server/platform';
import { BinaryManager } from '../server/binaryManager';
import { ModelsIniManager } from '../server/modelsIniManager';
import { LlamaServerManager, ManagedServerState } from '../server/serverManager';
import { queryDevices, getCachedSystemInfo } from '../server/deviceQuery';
import { MODEL_PRESETS, getPresetById } from '../server/presets';
import { recommendModel, formatHardwareLine } from './recommendation';
import { getDiskFreeMB, getCpuName } from './diskInfo';
import { classifySetupError } from './errorCategorizer';
import {
	KVStore,
	OnboardingData,
	OnboardingStep,
	freshOnboardingData,
	loadOnboardingState,
	saveOnboardingState,
} from './onboardingState';
import { OnboardingWizardPanel, WizardAction, WizardState } from './wizardUI';
import { OnboardingStatusBar } from './statusBar';

/** What happened after the activation-time auto-run check. */
export type AutoRunOutcome = 'wizard' | 'normal';

export interface OnboardingDeps {
	/** Memento where onboarding state is persisted (context.globalState). */
	globalState: KVStore;
	/** globalStorage path (used to probe free disk space). */
	globalStoragePath: string;
	extensionUri: vscode.Uri;
	/** Create the binary/models-ini managers if they don't exist yet. */
	ensureManagers: () => Promise<void>;
	getBinaryManager: () => BinaryManager | undefined;
	getModelsIniManager: () => ModelsIniManager | undefined;
	getServerManager: () => LlamaServerManager | undefined;
	/** Ensure the server manager exists and start the server (first start). */
	startServer: () => Promise<void>;
	/** Kick off the background binary auto-update check (no-op if not applicable). */
	runBackgroundUpdateCheck: () => void;
	isManaged: () => boolean;
	hasUserEndpoints: () => boolean;
	getPort: () => number;
}

const INITIAL_STATE: WizardState = {
	step: 'mode',
	selectedMode: 'managed',
	downloadPercent: null,
	downloadError: null,
	hardwareLine: '',
	recommendedReason: null,
	models: [],
	selectedPresetId: null,
	showAllModels: false,
	systemChecked: false,
	serverStarted: false,
	loadingModelName: null,
	startError: null,
};

export class OnboardingOrchestrator {
	private readonly panel: OnboardingWizardPanel;
	private readonly statusBar: OnboardingStatusBar;
	private data: OnboardingData = freshOnboardingData('mode');
	private state: WizardState = { ...INITIAL_STATE };
	private lastDownloadPercent: number | null = null;
	private downloadInProgress = false;
	private startInProgress = false;
	private completed = false;
	private serverStateSub: vscode.Disposable | undefined;
	private disposed = false;

	constructor(private readonly deps: OnboardingDeps) {
		this.panel = new OnboardingWizardPanel(deps.extensionUri, action => {
			void this.handleAction(action);
		});
		this.statusBar = new OnboardingStatusBar();
	}

	/**
	 * Activation entry point. Decides whether to open the wizard:
	 * - done / skipped → 'normal' (never auto-open; skip is an explicit choice)
	 * - legacy working setup → silently mark done → 'normal'
	 * - fresh install / partial setup → open or resume the wizard → 'wizard'
	 *
	 * Returns 'wizard' when the wizard (not the normal managed init) drives
	 * the server start.
	 */
	async maybeAutoRun(): Promise<AutoRunOutcome> {
		if (!isSupportedPlatform()) return 'normal';

		const stored = await loadOnboardingState(this.deps.globalState);
		this.data = stored ?? freshOnboardingData('mode');

		if (stored && stored.status !== 'in_progress') {
			return 'normal';
		}

		if (!stored) {
			// No onboarding state at all. Upgrading users often already have a
			// working setup — never pester them with the wizard in that case.
			if (await this.silentSkipIfWorkingSetup()) {
				return 'normal';
			}
			// Fresh install. If managed mode was enabled out-of-band (e.g. via
			// settings), skip straight to the download.
			const managed = this.deps.isManaged();
			const step: OnboardingStep = managed ? 'downloading' : 'mode';
			this.data = freshOnboardingData(step);
			if (managed) this.data.mode = 'managed';
			await this.persist();
			this.openAtStep(step);
			return 'wizard';
		}

		// In progress → resume at the saved step.
		this.openAtStep(this.data.step);
		return 'wizard';
	}

	/**
	 * Manual entry point (command palette / status bar click).
	 * (Re)starts the wizard from the mode screen.
	 */
	async run(): Promise<void> {
		if (!isSupportedPlatform()) {
			this.showPlatformUnsupported();
			return;
		}
		const presetId = this.data.presetId;
		this.data = freshOnboardingData('mode');
		if (presetId) this.data.presetId = presetId;
		await this.persist();
		this.completed = false;
		this.openAtStep('mode');
	}

	/**
	 * Called when the user toggles server.managed from false to true
	 * mid-session. No-ops when onboarding already completed (the normal
	 * managed flow handles it).
	 */
	async runForManaged(): Promise<void> {
		if (!isSupportedPlatform()) {
			this.showPlatformUnsupported();
			return;
		}
		const stored = await loadOnboardingState(this.deps.globalState);
		if (stored && stored.status !== 'in_progress') return;

		// Binary already installed? Skip straight to the model picker.
		let binaryReady = false;
		try {
			await this.deps.ensureManagers();
			binaryReady = (await this.deps.getBinaryManager()?.isInstalled()) ?? false;
		} catch {
			binaryReady = false;
		}

		const step: OnboardingStep = binaryReady ? 'model' : 'downloading';
		this.data = freshOnboardingData(step);
		this.data.mode = 'managed';
		if (stored?.presetId) this.data.presetId = stored.presetId;
		await this.persist();
		this.completed = false;
		this.openAtStep(step);
	}

	/** Close the panel and release resources. Call on extension deactivate. */
	dispose(): void {
		this.disposed = true;
		this.serverStateSub?.dispose();
		this.serverStateSub = undefined;
		this.statusBar.dispose();
		this.panel.dispose();
	}

	// ------------------------------------------------------------------
	// Entry points into individual steps
	// ------------------------------------------------------------------

	private openAtStep(step: OnboardingStep): void {
		if (this.disposed) return;
		this.panel.reveal();
		switch (step) {
			case 'mode':
				this.updateState({
					step: 'mode',
					selectedMode: this.data.mode ?? 'managed',
				});
				break;
			case 'downloading':
				this.updateState({ step: 'downloading', downloadError: null });
				void this.startDownload();
				break;
			case 'model':
				void this.prepareModelStep();
				break;
			case 'starting':
				void this.startServerPhase();
				break;
		}
	}

	private async startDownload(): Promise<void> {
		const binary = this.deps.getBinaryManager();
		if (!binary) return;

		// Already installed (e.g. VS Code closed right after the download)?
		try {
			if (await binary.isInstalled()) {
				await this.advanceToModelStep();
				return;
			}
		} catch {
			// Fall through to the download.
		}

		if (this.downloadInProgress) return;
		this.downloadInProgress = true;
		this.lastDownloadPercent = null;
		this.statusBar.setDownloading();
		this.updateState({ step: 'downloading', downloadPercent: null, downloadError: null });

		try {
			const latest = await binary.latestVersion();
			if (!latest) {
				const err = classifySetupError(
					new Error('Network error: could not reach GitHub to fetch the latest llama-server release.')
				);
				this.updateState({ downloadError: { title: err.title, detail: err.detail } });
				this.statusBar.setError();
				return;
			}

			const ok = await binary.downloadWithCallback(latest, percent => {
				if (percent === this.lastDownloadPercent) return;
				this.lastDownloadPercent = percent;
				this.statusBar.setDownloading(percent);
				this.updateState({ downloadPercent: percent });
			});

			if (!ok) {
				// Cancelled — the wizard has no cancel button; the user closed the
				// panel mid-download. Stay on the screen with a retry affordance.
				this.updateState({
					downloadError: {
						title: 'Download cancelled',
						detail: 'The download was stopped. Press Retry to start over.',
					},
				});
				return;
			}

			await this.advanceToModelStep();
		} catch (err) {
			const classified = classifySetupError(err);
			this.updateState({ downloadError: { title: classified.title, detail: classified.detail } });
			this.statusBar.setError();
		} finally {
			this.downloadInProgress = false;
		}
	}

	private async advanceToModelStep(): Promise<void> {
		const binary = this.deps.getBinaryManager();
		if (binary) {
			const cliPath = await binary.getCurrentCliPath();
			if (cliPath) {
				// Also feeds the RAM/VRAM gating on the model screen.
				// Non-fatal: we fall back to os.totalmem() if this fails.
				await queryDevices(cliPath).catch(() => { /* non-fatal */ });
			}
		}
		await this.prepareModelStep();
	}

	private async prepareModelStep(): Promise<void> {
		this.data.step = 'model';
		await this.persist();

		const systemRamMB = getCachedSystemInfo()?.systemRamMB ?? Math.floor(os.totalmem() / (1024 * 1024));
		const [diskFreeMB, cpuName] = await Promise.all([
			getDiskFreeMB(this.deps.globalStoragePath),
			getCpuName(),
		]);

		const rec = recommendModel(MODEL_PRESETS, { systemRamMB: systemRamMB }, diskFreeMB);
		const models = MODEL_PRESETS
			.filter(p => !p.deprecated)
			.map(p => ({
				id: p.id,
				displayName: p.displayName,
				minRamMB: p.minRamMB,
				// Same RAM gating rule as the Models Manager UI.
				exceedsRam: systemRamMB > 0 && p.minRamMB > systemRamMB - 8192,
				isRecommended: p.id === rec?.presetId,
			}));

		const selectedPresetId = this.data.presetId ?? rec?.presetId ?? models[0]?.id ?? null;
		if (selectedPresetId && this.data.presetId !== selectedPresetId) {
			this.data.presetId = selectedPresetId;
			await this.persist();
		}

		this.updateState({
			step: 'model',
			hardwareLine: formatHardwareLine(cpuName, systemRamMB, diskFreeMB),
			recommendedReason: rec?.reason ?? null,
			models,
			selectedPresetId,
			showAllModels: false,
		});
	}

	private async startServerPhase(): Promise<void> {
		const presetId = this.data.presetId;
		if (!presetId) return;
		const preset = getPresetById(presetId);
		const modelName = preset?.displayName ?? presetId;

		this.data.step = 'starting';
		await this.persist();

		this.statusBar.setStarting();
		this.updateState({
			step: 'starting',
			systemChecked: true,
			serverStarted: false,
			loadingModelName: null,
			startError: null,
		});

		if (this.startInProgress) return;
		this.startInProgress = true;
		try {
			const modelsIni = this.deps.getModelsIniManager();
			if (modelsIni) {
				await modelsIni.enablePreset(presetId);
			}
			await this.deps.startServer();
			this.watchServer(modelName);
		} catch (err) {
			const classified = classifySetupError(err);
			this.updateState({ startError: { title: classified.title, detail: classified.detail } });
			this.statusBar.setError();
		} finally {
			this.startInProgress = false;
		}
	}

	// ------------------------------------------------------------------
	// Server state tracking (Screen 3)
	// ------------------------------------------------------------------

	private watchServer(modelName: string): void {
		const mgr = this.deps.getServerManager();
		if (!mgr) return;

		this.serverStateSub?.dispose();
		this.serverStateSub = mgr.onStateChanged((serverState: ManagedServerState) => {
			if (this.disposed || this.completed) return;
			switch (serverState) {
				case 'starting':
					this.statusBar.setStarting();
					this.updateState({ serverStarted: true, startError: null });
					break;
				case 'loading_model':
					this.statusBar.setLoading(modelName);
					this.updateState({ serverStarted: true, loadingModelName: modelName });
					break;
				case 'running':
					void this.onServerRunning();
					break;
				case 'crashed':
				case 'not_installed':
					this.showStartError();
					break;
				default:
					break;
			}
		});

		// The state may already be past 'starting' (fast reuse of a running
		// process, or a cached model that loads quickly).
		const current = mgr.getState();
		if (current === 'running') {
			void this.onServerRunning();
		} else if (current === 'crashed' || current === 'not_installed') {
			this.showStartError();
		} else if (current === 'loading_model') {
			this.statusBar.setLoading(modelName);
			this.updateState({ serverStarted: true, loadingModelName: modelName });
		} else {
			this.updateState({ serverStarted: true });
		}
	}

	private showStartError(): void {
		const port = this.deps.getPort();
		this.updateState({
			startError: {
				title: 'The server did not start',
				detail:
					`llama-server exited during startup. If another process is using port ${port}, ` +
					'stop it or change the port in Settings → Llama Copilot → Server → Port. ' +
					'Full details are in the "llama-server" output channel.',
			},
		});
		this.statusBar.setError();
	}

	/**
	 * The server is healthy. Write the managed flag (managed path only),
	 * mark onboarding done, and show the success screen + notification.
	 */
	private async onServerRunning(): Promise<void> {
		if (this.completed) return;
		this.completed = true;
		this.serverStateSub?.dispose();
		this.serverStateSub = undefined;

		// Persist 'done' BEFORE writing server.managed=true: the config change
		// listener reacts to that write, and must see the completed onboarding
		// state (not re-open the wizard via runForManaged).
		this.data.status = 'done';
		await this.persist();

		// Per spec: `server.managed` is written only when the managed path completes.
		if (this.data.mode === 'managed') {
			try {
				await vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.update('server.managed', true, vscode.ConfigurationTarget.Global);
			} catch {
				// Non-fatal — the server is already running.
			}
		}

		this.statusBar.hide();
		this.updateState({ step: 'done' });

		vscode.window
			.showInformationMessage('Your model is ready', 'Open Chat')
			.then(selection => {
				if (selection === 'Open Chat') {
					void vscode.commands.executeCommand('workbench.action.chat.open');
				}
			});

		this.deps.runBackgroundUpdateCheck();
	}

	// ------------------------------------------------------------------
	// Webview actions
	// ------------------------------------------------------------------

	private async handleAction(action: WizardAction): Promise<void> {
		switch (action.type) {
			case 'ready':
				// The webview finished loading — send it the current state.
				this.panel.postState(this.state);
				break;

			case 'selectMode':
				if (this.state.step !== 'mode') return;
				this.updateState({ selectedMode: action.mode });
				break;

			case 'continue':
				if (this.state.step !== 'mode' || !this.state.selectedMode) return;
				if (this.state.selectedMode === 'managed') {
					this.data.mode = 'managed';
					await this.persist();
					this.updateState({ step: 'downloading', downloadPercent: null, downloadError: null });
					void this.startDownload();
				} else if (this.state.selectedMode === 'advanced') {
					await this.finishAdvanced();
				} else {
					await this.finishSkip();
				}
				break;

			case 'back':
				if (this.state.step === 'downloading' || this.state.step === 'model') {
					this.updateState({ step: 'mode', selectedMode: this.data.mode ?? 'managed' });
				}
				break;

			case 'retry':
				if (this.state.step === 'downloading') {
					void this.startDownload();
				} else if (this.state.step === 'starting') {
					void this.startServerPhase();
				}
				break;

			case 'selectModel':
				if (this.state.step !== 'model') return;
				const option = this.state.models.find(m => m.id === action.presetId && !m.exceedsRam);
				if (!option) return;
				this.data.presetId = action.presetId;
				await this.persist();
				this.updateState({ selectedPresetId: action.presetId });
				break;

			case 'toggleShowAll':
				this.updateState({ showAllModels: !this.state.showAllModels });
				break;

			case 'start':
				if (this.state.step === 'model' && this.state.selectedPresetId) {
					void this.startServerPhase();
				}
				break;

			case 'close':
				// The step is already persisted. The server keeps starting in the
				// background and the status bar keeps working; next launch resumes
				// the wizard at the saved step.
				this.panel.dispose();
				break;

			case 'openChat':
				void vscode.commands.executeCommand('workbench.action.chat.open');
				break;
		}
	}

	private async finishSkip(): Promise<void> {
		// Explicit "not now": never auto-open the wizard again. It stays
		// available via the command palette ("Llama Copilot: Run Setup").
		this.data.status = 'skipped';
		await this.persist();
		this.statusBar.hide();
		this.panel.dispose();
	}

	private async finishAdvanced(): Promise<void> {
		// "I'll bring my own server": open the endpoint settings.
		// server.managed stays false (the default) — nothing to write.
		await vscode.commands.executeCommand('workbench.action.openSettings', 'llamaCopilot.endpoints');
		this.data.status = 'done';
		this.data.mode = 'advanced';
		await this.persist();
		this.statusBar.hide();
		this.panel.dispose();
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/**
	 * Prevents every upgrading user (many with a working setup already) from
	 * getting the wizard auto-opened on their next launch:
	 * - managed mode + installed binary + enabled presets → silently done
	 * - bring-your-own endpoints configured → silently done
	 */
	private async silentSkipIfWorkingSetup(): Promise<boolean> {
		try {
			await this.deps.ensureManagers();
			const managed = this.deps.isManaged();
			if (managed) {
				const binary = this.deps.getBinaryManager();
				const modelsIni = this.deps.getModelsIniManager();
				if (binary && modelsIni) {
					const hasBinary = await binary.isInstalled();
					const enabled = await modelsIni.getEnabledPresets();
					if (hasBinary && enabled.size > 0) {
						this.data = { status: 'done', step: 'mode', mode: 'managed' };
						await this.persist();
						return true;
					}
				}
			} else if (this.deps.hasUserEndpoints()) {
				this.data = { status: 'done', step: 'mode', mode: 'advanced' };
				await this.persist();
				return true;
			}
		} catch {
			// Fall through — show the wizard rather than failing silently.
		}
		return false;
	}

	private async persist(): Promise<void> {
		await saveOnboardingState(this.deps.globalState, this.data);
	}

	private updateState(partial: Partial<WizardState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...partial };
		this.panel.postState(this.state);
	}

	private showPlatformUnsupported(): void {
		vscode.window.showErrorMessage(
			`Managed llama-server is not available for your platform (${process.platform}/${process.arch}). ` +
			'You can still use the extension by running llama-server yourself and configuring an endpoint in Settings → Llama Copilot → Endpoints.'
		);
	}
}
