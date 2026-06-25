import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SshConfig {
	host: string;
	port: number;
	username: string;
	privateKeyPath?: string;
}

export class SshClient {
	private conn: Client | null = null;
	private isConnected = false;
	private readonly logger: vscode.LogOutputChannel;

	constructor(logger: vscode.LogOutputChannel) {
		this.logger = logger;
	}

	/**
	 * Build SSH config from SshConfig object
	 */
	private buildConnectConfig(cfg: SshConfig): ConnectConfig {
		const config: ConnectConfig = {
			host: cfg.host,
			port: cfg.port,
			username: cfg.username,
			...(cfg.privateKeyPath ? { privateKey: this.readPrivateKey(cfg.privateKeyPath) } : {}),
		};
		return config;
	}

	/**
	 * Read private key from file
	 */
	private readPrivateKey(keyPath: string): Buffer {
		try {
			const resolved = path.isAbsolute(keyPath)
				? keyPath
				: path.join(os.homedir(), keyPath);
			return fs.readFileSync(resolved);
		} catch (err) {
			this.logger.error(`[SSH] Failed to read private key at ${keyPath}: ${err}`);
			throw err;
		}
	}

	/**
	 * Connect to SSH server
	 */
	async connect(cfg: SshConfig): Promise<void> {
		if (this.isConnected && this.conn) {
			await this.disconnect();
		}

		return new Promise((resolve, reject) => {
			this.conn = new Client();

			this.conn.on('ready', () => {
				this.isConnected = true;
				this.logger.info(`[SSH] Connected to ${cfg.username}@${cfg.host}:${cfg.port}`);
				resolve();
			});

			this.conn.on('error', (err) => {
				this.isConnected = false;
				this.logger.error(`[SSH] Connection error: ${err.message}`);
				reject(err);
			});

			this.conn.on('close', () => {
				this.isConnected = false;
				this.logger.info(`[SSH] Connection closed`);
				this.conn = null;
			});

			try {
				const connectConfig = this.buildConnectConfig(cfg);
				this.conn.connect(connectConfig);
			} catch (err) {
				this.isConnected = false;
				reject(err);
			}
		});
	}

	/**
	 * Disconnect from SSH server
	 */
	async disconnect(): Promise<void> {
		if (this.conn) {
			return new Promise((resolve) => {
				const onClose = () => {
					this.isConnected = false;
					this.conn = null;
					this.logger.info('[SSH] Disconnected');
					resolve();
				};
				this.conn!.once('close', onClose);
				this.conn!.end();
			});
		}
		this.isConnected = false;
		this.conn = null;
	}

	/**
	 * Execute a command on the remote server
	 */
	async exec(command: string): Promise<{ stdout: string; stderr: string }> {
		if (!this.isConnected || !this.conn) {
			throw new Error('SSH client is not connected');
		}

		return new Promise((resolve, reject) => {
			this.conn!.exec(command, (err, stream) => {
				if (err) {
					reject(err);
					return;
				}

				let stdout = '';
				let stderr = '';

				stream.on('data', (data: Buffer) => {
					stdout += data.toString();
				});

				stream.stderr.on('data', (data: Buffer) => {
					stderr += data.toString();
				});

				stream.on('close', (_code: number) => {
					resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
				});

				stream.on('error', (err: Error) => {
					reject(err);
				});
			});
		});
	}

	/**
	 * Check if server is reachable (ping via SSH)
	 */
	async ping(): Promise<boolean> {
		if (!this.isConnected) {
			return false;
		}
		try {
			await this.exec('echo "pong"');
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get current connection status
	 */
	get connected(): boolean {
		return this.isConnected;
	}

	/**
	 * Destroy the client completely
	 */
	destroy(): void {
		if (this.conn) {
			this.conn.end();
			this.conn = null;
		}
		this.isConnected = false;
	}
}
