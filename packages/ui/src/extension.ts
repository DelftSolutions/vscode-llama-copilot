import * as vscode from 'vscode';
import { initializeLogger, logError } from '@llama-copilot/shared';
import type { EndpointsConfig } from '@llama-copilot/shared';
import { CONFIG_SECTION, CONFIG_ENDPOINTS } from '@llama-copilot/shared';
import {
	isServerManaged,
	getServerPort,
	getStopOnDeactivate,
	isAutoUpdateEnabled,
	getServerExtraArgs,
	getEndpoints,
	getConfig,
	checkSettingsScopeMismatch,
} from './config.js';
import { isSupportedPlatform } from './server/platform.js';
import { BinaryManager } from './server/binaryManager.js';
import { LlamaServerManager } from './server/serverManager.js';
import { ModelsIniManager, UnsupportedIniVersionError } from './server/modelsIniManager.js';
import { queryDevices } from './server/deviceQuery.js';
import { checkForUpdate } from './server/autoUpdate.js';
import { openModelsManager } from './server/modelsIniUI.js';
import { OnboardingOrchestrator } from './onboarding/onboarding.js';
import { checkSSHForwardsForCurrentSession, runSSHSetupWizard } from './sshSetup.js';
import { getSSHConfigPath, getLatestBackup, restoreBackup } from './sshConfig.js';

export interface LlamaCopilotUIAPI {
	getServerState(): string;
	getServerPort(): number;
	onServerStateChanged: import('vscode').Event<string>;
}

let serverManager: LlamaServerManager | undefined;
let binaryManager: BinaryManager | undefined;
let modelsIniManager: ModelsIniManager | undefined;
let onboarding: OnboardingOrchestrator | undefined;

const serverStateEmitter = new vscode.EventEmitter<string>();

export function activate(context: vscode.ExtensionContext): LlamaCopilotUIAPI {
	const outputChannel = vscode.window.createOutputChannel('Llama Server (UI)');
	context.subscriptions.push(outputChannel);
	initializeLogger(outputChannel);

	registerManagedCommands(context);
	registerSSHCommands(context);

	void kickOffManagedInit(context);

	// Proactively check SSH config in remote sessions
	if (vscode.env.remoteName) {
		checkSettingsScopeMismatch();
		void checkSSHForwardsForCurrentSession(
			context.globalState,
			isServerManaged(),
			isServerManaged() ? getServerPort() : null,
			getEndpoints(),
		).catch(err => {
			logError(err instanceof Error ? err : String(err), 'SSH config check');
		});
	}

	const api: LlamaCopilotUIAPI = {
		getServerState: () => serverManager?.getState() ?? 'stopped',
		getServerPort: () => getServerPort(),
		onServerStateChanged: serverStateEmitter.event,
	};
	return api;
}

export async function deactivate(): Promise<void> {
	onboarding?.dispose();
	onboarding = undefined;

	if (serverManager && getStopOnDeactivate()) {
		logError('Shutting down managed llama-server (stopOnDeactivate=true)', 'deactivate');
		await serverManager.shutdown();
	}
}

