import { describe, it, expect } from 'vitest';
import { fnv1a, deriveAllForwards, deriveRemotePort, MANAGED_REMOTE_PORT } from './portDerivation';
import { isPrivateOrLocalAddress } from './localNetworkEndpoints';

describe('fnv1a', () => {
	it('returns a 32-bit unsigned integer', () => {
		const hash = fnv1a('test');
		expect(hash).toBeGreaterThanOrEqual(0);
		expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
	});

	it('is deterministic', () => {
		expect(fnv1a('hello:8080')).toBe(fnv1a('hello:8080'));
	});

	it('produces different hashes for different inputs', () => {
		expect(fnv1a('a:1')).not.toBe(fnv1a('b:2'));
	});
});

describe('deriveAllForwards', () => {
	it('assigns MANAGED_REMOTE_PORT (48100) for managed server', () => {
		const forwards = deriveAllForwards(8013, {}, isPrivateOrLocalAddress);
		expect(forwards).toHaveLength(1);
		expect(forwards[0].remotePort).toBe(MANAGED_REMOTE_PORT);
		expect(forwards[0].localHost).toBe('127.0.0.1');
		expect(forwards[0].localPort).toBe(8013);
		expect(forwards[0].label).toBe('managed server');
	});

	it('returns empty array when no managed port and no private endpoints', () => {
		const forwards = deriveAllForwards(null, {
			pub: { url: 'https://api.example.com:443' },
		}, isPrivateOrLocalAddress);
		expect(forwards).toHaveLength(0);
	});

	it('assigns hash-based ports for private endpoints', () => {
		const forwards = deriveAllForwards(null, {
			myGPU: { url: 'http://192.168.1.50:8080' },
		}, isPrivateOrLocalAddress);
		expect(forwards).toHaveLength(1);
		expect(forwards[0].remotePort).toBeGreaterThanOrEqual(48101);
		expect(forwards[0].remotePort).toBeLessThanOrEqual(48999);
		expect(forwards[0].localHost).toBe('192.168.1.50');
		expect(forwards[0].localPort).toBe(8080);
	});

	it('is stable when adding an unrelated endpoint', () => {
		const before = deriveAllForwards(8013, {
			a: { url: 'http://192.168.1.50:8080' },
		}, isPrivateOrLocalAddress);

		const after = deriveAllForwards(8013, {
			a: { url: 'http://192.168.1.50:8080' },
			b: { url: 'http://192.168.1.60:8080' },
		}, isPrivateOrLocalAddress);

		const portA_before = before.find(f => f.label === 'a')!.remotePort;
		const portA_after = after.find(f => f.label === 'a')!.remotePort;
		expect(portA_after).toBe(portA_before);
	});

	it('is stable when removing an unrelated endpoint', () => {
		const before = deriveAllForwards(8013, {
			a: { url: 'http://192.168.1.50:8080' },
			b: { url: 'http://192.168.1.60:8080' },
		}, isPrivateOrLocalAddress);

		const after = deriveAllForwards(8013, {
			a: { url: 'http://192.168.1.50:8080' },
		}, isPrivateOrLocalAddress);

		const portA_before = before.find(f => f.label === 'a')!.remotePort;
		const portA_after = after.find(f => f.label === 'a')!.remotePort;
		expect(portA_after).toBe(portA_before);
	});

	it('managed is always first in the result', () => {
		const forwards = deriveAllForwards(8013, {
			gpu: { url: 'http://10.0.0.5:9090' },
		}, isPrivateOrLocalAddress);
		expect(forwards[0].label).toBe('managed server');
		expect(forwards[0].remotePort).toBe(MANAGED_REMOTE_PORT);
	});

	it('deduplicates by host:port', () => {
		const forwards = deriveAllForwards(null, {
			a: { url: 'http://192.168.1.50:8080' },
			b: { url: 'http://192.168.1.50:8080' },
		}, isPrivateOrLocalAddress);
		expect(forwards).toHaveLength(1);
	});

	it('handles collision resolution deterministically', () => {
		const forwards1 = deriveAllForwards(null, {
			a: { url: 'http://10.0.0.1:80' },
			b: { url: 'http://10.0.0.2:80' },
			c: { url: 'http://10.0.0.3:80' },
		}, isPrivateOrLocalAddress);

		const forwards2 = deriveAllForwards(null, {
			a: { url: 'http://10.0.0.1:80' },
			b: { url: 'http://10.0.0.2:80' },
			c: { url: 'http://10.0.0.3:80' },
		}, isPrivateOrLocalAddress);

		expect(forwards1.map(f => f.remotePort)).toEqual(forwards2.map(f => f.remotePort));
	});
});

describe('deriveRemotePort', () => {
	it('finds the remote port for a known forward', () => {
		const forwards = deriveAllForwards(8013, {}, isPrivateOrLocalAddress);
		expect(deriveRemotePort('127.0.0.1', 8013, forwards)).toBe(MANAGED_REMOTE_PORT);
	});

	it('returns undefined for unknown host:port', () => {
		const forwards = deriveAllForwards(8013, {}, isPrivateOrLocalAddress);
		expect(deriveRemotePort('1.2.3.4', 9999, forwards)).toBeUndefined();
	});
});
