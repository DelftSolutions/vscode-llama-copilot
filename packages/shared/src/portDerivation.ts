/**
 * Deterministic port derivation for SSH RemoteForward tunnels.
 *
 * Both the UI extension (local) and workspace extension (remote) compute
 * identical port mappings from the same settings values. No shared mutable
 * state (globalState is per-extension-ID).
 *
 * Scheme:
 *   - Managed server: always 48100 (hardcoded, well-known)
 *   - All other endpoints: 48101 + (fnv1a(host + ":" + port) % 899)
 *     Range: 48101..48999 (899 slots)
 *   - Collisions resolved via lexicographic-order linear probing
 */

/** Well-known port for the managed server tunnel */
export const MANAGED_REMOTE_PORT = 48100;

const PORT_BASE = 48101;
const PORT_RANGE = 899; // 48101..48999

export interface Forward {
	remotePort: number;
	localHost: string;
	localPort: number;
	label: string;
}

/**
 * FNV-1a hash (32-bit) of a UTF-8 string. Fast, non-cryptographic,
 * good distribution. ~10 lines, zero dependencies.
 */
export function fnv1a(input: string): number {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime
	}
	return hash >>> 0; // unsigned 32-bit
}

interface LocalEndpoint {
	localHost: string;
	localPort: number;
	label: string;
}

/**
 * Derive all SSH RemoteForward entries from current settings.
 *
 * @param managedPort - server.port if server.managed is true, else null
 * @param endpoints   - parsed llamaCopilot.endpoints
 * @param isPrivateOrLocal - predicate to test if a hostname is private/local
 */
export function deriveAllForwards(
	managedPort: number | null,
	endpoints: Record<string, { url: string }>,
	isPrivateOrLocal: (hostname: string) => boolean,
): Forward[] {
	const locals: LocalEndpoint[] = [];

	if (managedPort !== null) {
		locals.push({ localHost: '127.0.0.1', localPort: managedPort, label: 'managed server' });
	}

	for (const [key, ep] of Object.entries(endpoints)) {
		try {
			const u = new URL(ep.url);
			const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
			const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
			if (isPrivateOrLocal(host)) {
				const dedupKey = `${host}:${port}`;
				if (!locals.some(l => `${l.localHost}:${l.localPort}` === dedupKey)) {
					locals.push({ localHost: host, localPort: port, label: key });
				}
			}
		} catch {
			// skip malformed URLs
		}
	}

	const forwards: Forward[] = [];

	// Managed always gets MANAGED_REMOTE_PORT
	const managed = locals.filter(l => l.label === 'managed server');
	const others = locals.filter(l => l.label !== 'managed server');

	for (const m of managed) {
		forwards.push({
			remotePort: MANAGED_REMOTE_PORT,
			localHost: m.localHost,
			localPort: m.localPort,
			label: m.label,
		});
	}

	// Hash-based assignment for non-managed endpoints
	const occupied = new Set<number>();
	if (managed.length > 0) {
		occupied.add(MANAGED_REMOTE_PORT);
	}

	// Group by base slot for collision resolution
	const slotGroups = new Map<number, LocalEndpoint[]>();
	for (const ep of others) {
		const key = `${ep.localHost}:${ep.localPort}`;
		const baseSlot = fnv1a(key) % PORT_RANGE;
		const group = slotGroups.get(baseSlot) ?? [];
		group.push(ep);
		slotGroups.set(baseSlot, group);
	}

	// Sort groups deterministically, then assign with linear probing
	const sortedSlots = [...slotGroups.entries()].sort((a, b) => a[0] - b[0]);

	for (const [baseSlot, group] of sortedSlots) {
		// Lexicographic sort within collision group for determinism
		group.sort((a, b) => {
			const ka = `${a.localHost}:${a.localPort}`;
			const kb = `${b.localHost}:${b.localPort}`;
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});

		let probeOffset = 0;
		for (const ep of group) {
			let slot = (baseSlot + probeOffset) % PORT_RANGE;
			while (occupied.has(PORT_BASE + slot)) {
				probeOffset++;
				slot = (baseSlot + probeOffset) % PORT_RANGE;
			}
			const remotePort = PORT_BASE + slot;
			occupied.add(remotePort);
			forwards.push({
				remotePort,
				localHost: ep.localHost,
				localPort: ep.localPort,
				label: ep.label,
			});
			probeOffset++;
		}
	}

	return forwards;
}

/**
 * Look up the remote port for a specific local host:port in a forward list.
 */
export function deriveRemotePort(
	localHost: string,
	localPort: number,
	allForwards: Forward[],
): number | undefined {
	const f = allForwards.find(
		fw => fw.localHost === localHost && fw.localPort === localPort,
	);
	return f?.remotePort;
}
