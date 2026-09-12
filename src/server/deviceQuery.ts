/**
 * Queries available GPU/accelerator devices via `llama-cli --list-devices`.
 * Also provides system RAM via os.totalmem().
 * Results are cached until explicitly invalidated (e.g. after binary update).
 */

import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DeviceInfo {
	id: string;
	name: string;
	totalMiB: number;
	freeMiB: number;
}

export interface SystemInfo {
	devices: DeviceInfo[];
	systemRamMB: number;
	/** Total VRAM across all non-BLAS devices */
	totalVramMB: number;
}

let cachedResult: SystemInfo | null = null;
let queryPromise: Promise<SystemInfo> | null = null;

/**
 * Parse the output of `llama-cli --list-devices`.
 * Defensive: tolerates unexpected formats, never throws.
 */
export function parseDeviceOutput(output: string): DeviceInfo[] {
	const lines = output.split('\n');

	// Find the "Available devices:" header
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === 'Available devices:') {
			headerIdx = i;
			break;
		}
	}

	if (headerIdx === -1) return [];

	const devices: DeviceInfo[] = [];
	const memoryPattern = /\((\d[\d,]*)\s*MiB,\s*(\d[\d,]*)\s*MiB free\)/;

	for (let i = headerIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		// Device lines are indented
		if (!line.match(/^\s+/)) break;

		const trimmed = line.trim();
		if (!trimmed) continue;

		// Split on first ':' to get device id and rest
		const colonIdx = trimmed.indexOf(':');
		if (colonIdx === -1) continue;

		const id = trimmed.slice(0, colonIdx).trim();
		const rest = trimmed.slice(colonIdx + 1).trim();

		// Try to extract memory info
		const memMatch = rest.match(memoryPattern);
		let totalMiB = 0;
		let freeMiB = 0;

		if (memMatch) {
			totalMiB = parseInt(memMatch[1].replace(/,/g, ''), 10);
			freeMiB = parseInt(memMatch[2].replace(/,/g, ''), 10);
		}

		// Extract device name (everything before the parenthesized memory info)
		const parenIdx = rest.indexOf('(');
		const name = parenIdx > 0 ? rest.slice(0, parenIdx).trim() : rest;

		devices.push({ id, name, totalMiB, freeMiB });
	}

	return devices;
}

/**
 * Run llama-cli --list-devices and return parsed results.
 * Returns cached result if available. Resolves with empty devices on failure.
 */
export function queryDevices(cliPath: string): Promise<SystemInfo> {
	if (cachedResult) return Promise.resolve(cachedResult);
	if (queryPromise) return queryPromise;

	queryPromise = doQuery(cliPath);
	return queryPromise;
}

async function doQuery(cliPath: string): Promise<SystemInfo> {
	const systemRamMB = Math.floor(os.totalmem() / (1024 * 1024));
	let devices: DeviceInfo[] = [];

	try {
		const { stdout, stderr } = await execFileAsync(cliPath, ['--list-devices'], {
			timeout: 60_000, // 60s timeout (Metal init can be slow)
		});
		// llama-cli outputs device info to stderr on some platforms, stdout on others
		const combinedOutput = stdout + '\n' + stderr;
		devices = parseDeviceOutput(combinedOutput);
	} catch {
		// Non-zero exit or timeout -- device info unavailable
		devices = [];
	}

	// Calculate total VRAM (exclude BLAS devices which report 0 or are CPU-side)
	const totalVramMB = devices
		.filter(d => !d.id.startsWith('BLAS'))
		.reduce((sum, d) => sum + d.totalMiB, 0);

	const result: SystemInfo = { devices, systemRamMB, totalVramMB };
	cachedResult = result;
	queryPromise = null;
	return result;
}

/**
 * Invalidate the cached device info (e.g. after a binary update).
 */
export function invalidateDeviceCache(): void {
	cachedResult = null;
	queryPromise = null;
}

/**
 * Get cached system info if available (non-blocking).
 */
export function getCachedSystemInfo(): SystemInfo | null {
	return cachedResult;
}
