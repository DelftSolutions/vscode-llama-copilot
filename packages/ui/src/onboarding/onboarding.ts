/**
 * Onboarding orchestrator: drives the wizard webview through the managed setup
 * flow — mode choice → binary download → model pick → server start → done.
 *
 * - State is persisted in globalState, so the wizard resumes where the user
 *   left off on the next launch.
 * - `llamaCopilot.server.managed` is written to true as soon as the user
 *   picks the managed mode on screen 1, so managed commands and the
 *   auto-start on the next launch work even if the binary/model setup is
 *   interrupted later. The completion path re-writes it as a fallback, and
 *   choosing Advanced/Skip afterwards reverts it if this session set it.
 * - Upgrading users with an already-working setup are silently marked done
 *   and never see the wizard.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import { CONFIG_SECTION } from '@llama-copilot/shared';
import { isSupportedPlatform } from '../server/platform.js';
import { BinaryManager } from '../server/binaryManager.js';
import { ModelsIniManager } from '../server/modelsIniManager.js';
import { LlamaServerManager, ManagedServerState } from '../server/serverManager.js';
import { queryDevices, getCachedSystemInfo } from '../server/deviceQuery.js';
import { MODEL_PRESETS, getPresetById } from '../server/presets.js';
import { recommendModel, formatHardwareLine } from './recommendation.js';
import { getDiskFreeMB, getCpuName } from './diskInfo.js';
import { classifySetupError } from './errorCategorizer.js';
import {
	KVStore,
	OnboardingData,
	OnboardingStep,
	freshOnboardingData,
	loadOnboardingState,
	saveOnboardingState,
} from './onboardingState.js';
import { OnboardingWizardPanel, WizardAction, WizardState } from './wizardUI.js';
import { OnboardingStatusBar } from './statusBar.js';

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
	isRemoteSession: false,
	sshHost: null,
	forwards: [],
	sshSetupStatus: 'pending',
	sshSetupError: null,
	sshDiffPreview: null,
	doneVariant: 'local',
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
	/** Value of `server.managed` when the current wizard session started. */
	private managedEnabledAtSessionStart = false;
	/** True when this session wrote `server.managed` to true (screen 1). */
	private managedEnabledBySession = false;

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

		this.managedEnabledAtSessionStart = this.deps.isManaged();
		this.managedEnabledBySession = false;

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
			await this.ensureManagersReady();
			this.openAtStep(step);
			return 'wizard';
		}

		// In progress → resume at the saved step. The managers are created
		// lazily by the extension and this path is the one that usually
		// skips their creation — without them a resume at 'downloading'
		// would freeze on "Connecting..." forever.
		await this.ensureManagersReady();
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
		this.managedEnabledAtSessionStart = this.deps.isManaged();
		this.managedEnabledBySession = false;
		const presetId = this.data.presetId;
		this.data = freshOnboardingData('mode');
		if (presetId) this.data.presetId = presetId;
		await this.persist();
		this.completed = false;
		await this.ensureManagersReady();
		this.openAtStep('mode');
	}

	/**
	 * Called when the user toggles server.managed from false to true
	 * mid-session. No-ops whenever onboarding state already exists: an
	 * in-progress wizard is already driving the setup (this also covers the
	 * toggle caused by the wizard's own screen-1 write of the flag), and a
	 * done/skipped state is handled by the normal managed flow.
	 */
	async runForManaged(): Promise<void> {
		if (!isSupportedPlatform()) {
			this.showPlatformUnsupported();
			return;
		}
		// Check for existing state BEFORE touching the session flags: the
		// extension's config listener also calls this method in reaction to
		// the wizard's own screen-1 write of server.managed, and clobbering
		// the flags there would break the "revert if we enabled it"
		// bookkeeping (Back → Advanced/Skip).
		const stored = await loadOnboardingState(this.deps.globalState);
		if (stored) return;

		this.managedEnabledAtSessionStart = this.deps.isManaged();
		this.managedEnabledBySession = false;

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
		// The managers are created lazily by the extension; a resumed
		// session (VS Code restarted mid-setup) may not have created them.
		await this.ensureManagersReady();
		const binary = this.deps.getBinaryManager();
		if (!binary) {
			// A silent return here would leave the wizard stuck on
			// "Connecting..." with no error and no Retry button.
			this.updateState({
				downloadError: {
					title: 'Could not start the download',
					detail:
						'The download manager is unavailable. Reload the window ' +
						'("Developer: Reload Window") and try again.',
				},
			});
			this.statusBar.setError();
			return;
		}

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

		const persistedId = this.data.presetId;
		const validPersistedId = persistedId && getPresetById(persistedId) ? persistedId : null;
		const selectedPresetId = validPersistedId ?? rec?.presetId ?? models[0]?.id ?? null;
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
		if (!preset) {
			this.data.presetId = undefined;
			await this.persist();
			await this.prepareModelStep();
			return;
		}
		const modelName = preset.displayName;

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
			// Subscribe before starting so PID-reuse state changes are not missed
			this.watchServer(modelName);
			await this.deps.startServer();
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
		if (!mgr) {
			// Without a visible error the starting screen would sit at
			// "Starting the server..." forever.
			this.updateState({
				serverStarted: false,
				startError: {
					title: 'The server did not start',
					detail:
						'The server manager is unavailable. Reload the window ' +
						'("Developer: Reload Window") and try again.',
				},
			});
			this.statusBar.setError();
			return;
		}

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
					this.updateState({ serverStarted: true, loadingModelName: null, startError: null });
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
			this.updateState({ serverStarted: true, loadingModelName: null, startError: null });
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
			// The server is not (still) running — uncheck it in the webview
			// so the starting screen never shows a done checkmark next to
			// an error.
			serverStarted: false,
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
	 * The server is healthy. In local sessions, show done screen.
	 * In remote SSH sessions, check if SSH setup is needed first.
	 */
	private advancingFromRunning = false;
	private async onServerRunning(): Promise<void> {
		if (this.completed || this.advancingFromRunning) return;
		this.advancingFromRunning = true;

		try {
			// Fallback: write managed flag in case the screen-1 write failed
			if (this.data.mode === 'managed') {
				void this.enableManagedSetting();
			}

			this.statusBar.hide();
			this.deps.runBackgroundUpdateCheck();

		const { isSSHRemoteSession } = await import('../remoteAuthority.js');
		const isSSHRemote = isSSHRemoteSession();

			if (isSSHRemote) {
				await this.prepareSSHSetupStep();
			} else {
				await this.markDone('local');
			}

			// Only dispose the listener after a successful transition
			this.serverStateSub?.dispose();
			this.serverStateSub = undefined;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.updateState({
				startError: {
					title: 'Setup failed after server started',
					detail: msg || 'An unexpected error occurred. Press Retry to try again.',
				},
			});
			this.statusBar.setError();
		} finally {
			this.advancingFromRunning = false;
		}
	}

	private async prepareSSHSetupStep(): Promise<void> {
		try {
			const { decodeRemoteAuthority, getRemoteAuthority } = await import('../remoteAuthority.js');
			const { deriveAllForwards, isPrivateOrLocalAddress } = await import('@llama-copilot/shared');
			const { getSSHConfigPath, loadSSHConfig, parseHostBlocks, hasRemoteForward, generateDiffPreview } = await import('../sshConfig.js');
			const { findMatchingHostBlocks } = await import('../remoteAuthority.js');

			const authority = getRemoteAuthority();
			if (!authority) {
				await this.markDone('local');
				return;
			}
			const decoded = decodeRemoteAuthority(authority);
			if (!decoded) {
				await this.markDone('local');
				return;
			}

			const managedPort = this.deps.isManaged() ? this.deps.getPort() : null;
			const endpoints = this.deps.hasUserEndpoints()
				? vscode.workspace.getConfiguration(CONFIG_SECTION).get<Record<string, { url: string }>>('endpoints', {})
				: {};
			const allForwards = deriveAllForwards(managedPort, endpoints, isPrivateOrLocalAddress);

			if (allForwards.length === 0) {
				await this.markDone('local');
				return;
			}

			const configPath = getSSHConfigPath();
			const resolvedConfig = await loadSSHConfig(configPath);
			const hostBlocks = parseHostBlocks(resolvedConfig);
			const matchingBlocks = findMatchingHostBlocks(decoded, hostBlocks);

			const forwards = allForwards.map(f => {
				const already = matchingBlocks.some(block =>
					hasRemoteForward(block, f.remotePort, f.localHost, f.localPort),
				);
				return {
					label: f.label,
					localHost: f.localHost,
					localPort: f.localPort,
					remotePort: f.remotePort,
					alreadyConfigured: already,
				};
			});

			// If all forwards already configured, skip SSH step
			if (forwards.every(f => f.alreadyConfigured)) {
				await this.markDone('local');
				return;
			}

			// Generate diff preview
			let diffPreview: string | null = null;
			if (matchingBlocks.length > 0) {
				const newForwards = forwards
					.filter(f => !f.alreadyConfigured)
					.map(f => ({ remotePort: f.remotePort, localBind: f.localHost, localPort: f.localPort }));
				diffPreview = generateDiffPreview(matchingBlocks[0], newForwards);
			}

			this.data.step = 'remote';
			await this.persist();

			this.updateState({
				step: 'remote',
				isRemoteSession: true,
				sshHost: decoded.host,
				forwards,
				sshSetupStatus: 'pending',
				sshSetupError: null,
				sshDiffPreview: diffPreview,
			});
		} catch {
			// SSH config processing failed — skip the SSH step entirely
			await this.markDone('local');
		}
	}

	private async handleConfigureSSH(): Promise<void> {
		try {
			const { getSSHConfigPath, loadSSHConfig, parseHostBlocks, addRemoteForward, createBackup } = await import('../sshConfig.js');
			const { decodeRemoteAuthority, getRemoteAuthority, findMatchingHostBlocks } = await import('../remoteAuthority.js');

			const authority = getRemoteAuthority();
			if (!authority) {
				this.updateState({ sshSetupStatus: 'error', sshSetupError: { title: 'Unknown remote type', detail: 'Could not determine the remote authority.' } });
				return;
			}
			const decoded = decodeRemoteAuthority(authority);
			if (!decoded) {
				this.updateState({ sshSetupStatus: 'error', sshSetupError: { title: 'Unknown remote type', detail: 'Could not decode the remote authority.' } });
				return;
			}

			const configPath = getSSHConfigPath();
			await createBackup(configPath);

			const resolvedConfig = await loadSSHConfig(configPath);
			const hostBlocks = parseHostBlocks(resolvedConfig);
			const matchingBlocks = findMatchingHostBlocks(decoded, hostBlocks);

			if (matchingBlocks.length === 0) {
				this.updateState({ sshSetupStatus: 'error', sshSetupError: { title: 'No matching Host block', detail: 'Add a Host block to your SSH config manually.' } });
				return;
			}

			const unconfigured = this.state.forwards.filter(f => !f.alreadyConfigured);
			const { writeFile } = await import('node:fs/promises');

			for (const fw of unconfigured) {
				const result = await addRemoteForward(matchingBlocks[0], fw.remotePort, fw.localHost, fw.localPort);
				await writeFile(result.modifiedFile, result.newContent, 'utf-8');
			}

			this.updateState({ sshSetupStatus: 'applied' });
			await this.markDone('reconnect');
		} catch (err) {
			// Copy to clipboard as fallback
			const lines = this.state.forwards
				.filter(f => !f.alreadyConfigured)
				.map(f => `RemoteForward 127.0.0.1:${f.remotePort} ${f.localHost}:${f.localPort}`);
			await vscode.env.clipboard.writeText(lines.join('\n'));

			const msg = err instanceof Error ? err.message : String(err);
			this.updateState({
				sshSetupStatus: 'error',
				sshSetupError: { title: 'Could not write SSH config', detail: `${msg}\n\nThe lines have been copied to your clipboard.` },
			});
		}
	}

	private async handleSkipSSH(): Promise<void> {
		const lines = this.state.forwards
			.filter(f => !f.alreadyConfigured)
			.map(f => `RemoteForward 127.0.0.1:${f.remotePort} ${f.localHost}:${f.localPort}`);
		await vscode.env.clipboard.writeText(lines.join('\n'));
		this.updateState({ sshSetupStatus: 'skipped' });
		await this.markDone('manual');
	}

	private async markDone(variant: 'local' | 'reconnect' | 'manual'): Promise<void> {
		if (this.completed) return;
		this.completed = true;

		// Update UI first so a Memento failure never strands the wizard
		this.updateState({ step: 'done', doneVariant: variant });

		this.data.status = 'done';
		await this.persist();

		if (variant === 'local') {
			vscode.window
				.showInformationMessage('Your model is ready', 'Open Chat')
				.then(selection => {
					if (selection === 'Open Chat') {
						void vscode.commands.executeCommand('workbench.action.chat.open');
					}
				});
		}
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
					// Persist BEFORE flipping the setting: the extension's config
					// listener reacts to the write below and must see the
					// in-progress state.
					await this.persist();
					// Unlock the rest of the extension (managed commands, server
					// auto-start on the next launch) the moment the user commits
					// to the managed path — not only when the wizard completes.
					if (await this.enableManagedSetting()) {
						this.managedEnabledBySession = true;
					}
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

			case 'configureSSH':
				void this.handleConfigureSSH();
				break;

			case 'skipSSH':
				void this.handleSkipSSH();
				break;

			case 'reconnect':
				void vscode.commands.executeCommand('workbench.action.reloadWindow');
				break;
		}
	}

	private async finishSkip(): Promise<void> {
		// Explicit "not now": never auto-open the wizard again. It stays
		// available via the command palette ("Llama Copilot: Run Setup").
		this.data.status = 'skipped';
		await this.persist();
		await this.revertManagedSettingIfWeEnabledIt();
		this.statusBar.hide();
		this.panel.dispose();
	}

	private async finishAdvanced(): Promise<void> {
		// "I'll bring my own server": open the endpoint settings.
		// server.managed stays off unless the user enabled it themselves.
		await vscode.commands.executeCommand('workbench.action.openSettings', 'llamaCopilot.endpoints');
		this.data.status = 'done';
		this.data.mode = 'advanced';
		await this.persist();
		await this.revertManagedSettingIfWeEnabledIt();
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

	/**
	 * Write `llamaCopilot.server.managed = true` (global). Called the moment
	 * the user commits to the managed path on screen 1, so the rest of the
	 * extension (managed commands, server auto-start on the next launch) is
	 * unlocked even if the binary/model setup is interrupted later.
	 * Returns false when the write failed (non-fatal — the wizard drives the
	 * setup regardless of the flag).
	 */
	private async enableManagedSetting(): Promise<boolean> {
		try {
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update('server.managed', true, vscode.ConfigurationTarget.Global);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Revert `server.managed` to false — only when this session set it (the
	 * user started on the managed card, then went Back and chose Advanced or
	 * Skip). A flag the user enabled before the wizard started is left
	 * untouched.
	 */
	private async revertManagedSettingIfWeEnabledIt(): Promise<void> {
		if (!this.managedEnabledBySession || this.managedEnabledAtSessionStart) return;
		this.managedEnabledBySession = false;
		try {
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update('server.managed', false, vscode.ConfigurationTarget.Global);
		} catch {
			// Non-fatal.
		}
	}

	/**
	 * The binary/models-ini managers are created lazily by the extension;
	 * a resumed wizard session (VS Code restarted mid-setup) may not have
	 * created them yet. Non-fatal: a step that still finds a missing
	 * manager surfaces its own error instead of freezing silently.
	 */
	private async ensureManagersReady(): Promise<void> {
		try {
			await this.deps.ensureManagers();
		} catch {
			// Non-fatal — the step that needs a manager reports the error.
		}
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
