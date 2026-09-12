/**
 * Private/local address detection and endpoint URL rewriting for
 * SSH RemoteForward tunnels.
 *
 * Shared between UI and workspace extensions so both compute
 * identical tunnel requirements from the same settings.
 */

import type { Forward } from './portDerivation.js';

/**
 * Detect whether a hostname is private, local, or link-local.
 *
 * Checks:
 *   - localhost, 127.0.0.0/8, ::1
 *   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918)
 *   - fe80::/10 (link-local), fc00::/7 (ULA, includes fd00::/8)
 *   - *.local (mDNS)
 *
 * Does NOT resolve DNS — literal IPs and known patterns only.
 */
export function isPrivateOrLocalAddress(hostname: string): boolean {
	const lower = hostname.toLowerCase();

	if (lower === 'localhost') return true;
	if (lower.endsWith('.local')) return true;

	// IPv4
	const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4Match) {
		const [, a, b] = ipv4Match.map(Number);
		if (a === 127) return true;               // 127.0.0.0/8
		if (a === 10) return true;                 // 10.0.0.0/8
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
		if (a === 192 && b === 168) return true;   // 192.168.0.0/16
		return false;
	}

	// IPv6 (normalized lowercase, brackets already stripped by caller)
	const ipv6 = lower.replace(/^\[|\]$/g, '');
	if (ipv6 === '::1') return true;

	// Expand leading groups for prefix checks
	const expanded = expandIPv6(ipv6);
	if (expanded) {
		const first16 = parseInt(expanded.substring(0, 4), 16);
		if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10
		if ((first16 & 0xfe00) === 0xfc00) return true;  // fc00::/7
	}

	return false;
}

/**
 * Expand an IPv6 address to its full 32-hex-char form (no colons).
 * Returns null on parse failure.
 */
function expandIPv6(addr: string): string | null {
	const parts = addr.split('::');
	if (parts.length > 2) return null;

	let groups: string[];
	if (parts.length === 2) {
		const left = parts[0] ? parts[0].split(':') : [];
		const right = parts[1] ? parts[1].split(':') : [];
		const missing = 8 - left.length - right.length;
		if (missing < 0) return null;
		groups = [...left, ...Array(missing).fill('0'), ...right];
	} else {
		groups = addr.split(':');
	}

	if (groups.length !== 8) return null;
	return groups.map(g => g.padStart(4, '0')).join('');
}

/**
 * Extract local-network endpoints from a URL-keyed endpoint config.
 * Returns the host:port pairs that need tunneling.
 */
export function getLocalNetworkEndpointPorts(
	endpoints: Record<string, { url: string }>,
): Array<{ host: string; port: number; key: string }> {
	const result: Array<{ host: string; port: number; key: string }> = [];
	for (const [key, ep] of Object.entries(endpoints)) {
		try {
			const u = new URL(ep.url);
			const host = u.hostname.replace(/^\[|\]$/g, '');
			const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
			if (isPrivateOrLocalAddress(host)) {
				result.push({ host, port, key });
			}
		} catch {
			// skip malformed
		}
	}
	return result;
}

/**
 * Rewrite endpoint URLs for remote sessions: private/local addresses
 * become 127.0.0.1:<tunnelPort> after SSH RemoteForward.
 *
 * Non-private endpoints are returned unchanged. Only endpoints whose
 * probe succeeded (present in probeResults with reachable=true) are rewritten.
 */
export function getEffectiveEndpoints<T extends { url: string }>(
	endpoints: Record<string, T>,
	allForwards: Forward[],
	probeResults: Map<number, boolean>,
): Record<string, T> {
	const result: Record<string, T> = {};
	for (const [key, ep] of Object.entries(endpoints)) {
		try {
			const u = new URL(ep.url);
			const host = u.hostname.replace(/^\[|\]$/g, '');
			const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);

			if (isPrivateOrLocalAddress(host)) {
				const fw = allForwards.find(
					f => f.localHost === host && f.localPort === port,
				);
				if (fw && probeResults.get(fw.remotePort) === true) {
					const rewritten = new URL(ep.url);
					rewritten.hostname = '127.0.0.1';
					rewritten.port = String(fw.remotePort);
					result[key] = { ...ep, url: rewritten.toString().replace(/\/$/, '') };
					continue;
				}
			}
		} catch {
			// pass through malformed URLs
		}
		result[key] = ep;
	}
	return result;
}
