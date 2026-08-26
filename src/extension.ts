import * as vscode from 'vscode';
import { LlamaCopilotChatProvider } from './provider';
import { initializeLogger } from './logger';
import { EndpointsConfig } from './types';
import {
	CONFIG_SECTION,
	CONFIG_ENDPOINTS,
	endpointsConfigKey,
	endpointsSettingsKey,
	getConfig,
	getInlineCompletionModel,
	isServerManaged,
	getServerPort,
	getStopOnDeactivate,
	isAutoUpdateEnabled,
	getServerExtraArgs,
} from './config';
import { InlineCompletionProvider } from './inlineCompletion/provider';
import { isSupportedPlatform } from './server/platform';
import { BinaryManager } from './server/binaryManager';
import { LlamaServerManager } from './server/serverManager';
import { ModelsIniManager, UnsupportedIniVersionError } from './server/modelsIniManager';
import { queryDevices, invalidateDeviceCache } from './server/deviceQuery';
import { checkForUpdate } from './server/autoUpdate';
import { openModelsManager } from './server/modelsIniUI';
import { OnboardingOrchestrator } from './onboarding/onboarding';

let provider: LlamaCopilotChatProvider | undefined;
let providerDisposable: vscode.Disposable | undefined;
let inlineCompletionDisposable: vscode.Disposable | undefined;
let serverManager: LlamaServerManager | undefined;
let binaryManager: BinaryManager | undefined;
let modelsIniManager: ModelsIniManager | undefined;
let onboarding: OnboardingOrchestrator | undefined;

/**
 * Normalize endpoint URL by stripping trailing `/` or `/v1`
 */
