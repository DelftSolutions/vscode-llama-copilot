import * as vscode from 'vscode';
import { SshClient, SshConfig } from './sshClient';

export interface ServerResources {
	ramUsage: string;
	serverStatus: 'running' | 'stopped' | 'unknown' | 'connecting';
}

export class LlamaServerManager {
	private readonly logger: vscode.LogOutputChannel;
	private readonly sshClient: SshClient;
	private config: SshConfig | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private pollIntervalMs = 1000;
	private onResourcesChange: ((resources: ServerResources) => void) | null = null;
	private onStatusChange: ((status: boolean) => void) | null = null;

	constructor(logger: vscode.LogOutputChannel) {
		this.logger = logger;
		this.sshClient = new SshClient(logger);
	}

	/**
	 * Register listeners for resource and status changes
	 */
	onResourcesChanged(cb: (resources: ServerResources) => void): void {
		this.onResourcesChange = cb;
	}

	onStatusChanged(cb: (connected: boolean) => void): void {
		this.onStatusChange = cb;
	}

	/**
	 * Update SSH configuration
	 */
	updateConfig(host: string, username: string, privateKeyPath: string, port: number): void {
		const cfg: SshConfig = { host, username, port, ...(privateKeyPath ? { privateKeyPath } : {}) };

		// Check if config has actually changed
		const sameConfig = this.config &&
			this.config.host === cfg.host &&
			this.config.username === cfg.username &&
			this.config.privateKeyPath === cfg.privateKeyPath &&
			this.config.port === cfg.port;

		this.config = cfg;

		// Always restart polling when config changes (or even if same, to ensure it's running)
		this.stopPolling();
		this.startPolling();
	}

	/**
	 * Start polling for server status and resources
	 */
	private startPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
		}

		if (!this.config?.host || !this.config.username) {
			this.logger.info('[LlamaServer] SSH config incomplete, not polling');
			this.notifyStatus(false);
			return;
		}

		this.logger.info(`[LlamaServer] Starting polling for ${this.config.username}@${this.config.host}`);
		this.poll();
		this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
	}

	/**
	 * Stop polling
	 */
	stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
			this.logger.info('[LlamaServer] Stopped polling');
		}
	}

	/**
	 * Single poll cycle
	 */
	private async poll(): Promise<void> {
		if (!this.config) {
			this.notifyStatus(false);
			return;
		}

		try {
			if (!this.sshClient.connected) {
				await this.sshClient.connect(this.config);
				this.notifyStatus(true);
			}

			const resources = await this.fetchResources();
			this.notifyResources(resources);
		} catch (err) {
			this.logger.debug(`[LlamaServer] Poll error: ${err}`);
			// Connection failed - disconnect and notify status as disconnected
			await this.sshClient.disconnect().catch(() => {});
			this.notifyStatus(false);
			this.notifyResources(this.getDisconnectedResources());
		}
	}

	/**
	 * Fetch server resources and status via SSH
	 */
	private async fetchResources(): Promise<ServerResources> {
		if (!this.config) {
			return this.getDisconnectedResources();
		}

		try {
			const [ramResult, serverCheck] = await Promise.all([
				this.getRamUsage(),
				this.checkServerStatus(),
			]);

			return {
				ramUsage: ramResult,
				serverStatus: serverCheck,
			};
		} catch {
			return this.getDisconnectedResources();
		}
	}

	/**
	 * Get RAM usage via SSH
	 */
	private async getRamUsage(): Promise<string> {
		if (!this.config) {
			return '-';
		}
		try {
			const { stdout: memSize } = await this.sshClient.exec(
				"sysctl -n hw.memsize"
			);
			// Parse all relevant vm_stat categories to compute used memory
			// Used = active + wired + speculative (pages actually in use)
			const { stdout: vmStat } = await this.sshClient.exec(
				"vm_stat"
			);
			if (memSize && vmStat) {
				const pageSizeMatch = vmStat.match(/page size of\s+(\d+)\s+bytes/i);
				const pageSizeBytes = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
				const extractPages = (keyword: string): number => {
					const match = vmStat.match(new RegExp(`${keyword}:\\s+([0-9.]+)`));
					return match ? parseFloat(match[1]) : 0;
				};
				const activePages = extractPages('Pages active');
				const wiredPages = extractPages('Pages wired down');
				const speculativePages = extractPages('Pages speculative');
				const compressorPages = extractPages('Pages occupied by compressor');
				const totalBytes = parseInt(memSize, 10);
				const usedBytes =
					(activePages + wiredPages + speculativePages + compressorPages) * pageSizeBytes;
				const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
				const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(0);
				const totalGb = (totalBytes / (1024 * 1024 * 1024)).toFixed(0);
				return `${usedGb} GB / ${totalGb} GB (${usedPct}%)`;
			}
			return '-';
		} catch {
			return '-';
		}
	}

	/**
	 * Check if llama-server is running
	 */
	private async checkServerStatus(): Promise<'running' | 'stopped' | 'unknown' | 'connecting'> {
		if (!this.config) {
			return 'unknown';
		}
		try {
			const { stdout } = await this.sshClient.exec('pgrep -f llama-server');
			if (stdout.trim()) {
				return 'running';
			}
			return 'stopped';
		} catch {
			return 'unknown';
		}
	}

	/**
	 * Get resources when disconnected
	 */
	private getDisconnectedResources(): ServerResources {
		return {
			ramUsage: '-',
			serverStatus: this.config ? 'connecting' : 'unknown',
		};
	}

	/**
	 * Notify resources change
	 */
	private notifyResources(resources: ServerResources): void {
		if (this.onResourcesChange) {
			this.onResourcesChange(resources);
		}
	}

	/**
	 * Notify status change
	 */
	private notifyStatus(connected: boolean): void {
		if (this.onStatusChange) {
			this.onStatusChange(connected);
		}
	}

	/**
	 * Ensure SSH connection is established
	 */
	private async ensureConnected(): Promise<void> {
		if (!this.config || this.sshClient.connected) {
			return;
		}
		this.logger.info('[LlamaServer] Establishing SSH connection for command execution...');
		await this.sshClient.connect(this.config);
		this.notifyStatus(true);
	}

	/**
	 * Start llama server
	 */
	async startServer(startCommand: string): Promise<void> {
		this.logger.info('[LlamaServer] Starting server...');
		try {
			await this.ensureConnected();
			await this.sshClient.exec(startCommand);
			this.logger.info(`[LlamaServer] Server started`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(`[LlamaServer] Failed to start server: ${msg}`);
			throw err;
		}
	}

	/**
	 * Stop llama server
	 */
	async stopServer(stopCommand: string): Promise<void> {
		this.logger.info('[LlamaServer] Stopping server...');
		try {
			await this.ensureConnected();
			await this.sshClient.exec(stopCommand);
			this.logger.info(`[LlamaServer] Server stopped`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(`[LlamaServer] Failed to stop server: ${msg}`);
			throw err;
		}
	}

	/**
	 * Shutdown the remote server
	 */
	async shutdownServer(shutdownCommand: string): Promise<void> {
		this.logger.info('[LlamaServer] Initiating shutdown...');
		try {
			await this.ensureConnected();
			await this.sshClient.exec(shutdownCommand);
			this.logger.info(`[LlamaServer] Shutdown command sent`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(`[LlamaServer] Failed to shutdown: ${msg}`);
			throw err;
		}
	}

	/**
	 * Dispose everything
	 */
	dispose(): void {
		this.stopPolling();
		this.sshClient.destroy();
	}
}
