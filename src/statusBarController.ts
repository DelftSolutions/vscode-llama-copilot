import * as vscode from 'vscode';
import { LlamaServerManager, ServerResources } from './llamaServerManager';

export class StatusBarController {
	private statusBarItem: vscode.StatusBarItem;
	private readonly manager: LlamaServerManager;
	private readonly logger: vscode.LogOutputChannel;

	private onModelChange: () => void;

	private resources: ServerResources = {
		ramUsage: '-',
		serverStatus: 'unknown',
	};

	private connected = false;

	constructor(
		workspaceContainer: vscode.ExtensionContext,
		manager: LlamaServerManager,
		logger: vscode.LogOutputChannel,
		onModelChange: () => void
	) {
		this.onModelChange = onModelChange;
		this.manager = manager;
		this.logger = logger;

		// Create status bar item
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			-20000
		);

		this.statusBarItem.command = 'llamaCopilot.llamaServer.refreshStatus';
		this.statusBarItem.tooltip = 'Llama Server Status\nClick to refresh';

		// Register commands
		this.registerCommands(workspaceContainer);

		// Listen for resource changes
		this.manager.onResourcesChanged((resources) => {
			this.resources = resources;
			this.updateDisplay();
		});

		// Listen for connection status changes
		this.manager.onStatusChanged((connected) => {
			this.connected = connected;
			this.updateDisplay();
		});

		this.statusBarItem.show();
		this.updateDisplay();
	}

	/**
	 * Register status bar commands
	 */
	private registerCommands(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.commands.registerCommand('llamaCopilot.llamaServer.start', async () => {
				await this.handleStartServer();
			}),
			vscode.commands.registerCommand('llamaCopilot.llamaServer.stop', async () => {
				await this.handleStopServer();
			}),
			vscode.commands.registerCommand('llamaCopilot.llamaServer.shutdown', async () => {
				await this.handleShutdownServer();
			}),
			vscode.commands.registerCommand('llamaCopilot.llamaServer.refreshStatus', async () => {
				await this.handleRefresh();
			})
		);
	}

	/**
	 * Handle start server command
	 */
	private async handleStartServer(): Promise<void> {
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		const startCommand = config.get<string>('llamaServer.startCommand', '');

		if (!startCommand) {
			vscode.window.showErrorMessage('Llama Copilot: Start command is not configured');
			return;
		}

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Starting Llama Server...',
					cancellable: false,
				},
				async () => {
					await this.manager.startServer(startCommand);
				}
			);
			// Wait for the server to be ready before refreshing model list
			// The start command returns immediately, but the process needs time to initialize
			const config = vscode.workspace.getConfiguration('llamaCopilot');
			const startDelayMs = config.get<number>('llamaServer.startModelRefreshDelayMs', 1000);

			setTimeout(() => this.onModelChange!(), startDelayMs);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Llama Server Start Failed: ${msg}`);
			this.logger.error(`[StatusBar] Start failed: ${msg}`);
		}
	}

	/**
	 * Handle stop server command
	 */
	private async handleStopServer(): Promise<void> {
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		const stopCommand = config.get<string>('llamaServer.stopCommand', '');

		if (!stopCommand) {
			vscode.window.showErrorMessage('Llama Copilot: Stop command is not configured');
			return;
		}

		try {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Stopping Llama Server...',
					cancellable: false,
				},
				async () => {
					await this.manager.stopServer(stopCommand);
				}
			);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Llama Server Stop Failed: ${msg}`);
			this.logger.error(`[StatusBar] Stop failed: ${msg}`);
		}
	}

	/**
	 * Handle shutdown server command
	 */
	private async handleShutdownServer(): Promise<void> {
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		const shutdownCommand = config.get<string>('llamaServer.shutdownCommand', '');

		if (!shutdownCommand) {
			vscode.window.showErrorMessage('Llama Copilot: Shutdown command is not configured');
			return;
		}

		const confirmed = await vscode.window.showWarningMessage(
			'Are you sure you want to shutdown the remote server?',
			{ modal: true },
			'Shutdown'
		);

		if (confirmed !== 'Shutdown') {
			return;
		}

		try {
			await this.manager.shutdownServer(shutdownCommand);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Llama Server Shutdown Failed: ${msg}`);
			this.logger.error(`[StatusBar] Shutdown failed: ${msg}`);
		}
	}

	/**
	 * Handle refresh command
	 */
	private async handleRefresh(): Promise<void> {
		this.logger.info('[StatusBar] Manual refresh triggered');
		// Refresh model list on manual refresh
		setTimeout(() => this.onModelChange!(), 0);
	}

	/**
	 * Update SSH config from VS Code settings
	 */
	updateSshConfig(): void {
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		const host = config.get<string>('ssh.host', '');
		const username = config.get<string>('ssh.username', '');
		const privateKeyPath = config.get<string>('ssh.privateKeyPath', '');
		const port = config.get<number>('ssh.port', 22);

		if (host && username) {
			this.manager.updateConfig(host, username, privateKeyPath, port);
		} else {
			this.manager.updateConfig('', '', '', 22);
		}
	}

	/**
	 * Update the status bar display
	 */
	private updateDisplay(): void {
		const statusIcon = this.getStatusIcon();
		const statusText = this.getStatusText();

		this.statusBarItem.text = `${statusIcon ? `${statusIcon} ` : ''}${statusText}`;

		// Show/hide based on SSH config
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		const host = config.get<string>('ssh.host', '');
		const username = config.get<string>('ssh.username', '');

		if (host && username) {
			this.statusBarItem.show();
		} else {
			this.statusBarItem.hide();
		}
	}

	/**
	 * Get status icon based on connection state
	 */
	private getStatusIcon(): string | undefined {
		if (!this.connected) {
			return '$(circle-slash)';
		}
		switch (this.resources.serverStatus) {
			case 'running':
				return undefined;
			case 'stopped':
				return '$(circle-slash)';
			case 'connecting':
				return '$(sync|animated=true)';
			default:
				return '$(question)';
		}
	}

	/**
	 * Get status text
	 */
	private getStatusText(): string {
		if (!this.connected) {
			return 'Llama: Connecting...';
		}

		const statusLabel = this.getResourceStatusLabel();

		return `Llama ${statusLabel}`;
	}

	/**
	 * Get resource status label
	 */
	private getResourceStatusLabel(): string {
		const { ramUsage } = this.resources;

		if (ramUsage === '-') {
			return '—';
		}

		return ramUsage;
	}

	/**
	 * Dispose the status bar controller
	 */
	dispose(): void {
		this.statusBarItem.dispose();
	}
}
