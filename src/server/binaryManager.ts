/**
 * Manages downloading, extracting, and versioning llama-server binaries
 * from the ggml-org/llama.cpp GitHub Releases.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPlatformAsset, getAssetFilename, getServerBinaryName, getCliBinaryName } from './platform';

const execFileAsync = promisify(execFile);

const GITHUB_API_BASE = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';
const USER_AGENT = 'DelftSolutions-llama-copilot (https://github.com/DelftSolutions/vscode-llama-copilot)';

export interface BinaryManagerOptions {
	globalStorageUri: vscode.Uri;
}

interface StateJson {
	currentVersion?: string;
	lastUpdateCheckTimestamp?: number;
}

/**
 * Manages the llama-server binary lifecycle: download, extract, version tracking.
 */
export class BinaryManager {
	private readonly binDir: string;
	private readonly stateFilePath: string;
	private stateCache: StateJson | null = null;

	constructor(private readonly options: BinaryManagerOptions) {
		this.binDir = path.join(options.globalStorageUri.fsPath, 'bin');
		this.stateFilePath = path.join(options.globalStorageUri.fsPath, 'state.json');
	}

	/**
	 * Whether a binary is currently installed and usable.
	 */
	async isInstalled(): Promise<boolean> {
		const version = await this.currentVersion();
		if (!version) return false;
		const serverPath = this.getServerPath(version);
		try {
			await fs.access(serverPath, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get the currently installed version (build number), or null if not installed.
	 */
	async currentVersion(): Promise<string | null> {
		const state = await this.readState();
		return state.currentVersion ?? null;
	}

	/**
	 * Get path to the llama-server binary for the given version.
	 */
	getServerPath(version?: string): string {
		const ver = version ?? 'current';
		return path.join(this.binDir, ver, getServerBinaryName());
	}

	/**
	 * Get path to the llama-cli binary for the given version.
	 */
	getCliPath(version?: string): string {
		const ver = version ?? 'current';
		return path.join(this.binDir, ver, getCliBinaryName());
	}

	/**
	 * Get the path to the server binary for the currently installed version.
	 */
	async getCurrentServerPath(): Promise<string | null> {
		const version = await this.currentVersion();
		if (!version) return null;
		return this.getServerPath(version);
	}

	/**
	 * Get the path to the CLI binary for the currently installed version.
	 */
	async getCurrentCliPath(): Promise<string | null> {
		const version = await this.currentVersion();
		if (!version) return null;
		return this.getCliPath(version);
	}

	/**
	 * Fetch the latest release version (build number) from GitHub.
	 * Returns the tag name (e.g. 'b5000') or null on failure.
	 */
	async latestVersion(): Promise<string | null> {
		try {
			const response = await fetch(`${GITHUB_API_BASE}/latest`, {
				headers: {
					'User-Agent': USER_AGENT,
					'Accept': 'application/vnd.github.v3+json',
				},
			});
			if (!response.ok) return null;
			const data = await response.json() as { tag_name?: string };
			const tag = data.tag_name;
			if (!tag) return null;
			// Tags are like 'b5000' -- strip the 'b' prefix for our version string
			return tag.startsWith('b') ? tag.slice(1) : tag;
		} catch {
			return null;
		}
	}

	/**
	 * Check if 24 hours have passed since the last update check.
	 */
	async canCheckForUpdate(): Promise<boolean> {
		const state = await this.readState();
		if (!state.lastUpdateCheckTimestamp) return true;
		const elapsed = Date.now() - state.lastUpdateCheckTimestamp;
		return elapsed >= 24 * 60 * 60 * 1000;
	}

	/**
	 * Record that an update check was performed.
	 */
	async recordUpdateCheck(): Promise<void> {
		const state = await this.readState();
		state.lastUpdateCheckTimestamp = Date.now();
		await this.writeState(state);
	}

	/**
	 * Download and install the binary for the given version.
	 * Throws on failure or cancellation ('Download cancelled').
	 */
	async download(
		version: string,
		token?: vscode.CancellationToken
	): Promise<void> {
		await this.downloadCore(version, { token });
	}

	/**
	 * Download with a VS Code progress notification.
	 * Returns true on success, false if cancelled.
	 */
	async downloadWithProgress(version: string): Promise<boolean> {
		let lastPercent = 0;
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Downloading llama-server (${getAssetFilename(version)})...`,
				cancellable: true,
			},
			async (progress, token) => {
				try {
					await this.downloadCore(version, {
						token,
						onProgress: percent => {
							progress.report({
								increment: percent - lastPercent,
								message: `${percent}%`,
							});
							lastPercent = percent;
						},
					});
					return true;
				} catch (e) {
					if ((e as Error).message === 'Download cancelled') {
						return false;
					}
					throw e;
				}
			}
		);
	}

	/**
	 * Download, reporting percentage progress (0-100) via callback for UIs that
	 * render their own progress (e.g. the onboarding wizard panel).
	 * Returns true on success, false if cancelled.
	 */
	async downloadWithCallback(
		version: string,
		onProgress: (percent: number) => void
	): Promise<boolean> {
		try {
			await this.downloadCore(version, { onProgress });
			return true;
		} catch (e) {
			if ((e as Error).message === 'Download cancelled') {
				return false;
			}
			throw e;
		}
	}

	/**
	 * Shared download pipeline: fetch → write → extract → quarantine/chmod →
	 * verify → state update. `onProgress` is called with integer percentages
	 * (only when the value increases) as download chunks arrive.
	 */
	private async downloadCore(
		version: string,
		opts: { token?: vscode.CancellationToken; onProgress?: (percent: number) => void } = {}
	): Promise<void> {
		const asset = getPlatformAsset();
		const filename = getAssetFilename(version);
		const downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/b${version}/${filename}`;

		const extractDir = path.join(this.binDir, version);
		await fs.mkdir(extractDir, { recursive: true });

		const archivePath = path.join(this.binDir, filename);

		try {
			// Download the archive
			const response = await fetch(downloadUrl, {
				headers: { 'User-Agent': USER_AGENT },
			});

			if (!response.ok) {
				throw new Error(`Download failed: HTTP ${response.status} for ${downloadUrl}`);
			}

			const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
			const reader = response.body?.getReader();
			if (!reader) throw new Error('No response body');

			const chunks: Uint8Array[] = [];
			let downloaded = 0;
			let lastPercent = 0;

			while (true) {
				if (opts.token?.isCancellationRequested) {
					reader.cancel();
					throw new Error('Download cancelled');
				}

				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				downloaded += value.length;

				if (contentLength > 0 && opts.onProgress) {
					const percent = Math.floor((downloaded / contentLength) * 100);
					if (percent > lastPercent) {
						lastPercent = percent;
						opts.onProgress(percent);
					}
				}
			}

			// Write to file
			const buffer = Buffer.concat(chunks);
			await fs.writeFile(archivePath, buffer);

			// Extract
			await this.extract(archivePath, extractDir, asset.ext);

			// macOS quarantine removal
			if (process.platform === 'darwin') {
				await this.clearQuarantine(extractDir);
			}

			// chmod +x on Unix
			if (process.platform !== 'win32') {
				await this.makeExecutable(extractDir);
			}

			// Verify binary exists
			await this.verifyBinary(extractDir);

			// Update state
			const state = await this.readState();
			state.currentVersion = version;
			await this.writeState(state);
		} catch (e) {
			if ((e as Error).message === 'Download cancelled') {
				// Clean up partial extraction
				try { await fs.rm(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
			throw e;
		} finally {
			// Clean up archive file
			try { await fs.unlink(archivePath); } catch { /* ignore */ }
		}
	}

	private async extract(archivePath: string, extractDir: string, ext: string): Promise<void> {
		if (ext === '.tar.gz') {
			await execFileAsync('tar', ['xzf', archivePath, '-C', extractDir]);
		} else if (ext === '.zip') {
			await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir]);
		} else {
			throw new Error(`Unsupported archive format: ${ext}`);
		}
	}

	private async clearQuarantine(dir: string): Promise<void> {
		try {
			await execFileAsync('xattr', ['-cr', dir]);
		} catch (e) {
			const msg = (e as Error).message || String(e);
			throw new Error(
				`Failed to clear macOS quarantine on downloaded binaries: ${msg}. ` +
				`Try running manually: xattr -cr "${dir}" or allow the binary in System Settings > Privacy & Security.`
			);
		}
	}

	private async makeExecutable(dir: string): Promise<void> {
		const serverPath = path.join(dir, getServerBinaryName());
		const cliPath = path.join(dir, getCliBinaryName());

		for (const p of [serverPath, cliPath]) {
			try {
				await fs.chmod(p, 0o755);
			} catch {
				// File might not exist (e.g. cli might be in a subdirectory)
			}
		}

		// Some releases extract into a subdirectory -- try to find binaries
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const subServerPath = path.join(dir, entry.name, getServerBinaryName());
				const subCliPath = path.join(dir, entry.name, getCliBinaryName());
				for (const p of [subServerPath, subCliPath]) {
					try {
						await fs.chmod(p, 0o755);
					} catch { /* ignore */ }
				}
			}
		}
	}

	private async verifyBinary(extractDir: string): Promise<void> {
		const serverName = getServerBinaryName();

		// Check directly in extract dir
		try {
			await fs.access(path.join(extractDir, serverName));
			return;
		} catch { /* not found directly, check subdirectories */ }

		// Check in subdirectories (some releases extract into a folder)
		const entries = await fs.readdir(extractDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				try {
					await fs.access(path.join(extractDir, entry.name, serverName));
					// Move contents up to extractDir for consistent paths
					const subDir = path.join(extractDir, entry.name);
					const subEntries = await fs.readdir(subDir);
					for (const se of subEntries) {
						await fs.rename(path.join(subDir, se), path.join(extractDir, se));
					}
					await fs.rmdir(subDir);
					return;
				} catch { /* not in this subdir */ }
			}
		}

		// Still not found
		const listing = entries.map(e => e.name).join(', ');
		throw new Error(
			`llama-server binary not found after extraction. Expected '${serverName}' in ${extractDir}. ` +
			`Directory contents: [${listing}]`
		);
	}

	private async readState(): Promise<StateJson> {
		if (this.stateCache) return this.stateCache;
		try {
			const data = await fs.readFile(this.stateFilePath, 'utf-8');
			this.stateCache = JSON.parse(data) as StateJson;
			return this.stateCache;
		} catch {
			this.stateCache = {};
			return this.stateCache;
		}
	}

	private async writeState(state: StateJson): Promise<void> {
		this.stateCache = state;
		await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
		await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, '\t'));
	}
}