function normalizeEndpointUrl(url: string): string {
	let normalized = url.trim();
	if (normalized.endsWith('/v1')) {
		normalized = normalized.slice(0, -3);
	}
	if (normalized.endsWith('/')) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

/**
 * Normalize all endpoint URLs in the configuration
 */
function normalizeEndpoints(endpoints: EndpointsConfig): EndpointsConfig {
	const normalized: EndpointsConfig = {};
	for (const [key, config] of Object.entries(endpoints)) {
		normalized[key] = {
			...config,
			url: normalizeEndpointUrl(config.url),
		};
	}
	return normalized;
}

/**
 * Build the effective endpoints map: user settings + managed endpoint (if running).
 */
function buildEffectiveEndpoints(): EndpointsConfig {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const userEndpoints = config.get<EndpointsConfig>(CONFIG_ENDPOINTS, {});
	const normalized = normalizeEndpoints(userEndpoints);

	if (serverManager && serverManager.getState() === 'running') {
		const port = getServerPort();
		if ('managed' in normalized) {
			// User has a "managed" key -- override with warning (logged once)
		}
		normalized['managed'] = { url: `http://127.0.0.1:${port}` };
	}

	return normalized;
}

// Serialized refresh to avoid races between config changes and state changes
let refreshPending = false;
let refreshRunning = false;

function refreshProviders(context: vscode.ExtensionContext) {
	if (refreshRunning) { refreshPending = true; return; }
	refreshRunning = true;
	do {
		refreshPending = false;
		const endpoints = buildEffectiveEndpoints();
		const newProvider = registerProvider(endpoints, context);
		updateInlineCompletionProvider(endpoints, context);
		if (newProvider) {
			setTimeout(() => newProvider.fireChangeEvent(), 0);
		}
	} while (refreshPending);
	refreshRunning = false;
}

function registerProvider(endpoints: EndpointsConfig, context: vscode.ExtensionContext) {
	if (provider) {
		provider.dispose();
		provider = undefined;
	}
	if (providerDisposable) {
		const index = context.subscriptions.indexOf(providerDisposable);
		if (index !== -1) {
			context.subscriptions.splice(index, 1);
		}
		providerDisposable.dispose();
		providerDisposable = undefined;
	}

	provider = new LlamaCopilotChatProvider(endpoints);
	providerDisposable = vscode.lm.registerLanguageModelChatProvider(
		'llama-server',
		provider
	);

	context.subscriptions.push(providerDisposable);
	return provider;
}

function updateInlineCompletionProvider(endpoints: EndpointsConfig, context: vscode.ExtensionContext) {
	if (inlineCompletionDisposable) {
		const index = context.subscriptions.indexOf(inlineCompletionDisposable);
		if (index !== -1) context.subscriptions.splice(index, 1);
		inlineCompletionDisposable.dispose();
		inlineCompletionDisposable = undefined;
	}
	const modelId = getInlineCompletionModel();
	if (modelId && Object.keys(endpoints).length > 0) {
		const selector = [{ language: '*' }];
		inlineCompletionDisposable = vscode.languages.registerInlineCompletionItemProvider(
			selector,
			new InlineCompletionProvider(endpoints)
		);
		context.subscriptions.push(inlineCompletionDisposable);
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Create output channel for API logging
	const outputChannel = vscode.window.createOutputChannel('LLaMA Server API');
	context.subscriptions.push(outputChannel);

	// Initialize logger with output channel
	initializeLogger(outputChannel);

	// Register command to open endpoint settings
	context.subscriptions.push(
		vscode.commands.registerCommand('llamaCopilot.openEndpointSettings', () => {
			vscode.commands.executeCommand('workbench.action.openSettings', endpointsSettingsKey());
		})
	);

	// Register managed server commands (always registered, guard on managed mode inside)
	registerManagedCommands(context);

	// Initial provider registration
	refreshProviders(context);

	// Listen for configuration changes
	let wasServerManaged = isServerManaged();
	const configDisposable = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
		if (e.affectsConfiguration(endpointsConfigKey()) || e.affectsConfiguration(`${CONFIG_SECTION}.server`)) {
			const nowManaged = isServerManaged();
			if (nowManaged && !wasServerManaged) {
				// User enabled managed mode mid-session → guide them through setup.
				getOnboarding(context).runForManaged().catch(() => { /* non-fatal */ });
			}
			wasServerManaged = nowManaged;
			refreshProviders(context);
		}
		if (e.affectsConfiguration(`${CONFIG_SECTION}.inlineCompletionModel`)) {
			refreshProviders(context);
		}
	});
	context.subscriptions.push(configDisposable);

	// Kick off onboarding + managed server initialization in the background
	// (non-blocking). The onboarding wizard drives setup for new or partially
	// set-up users; once onboarding is done (or silently skipped for legacy
	// setups with a working configuration) the normal managed init runs.
	void kickOffManagedInit(context);
}

/**
 * Decide between the onboarding wizard and the normal managed init:
 * - wizard → the wizard drives everything, including the server start on
 *   completion; skip initManagedServer() to avoid racing the wizard.
 * - normal → onboarding is complete or not applicable; run managed init as
 *   before (only when managed mode is on).
 */
