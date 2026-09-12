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
const GITHUB_RELEASE_DOWNLOAD_BASE = 'https://github.com/ggml-org/llama.cpp/releases';
const USER_AGENT = 'DelftSolutions-llama-copilot (https://github.com/DelftSolutions/vscode-llama-copilot)';

/** Timeout (ms) for GitHub requests made while resolving the release. */
const RELEASE_LOOKUP_TIMEOUT_MS = 15_000;

/** Header timeout (ms) for the binary download: how long to wait for the server to start responding. */
const DEFAULT_DOWNLOAD_HEADER_TIMEOUT_MS = 20_000;

/** Stall timeout (ms) for the binary download: abort if no data arrives while streaming the body. */
const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

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
	 * Fetch the latest nightly build version (build number) from GitHub.
	 *
	 * llama.cpp's latest *stable* release (e.g. v0.4.0) ships no binaries --
	 * its only asset is a small `nightly-tag.txt` containing the current
	 * nightly tag (e.g. `b10809`). The binaries live in the `bNNNN` nightly
	 * (prerelease) releases, so we resolve that build number here.
	 *
	 * Returns e.g. '10809', or null if it cannot be determined.
	 */
	async latestVersion(): Promise<string | null> {
		try {
			// Primary: the latest release's nightly-tag.txt pointer.
			const fromTagFile = await this.fetchNightlyTag();
			if (fromTagFile) return fromTagFile;

			// Fallback: newest build that actually has our platform's asset
			// (nightly tags are published before asset uploads finish).
			return await this.findLatestBuildWithAsset();
		} catch {
			return null;
		}
	}

	/** Read the current nightly tag from the latest release's `nightly-tag.txt`. */
	private async fetchNightlyTag(): Promise<string | null> {
		const url = `${GITHUB_RELEASE_DOWNLOAD_BASE}/latest/download/nightly-tag.txt`;
		try {
			const response = await fetch(url, {
				headers: { 'User-Agent': USER_AGENT },
				signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS),
			});
			if (!response.ok) return null;
			const body = await response.text();
			const match = body.match(/b(\d+)/);
			return match ? match[1] : null;
		} catch {
			return null;
		}
	}

	/** Scan recent releases for the newest `bNNNN` build with this platform's asset. */
	private async findLatestBuildWithAsset(): Promise<string | null> {
		try {
			const response = await fetch(`${GITHUB_API_BASE}?per_page=20`, {
				headers: {
					'User-Agent': USER_AGENT,
					'Accept': 'application/vnd.github.v3+json',
				},
				signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS),
			});
			if (!response.ok) return null;
			const releases = (await response.json()) as Array<{
				tag_name?: string;
				assets?: Array<{ name?: string }>;
			}>;
			for (const release of releases) {
				const match = /^b(\d+)$/.exec(release.tag_name ?? '');
				if (!match) continue;
				const buildNumber = match[1];
				const expectedAsset = getAssetFilename(buildNumber);
				if ((release.assets ?? []).some(a => a.name === expectedAsset)) {
					return buildNumber;
				}
			}
			return null;
		} catch {
			// Includes unsupported platforms (getAssetFilename throws).
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
			// Download the archive (with header/stall watchdogs)
			const buffer = await downloadBuffer(downloadUrl, opts);

			// Write to file
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

export interface DownloadBufferOptions {
	/** Cancellation token (checked between chunks). */
	token?: vscode.CancellationToken;
	/** Reports integer percents (0-100) as chunks arrive (only when content-length is known). */
	onProgress?: (percent: number) => void;
	/** Override the header timeout (mostly for tests). */
	headerTimeoutMs?: number;
	/** Override the body-stall timeout (mostly for tests). */
	stallTimeoutMs?: number;
}

/**
 * Download a URL into memory with two watchdogs:
 * - header timeout: aborts when the server never responds;
 * - stall watchdog: aborts when the connection stops delivering data.
 * Without these a hung network leaves callers (e.g. the onboarding wizard)
 * waiting forever with no error.
 */
export async function downloadBuffer(downloadUrl: string, opts: DownloadBufferOptions = {}): Promise<Buffer> {
	const headerTimeoutMs = opts.headerTimeoutMs ?? DEFAULT_DOWNLOAD_HEADER_TIMEOUT_MS;
	const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS;

	const stallError = () => new Error(
		`Download stalled: no data received for ${stallTimeoutMs / 1000}s. ` +
		'Check your internet connection, proxy, or firewall.'
	);

	const controller = new AbortController();
	let abortReason: 'no-response' | 'stalled' | null = null;

	// Header timeout: the server never even starts responding.
	const headerTimer = setTimeout(() => {
		abortReason = 'no-response';
		controller.abort();
	}, headerTimeoutMs);

	let response: Response;
	try {
		response = await fetch(downloadUrl, {
			headers: { 'User-Agent': USER_AGENT },
			signal: controller.signal,
		});
	} catch (e) {
		if (abortReason === 'no-response') {
			throw new Error(
				`Download stalled: GitHub did not respond within ${headerTimeoutMs / 1000}s. ` +
				'Check your internet connection, proxy, or firewall.'
			);
		}
		throw e;
	} finally {
		clearTimeout(headerTimer);
	}

	if (!response.ok) {
		throw new Error(`Download failed: HTTP ${response.status} for ${downloadUrl}`);
	}

	const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
	const reader = response.body?.getReader();
	if (!reader) throw new Error('No response body');

	const chunks: Uint8Array[] = [];
	let downloaded = 0;
	let lastPercent = 0;

	// Stall watchdog: abort if no data arrives for stallTimeoutMs.
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	const resetStallTimer = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			abortReason = 'stalled';
			controller.abort();
			// Also cancel the body so a pending read() settles (real fetch rejects
			// it; the abortReason check below covers both outcomes).
			reader.cancel().catch(() => { /* ignore */ });
		}, stallTimeoutMs);
	};
	resetStallTimer();

	try {
		while (true) {
			if (opts.token?.isCancellationRequested) {
				await reader.cancel();
				throw new Error('Download cancelled');
			}

			let readResult: { done: boolean; value?: Uint8Array };
			try {
				readResult = await reader.read();
			} catch (e) {
				if (abortReason === 'stalled') {
					throw stallError();
				}
				throw e;
			}
			// A cancelled body may resolve the pending read as "done" --
			// check the watchdog flag before trusting the result.
			if (abortReason === 'stalled') {
				throw stallError();
			}
			if (readResult.done || !readResult.value) break;
			chunks.push(readResult.value);
			downloaded += readResult.value.length;
			resetStallTimer();

			if (contentLength > 0 && opts.onProgress) {
				const percent = Math.floor((downloaded / contentLength) * 100);
				if (percent > lastPercent) {
					lastPercent = percent;
					opts.onProgress(percent);
				}
			}
		}
	} finally {
		if (stallTimer) clearTimeout(stallTimer);
	}

	return Buffer.concat(chunks);
}
