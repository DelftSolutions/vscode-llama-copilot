/**
 * Best-effort hardware info for the onboarding wizard (free disk space, CPU name).
 * Never throws: every failure resolves to null.
 */

import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface DiskFreeCache {
	dir: string;
	freeMB: number;
	at: number;
}

let diskFreeCache: DiskFreeCache | null = null;
const DISK_FREE_TTL_MS = 60_000;

let cpuNameCache: string | null | undefined;

/**
 * Free disk space (MB) available to the user on the volume containing `dir`.
 * Cached for 60 seconds. Returns null on failure.
 */
export async function getDiskFreeMB(dir: string): Promise<number | null> {
	if (diskFreeCache && diskFreeCache.dir === dir && Date.now() - diskFreeCache.at < DISK_FREE_TTL_MS) {
		return diskFreeCache.freeMB;
	}
	try {
		const stats = await fs.statfs(dir);
		const freeMB = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
		diskFreeCache = { dir, freeMB, at: Date.now() };
		return freeMB;
	} catch {
		return null;
	}
}

/**
 * Human-friendly CPU name (e.g. "M3 Pro"). Best-effort; null when unavailable
 * (the UI falls back to omitting the CPU from the hardware line).
 */
export async function getCpuName(): Promise<string | null> {
	if (cpuNameCache !== undefined) return cpuNameCache;

	let name: string | null = null;
	try {
		if (process.platform === 'darwin') {
			const { stdout } = await execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
				timeout: 5000,
			});
			name = normalizeCpuName(stdout);
		} else if (process.platform === 'linux') {
			const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
			const line = cpuinfo.split('\n').find(l => l.startsWith('model name'));
			const value = line ? line.split(':').slice(1).join(':').trim() : undefined;
			name = normalizeCpuName(value);
		}
		// win32: no cheap reliable source — leave generic (null)
	} catch {
		name = null;
	}

	cpuNameCache = name;
	return name;
}

function normalizeCpuName(raw: string | undefined): string | null {
	if (!raw) return null;
	// "Apple M3 Pro" → "M3 Pro" (the vendor prefix is redundant in the UI)
	const name = raw.replace(/^Apple\s+/i, '').trim();
	return name || null;
}