async function kickOffManagedInit(context: vscode.ExtensionContext): Promise<void> {
	const outcome = await getOnboarding(context).maybeAutoRun().catch(err => {
		// Onboarding must never break activation — fall back to normal init.
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showWarningMessage(`Llama Copilot setup could not start: ${msg}`);
		return 'normal' as const;
	});
	if (outcome === 'wizard') return;

	if (isServerManaged()) {
		initManagedServer(context).catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Managed llama-server initialization failed: ${msg}`);
		});
	}
}

/** Create the onboarding orchestrator (singleton) with closures over the module-level managers. */
function getOnboarding(context: vscode.ExtensionContext): OnboardingOrchestrator {
	if (!onboarding) {
		onboarding = new OnboardingOrchestrator({
			globalState: context.globalState,
			globalStoragePath: context.globalStorageUri.fsPath,
			extensionUri: context.extensionUri,
			ensureManagers: () => ensureManagers(context),
			getBinaryManager: () => binaryManager,
			getModelsIniManager: () => modelsIniManager,
			getServerManager: () => serverManager,
			startServer: () => startServer(context),
			runBackgroundUpdateCheck,
			isManaged: isServerManaged,
			hasUserEndpoints: () => {
				const endpoints = getConfig().get<EndpointsConfig>(CONFIG_ENDPOINTS, {});
				return Object.keys(endpoints).length > 0;
			},
			getPort: getServerPort,
		});
	}
	return onboarding;
}

/** Create the binary/models-ini managers if they don't exist yet. */
async function ensureManagers(context: vscode.ExtensionContext): Promise<void> {
	if (!binaryManager) {
		binaryManager = new BinaryManager({ globalStorageUri: context.globalStorageUri });
	}
	if (!modelsIniManager) {
		modelsIniManager = new ModelsIniManager(context.globalStorageUri.fsPath);
	}
}

function registerManagedCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('llamaCopilot.startServer', async () => {
			if (!isServerManaged()) {
				vscode.window.showInformationMessage(
					'Enable managed server mode first: set "llamaCopilot.server.managed" to true in settings.'
				);
				return;
			}
			if (!isSupportedPlatform()) {
				vscode.window.showErrorMessage(
					`Managed llama-server is not available for your platform (${process.platform}/${process.arch}). ` +
					`You can still use the extension by running llama-server yourself and configuring an endpoint in Settings → Llama Copilot → Endpoints.`
				);
				return;
			}
			await initManagedServer(context);
		}),

		vscode.commands.registerCommand('llamaCopilot.stopServer', async () => {
			if (serverManager) {
				await serverManager.stop();
				refreshProviders(context);
			}
		}),

		vscode.commands.registerCommand('llamaCopilot.restartServer', async () => {
			if (serverManager) {
				await serverManager.restartWithConfirmation();
				refreshProviders(context);
			}
		}),

		vscode.commands.registerCommand('llamaCopilot.updateBinary', async () => {
			if (!binaryManager || !serverManager) {
				vscode.window.showInformationMessage('Managed server mode is not active.');
				return;
			}
			await checkForUpdate(
				{
					binaryManager,
					serverManager,
					getAutoUpdateEnabled: isAutoUpdateEnabled,
				},
				true
			);
		}),

		vscode.commands.registerCommand('llamaCopilot.manageModels', async () => {
			if (!modelsIniManager) {
				vscode.window.showInformationMessage('Managed server mode is not active.');
				return;
			}
			await openModelsManager({
				extensionUri: context.extensionUri,
				modelsIniManager,
				onModelsChanged: async () => {
					if (serverManager && serverManager.getState() === 'running') {
						await serverManager.restartWithConfirmation();
						refreshProviders(context);
					}
				},
			});
		}),

		vscode.commands.registerCommand('llamaCopilot.editModelsIni', async () => {
			if (!modelsIniManager) {
				vscode.window.showInformationMessage('Managed server mode is not active.');
				return;
			}
			await modelsIniManager.ensureExists();
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelsIniManager.getIniPath()));
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('llamaCopilot.onboarding', () => {
			void getOnboarding(context).run();
		}),
	);
}

async function initManagedServer(context: vscode.ExtensionContext): Promise<void> {
	// Check platform support
	if (!isSupportedPlatform()) {
		vscode.window.showErrorMessage(
			`Managed llama-server is not available for your platform (${process.platform}/${process.arch}). ` +
			`You can still use the extension by running llama-server yourself and configuring an endpoint in Settings → Llama Copilot → Endpoints.`
		);
		return;
	}

	// Check if running workspace-side in a remote session
	const remoteName = vscode.env.remoteName;
	const ext = vscode.extensions.getExtension('delft-solutions.llama-copilot');
	if (remoteName && ext?.extensionKind === vscode.ExtensionKind.Workspace) {
		vscode.window.showInformationMessage(
			'Managed server is not available in remote workspace mode. The extension prefers running locally where your GPU is. If you need it on the remote, configure an endpoint manually.'
		);
		return;
	}

	// Initialize managers
	await ensureManagers(context);
	if (!binaryManager || !modelsIniManager) return; // unreachable — ensureManagers creates them

	// Step 1: Ensure binary is installed
	const isInstalled = await binaryManager.isInstalled();
	if (!isInstalled) {
		const latest = await binaryManager.latestVersion();
		if (!latest) {
			const retry = await vscode.window.showErrorMessage(
				'Could not fetch the latest llama-server release from GitHub. Check your network connection.',
				'Retry'
			);
			if (retry === 'Retry') {
				return initManagedServer(context);
			}
			return;
		}

		const downloaded = await binaryManager.downloadWithProgress(latest);
		if (!downloaded) return; // Cancelled
	}

	// Step 2: Run device query in background (non-blocking)
	const cliPath = await binaryManager.getCurrentCliPath();
	if (cliPath) {
		queryDevices(cliPath).catch(() => { /* non-fatal */ });
	}

	// Step 3: Apply preset autoupdates
	try {
		await modelsIniManager.applyAutoupdates();
	} catch (err) {
		if (err instanceof UnsupportedIniVersionError) {
			vscode.window.showWarningMessage(err.message);
		} else {
			throw err;
		}
	}

	// Step 4: Check if models.ini exists
	const hasIni = await modelsIniManager.exists();
	if (!hasIni) {
		const choice = await vscode.window.showInformationMessage(
			'No models configured for managed llama-server. Open the Models Manager to select models.',
			'Open Models Manager'
		);
		if (choice === 'Open Models Manager') {
			await openModelsManager({
				extensionUri: context.extensionUri,
				modelsIniManager,
				onModelsChanged: async () => {
					// After models are configured, try starting the server
					if (await modelsIniManager!.exists()) {
						await startServer(context);
					}
				},
			});
		}
		return;
	}

	// Steps 5–6: start the server + background auto-update check
	await startServerAndAutoUpdate(context);
}

/**
 * Start the managed server (creating the manager if needed) and kick off the
 * background binary auto-update check. Shared by the normal managed init and
 * the onboarding wizard completion path.
 */
async function startServerAndAutoUpdate(context: vscode.ExtensionContext): Promise<void> {
	if (!binaryManager || !modelsIniManager) return;
	await startServer(context);
	runBackgroundUpdateCheck();
}

/** Background binary auto-update check (no-op if not applicable). */
function runBackgroundUpdateCheck(): void {
	if (serverManager && binaryManager && isAutoUpdateEnabled()) {
		checkForUpdate(
			{
				binaryManager,
				serverManager,
				getAutoUpdateEnabled: isAutoUpdateEnabled,
			},
			false
		).catch(() => { /* non-fatal */ });
	}
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
	if (!binaryManager || !modelsIniManager) return;

	if (!serverManager) {
		serverManager = new LlamaServerManager({
			globalStoragePath: context.globalStorageUri.fsPath,
			getServerBinaryPath: () => binaryManager!.getCurrentServerPath(),
			getModelsIniPath: () => modelsIniManager!.getIniPath(),
			getPort: getServerPort,
			getExtraArgs: getServerExtraArgs,
			getCurrentVersion: () => binaryManager!.currentVersion(),
		});

		// Listen for state changes to refresh providers
		serverManager.onStateChanged(() => {
			refreshProviders(context);
		});

		context.subscriptions.push(serverManager);
	}

	const hasIni = await modelsIniManager.exists();
	if (!hasIni) return;

	await serverManager.start(true);
}

export async function deactivate() {
	onboarding?.dispose();
	onboarding = undefined;

	if (serverManager && getStopOnDeactivate()) {
		await serverManager.shutdown();
	}

	if (provider) {
		provider.dispose();
		provider = undefined;
	}
	if (providerDisposable) {
		providerDisposable.dispose();
		providerDisposable = undefined;
	}
	if (inlineCompletionDisposable) {
		inlineCompletionDisposable.dispose();
		inlineCompletionDisposable = undefined;
	}
}
