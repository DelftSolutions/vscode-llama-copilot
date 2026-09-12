/**
 * LlamaServerManager: spawns and manages the llama-server process lifecycle.
 * Handles PID file, health polling, in-flight request tracking,
 * stdout/stderr to OutputChannel, and state change events.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';

export type ManagedServerState =
	| 'not_installed'
	| 'downloading'
	| 'stopped'
	| 'starting'
	| 'running'
	| 'loading_model'
	| 'crashed'
	| 'updating';

interface PidFileData {
	pid: number;
	port: number;
	version: string;
}

export interface ServerManagerOptions {
	globalStoragePath: string;
	getServerBinaryPath: () => Promise<string | null>;
	getModelsIniPath: () => string;
	getPort: () => number;
	getExtraArgs: () => string[];
	getCurrentVersion: () => Promise<string | null>;
}

export class LlamaServerManager implements vscode.Disposable {
	private proc: ChildProcess | undefined;
	private readonly output: vscode.OutputChannel;
	private readonly pidFilePath: string;
	private _state: ManagedServerState = 'stopped';
	private _exitCode: number | undefined;
	private _stateEmitter = new vscode.EventEmitter<ManagedServerState>();
	private readonly inFlightRequests = new Set<Promise<unknown>>();
	private idleResolvers: Array<() => void> = [];
	private healthPollTimer: ReturnType<typeof setInterval> | undefined;

	readonly onStateChanged = this._stateEmitter.event;

	constructor(private readonly options: ServerManagerOptions) {
		this.output = vscode.window.createOutputChannel('llama-server');
		this.pidFilePath = path.join(options.globalStoragePath, 'llama-server.pid');
	}

	getState(): ManagedServerState {
		return this._state;
	}

	getExitCode(): number | undefined {
		return this._exitCode;
	}

	private setState(state: ManagedServerState): void {
		if (this._state === state) return;
		this._state = state;
		this._stateEmitter.fire(state);
	}

	/**
	 * Track an in-flight request promise. Auto-removes on settle.
	 */
	trackRequest(p: Promise<unknown>): void {
		this.inFlightRequests.add(p);
		const cleanup = () => {
			this.inFlightRequests.delete(p);
			if (this.inFlightRequests.size === 0) {
				for (const resolve of this.idleResolvers) resolve();
				this.idleResolvers = [];
			}
		};
		p.then(cleanup, cleanup);
	}

	isIdle(): boolean {
		return this.inFlightRequests.size === 0;
	}

	/**
	 * Returns a promise that resolves when all in-flight requests have settled.
	 */
	onceIdle(): Promise<void> {
		if (this.isIdle()) return Promise.resolve();
		return new Promise<void>(resolve => {
			this.idleResolvers.push(resolve);
		});
	}

	/**
	 * Start the managed server. Checks for existing process via PID file first.
	 */
	async start(isFirstStart = false): Promise<void> {
		// Check for existing running server via PID file
		const reused = await this.tryReusePid();
		if (reused) return;

		const serverPath = await this.options.getServerBinaryPath();
		if (!serverPath) {
			this.setState('not_installed');
			return;
		}

		const port = this.options.getPort();
		const modelsIni = this.options.getModelsIniPath();
		const extraArgs = this.options.getExtraArgs();
		const version = await this.options.getCurrentVersion();

		const args = [
			'--port', String(port),
			'--models-preset', modelsIni,
			'--timeout', '3600',
			...extraArgs,
		];

		this.setState('starting');
		this.output.appendLine(`[managed] Starting: ${serverPath} ${args.join(' ')}`);

		this.proc = spawn(serverPath, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stderrBuffer = '';
		const earlyExitTimeout = setTimeout(() => { stderrBuffer = ''; }, 2000);

		this.proc.stdout?.on('data', (data: Buffer) => {
			this.output.append(data.toString());
		});

		this.proc.stderr?.on('data', (data: Buffer) => {
			const text = data.toString();
			this.output.append(text);
			stderrBuffer += text;
		});

		this.proc.on('exit', (code, signal) => {
			clearTimeout(earlyExitTimeout);
			this._exitCode = code ?? undefined;
			this.proc = undefined;
			this.stopHealthPoll();

			// Check for port-in-use
			if (code !== 0 && (stderrBuffer.includes('bind') || stderrBuffer.includes('address already in use'))) {
				this.setState('crashed');
				vscode.window.showErrorMessage(
					`Port ${port} is already in use. Change the port in Settings → Llama Copilot → Server → Port, or stop the other process.`
				);
				return;
			}

			if (this._state !== 'stopped' && this._state !== 'updating') {
				this.setState('crashed');
				this.output.appendLine(`[managed] Server exited with code ${code}, signal ${signal}`);
			}

			this.cleanupPidFile();
		});

		// Write PID file
		if (this.proc.pid) {
			await this.writePidFile({
				pid: this.proc.pid,
				port,
				version: version ?? 'unknown',
			});
		}

		// Start health polling
		const maxWaitMs = isFirstStart ? 30 * 60 * 1000 : 60 * 1000;
		await this.pollHealth(port, maxWaitMs);
	}

	/**
	 * Stop the managed server.
	 */
	async stop(): Promise<void> {
		this.stopHealthPoll();
		if (this.proc) {
			this.setState('stopped');
			this.proc.kill('SIGTERM');
			// Give it 5s to exit gracefully, then SIGKILL
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => {
					if (this.proc) this.proc.kill('SIGKILL');
					resolve();
				}, 5000);
				this.proc!.on('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			this.proc = undefined;
		} else {
			// Try killing via PID file
			const pidData = await this.readPidFile();
			if (pidData) {
				try { process.kill(pidData.pid, 'SIGTERM'); } catch { /* ignore */ }
			}
			this.setState('stopped');
		}
		await this.cleanupPidFile();
	}

	/**
	 * Restart the server.
	 */
	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	/**
	 * Attempt to restart with user confirmation if requests are in-flight.
	 */
	async restartWithConfirmation(): Promise<void> {
		if (this.isIdle()) {
			await this.restart();
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			'Restart llama-server? Active requests will be cancelled.',
			'Restart Now',
			'Wait'
		);

		if (choice === 'Restart Now') {
			await this.restart();
		} else if (choice === 'Wait') {
			vscode.window.showInformationMessage('Server will restart when current requests finish.');
			await this.onceIdle();
			await this.restart();
		}
	}

	dispose(): void {
		this.stopHealthPoll();
		this._stateEmitter.dispose();
		this.output.dispose();
	}

	/**
	 * Kill and clean up the managed server on deactivate (if configured).
	 */
	async shutdown(): Promise<void> {
		await this.stop();
	}

	private async tryReusePid(): Promise<boolean> {
		const pidData = await this.readPidFile();
		if (!pidData) return false;

		// Step 1: Check if PID is alive
		try {
			process.kill(pidData.pid, 0);
		} catch {
			// Process does not exist -- stale PID file
			await this.cleanupPidFile();
			return false;
		}

		// Step 2: Verify it's llama-server on our port via /health
		const port = this.options.getPort();
		if (pidData.port !== port) {
			// Port mismatch -- can't reuse
			await this.cleanupPidFile();
			return false;
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(3000),
			});
			if (response.status === 200) {
				this.setState('running');
				this.output.appendLine(`[managed] Reusing existing server (PID ${pidData.pid}, port ${port})`);
				this.startHealthPoll(port);
				return true;
			} else if (response.status === 503) {
				this.setState('loading_model');
				this.output.appendLine(`[managed] Reusing existing server (loading model, PID ${pidData.pid})`);
				this.startHealthPoll(port);
				return true;
			}
		} catch {
			// Health check failed -- PID is alive but not our server
		}

		// Step 3: Version mismatch check
		const currentVersion = await this.options.getCurrentVersion();
		if (currentVersion && pidData.version !== currentVersion) {
			// Kill old process, it's outdated
			try { process.kill(pidData.pid, 'SIGTERM'); } catch { /* ignore */ }
			await this.cleanupPidFile();
			return false;
		}

		await this.cleanupPidFile();
		return false;
	}

	private async pollHealth(port: number, maxWaitMs: number): Promise<void> {
		const startTime = Date.now();
		const interval = 1000;

		return new Promise<void>(resolve => {
			const check = async () => {
				if (Date.now() - startTime > maxWaitMs) {
					if (this._state === 'starting') {
						this.output.appendLine('[managed] Health poll timed out');
					}
					resolve();
					return;
				}

				if (!this.proc && this._state === 'starting') {
					// Process died during startup
					resolve();
					return;
				}

				try {
					const response = await fetch(`http://127.0.0.1:${port}/health`, {
						signal: AbortSignal.timeout(2000),
					});
					if (response.status === 200) {
						this.setState('running');
						this.output.appendLine('[managed] Server is healthy');
						this.startHealthPoll(port);
						resolve();
						return;
					} else if (response.status === 503) {
						this.setState('loading_model');
					}
				} catch {
					// Still starting
				}

				setTimeout(check, interval);
			};

			setTimeout(check, interval);
		});
	}

	private startHealthPoll(port: number): void {
		this.stopHealthPoll();
		this.healthPollTimer = setInterval(async () => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/health`, {
					signal: AbortSignal.timeout(5000),
				});
				if (response.status === 200 && this._state !== 'running') {
					this.setState('running');
				} else if (response.status === 503 && this._state === 'running') {
					this.setState('loading_model');
				}
			} catch {
				if (this._state === 'running' || this._state === 'loading_model') {
					// Check if process is still alive
					if (!this.proc) {
						this.setState('crashed');
						this.stopHealthPoll();
					}
				}
			}
		}, 10_000);
	}

	private stopHealthPoll(): void {
		if (this.healthPollTimer) {
			clearInterval(this.healthPollTimer);
			this.healthPollTimer = undefined;
		}
	}

	private async writePidFile(data: PidFileData): Promise<void> {
		await fs.mkdir(path.dirname(this.pidFilePath), { recursive: true });
		await fs.writeFile(this.pidFilePath, JSON.stringify(data), 'utf-8');
	}

	private async readPidFile(): Promise<PidFileData | null> {
		try {
			const content = await fs.readFile(this.pidFilePath, 'utf-8');
			return JSON.parse(content) as PidFileData;
		} catch {
			return null;
		}
	}

	private async cleanupPidFile(): Promise<void> {
		try { await fs.unlink(this.pidFilePath); } catch { /* ignore */ }
	}
}