async function kickOffManagedInit(context: vscode.ExtensionContext): Promise<void> {
	const outcome = await getOnboarding(context).maybeAutoRun().catch(err => {
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

async function ensureManagers(context: vscode.ExtensionContext): Promise<void> {
	if (!binaryManager) {
		binaryManager = new BinaryManager({ globalStorageUri: context.globalStorageUri });
	}
	if (!modelsIniManager) {
		modelsIniManager = new ModelsIniManager(context.globalStorageUri.fsPath);
	}
}

function registerManagedCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('llamaCopilot.startServer', async () => {
			if (!isServerManaged()) {
				vscode.window.showInformationMessage(
					'Enable managed server mode first: set "llamaCopilot.server.managed" to true in settings.',
				);
				return;
			}
			if (!isSupportedPlatform()) {
				vscode.window.showErrorMessage(
					`Managed llama-server is not available for your platform (${process.platform}/${process.arch}). `
					+ 'You can still use the extension by running llama-server yourself and configuring an endpoint.',
				);
				return;
			}
			await initManagedServer(context);
		}),

		vscode.commands.registerCommand('llamaCopilot.stopServer', async () => {
			if (serverManager) {
				await serverManager.stop();
				serverStateEmitter.fire('stopped');
			}
		}),

		vscode.commands.registerCommand('llamaCopilot.restartServer', async () => {
			if (serverManager) {
				await serverManager.restartWithConfirmation();
				serverStateEmitter.fire(serverManager.getState());
			}
		}),

		vscode.commands.registerCommand('llamaCopilot.updateBinary', async () => {
			if (!binaryManager || !serverManager) {
				vscode.window.showInformationMessage('Managed server mode is not active.');
				return;
			}
			await checkForUpdate({ binaryManager, serverManager, getAutoUpdateEnabled: isAutoUpdateEnabled }, true);
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
						serverStateEmitter.fire(serverManager.getState());
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

function registerSSHCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('llamaCopilot.configureSSHForward', async () => {
			await runSSHSetupWizard(
				isServerManaged(),
				isServerManaged() ? getServerPort() : null,
				getEndpoints(),
			);
		}),

		vscode.commands.registerCommand('llamaCopilot.revertSSHConfig', async () => {
			const configPath = getSSHConfigPath();
			const backup = await getLatestBackup(configPath);
			if (!backup) {
				vscode.window.showInformationMessage('No SSH config backup found.');
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Revert SSH config from backup: ${backup}?`,
				{ modal: true },
				'Revert',
			);

			if (confirm === 'Revert') {
				await restoreBackup(configPath, backup);
				vscode.window.showInformationMessage('SSH config reverted from backup.');
			}
		}),
	);
}

async function initManagedServer(context: vscode.ExtensionContext): Promise<void> {
	if (!isSupportedPlatform()) {
		vscode.window.showErrorMessage(
			`Managed llama-server is not available for your platform (${process.platform}/${process.arch}). `
			+ 'You can still use the extension by running llama-server yourself and configuring an endpoint.',
		);
		return;
	}

	// No remote guard needed — UI extension always runs locally (extensionKind: ["ui"])

	await ensureManagers(context);
	if (!binaryManager || !modelsIniManager) return;

	const isInstalled = await binaryManager.isInstalled();
	if (!isInstalled) {
		const latest = await binaryManager.latestVersion();
		if (!latest) {
			const retry = await vscode.window.showErrorMessage(
				'Could not fetch the latest llama-server release from GitHub. Check your network connection.',
				'Retry',
			);
			if (retry === 'Retry') return initManagedServer(context);
			return;
		}
		const downloaded = await binaryManager.downloadWithProgress(latest);
		if (!downloaded) return;
	}

	const cliPath = await binaryManager.getCurrentCliPath();
	if (cliPath) {
		queryDevices(cliPath).catch(() => { /* non-fatal */ });
	}

	try {
		await modelsIniManager.applyAutoupdates();
	} catch (err) {
		if (err instanceof UnsupportedIniVersionError) {
			vscode.window.showWarningMessage(err.message);
		} else {
			throw err;
		}
	}

	const hasIni = await modelsIniManager.exists();
	if (!hasIni) {
		const choice = await vscode.window.showInformationMessage(
			'No models configured for managed llama-server. Open the Models Manager to select models.',
			'Open Models Manager',
		);
		if (choice === 'Open Models Manager') {
			await openModelsManager({
				extensionUri: context.extensionUri,
				modelsIniManager,
				onModelsChanged: async () => {
					if (await modelsIniManager!.exists()) {
						await startServer(context);
					}
				},
			});
		}
		return;
	}

	await startServer(context);
	runBackgroundUpdateCheck();
}

function runBackgroundUpdateCheck(): void {
	if (serverManager && binaryManager && isAutoUpdateEnabled()) {
		checkForUpdate(
			{ binaryManager, serverManager, getAutoUpdateEnabled: isAutoUpdateEnabled },
			false,
		).catch(() => { /* non-fatal */ });
	}
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
	await ensureManagers(context);
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

		serverManager.onStateChanged(() => {
			serverStateEmitter.fire(serverManager!.getState());
		});

		context.subscriptions.push(serverManager);
	}

	const hasIni = await modelsIniManager.exists();
	if (!hasIni) return;

	await serverManager.start(true);
}
