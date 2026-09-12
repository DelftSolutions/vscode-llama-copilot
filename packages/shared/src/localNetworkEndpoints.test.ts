import { describe, it, expect } from 'vitest';
import { isPrivateOrLocalAddress } from './localNetworkEndpoints';

describe('isPrivateOrLocalAddress', () => {
	it('detects localhost', () => {
		expect(isPrivateOrLocalAddress('localhost')).toBe(true);
		expect(isPrivateOrLocalAddress('LOCALHOST')).toBe(true);
	});

	it('detects 127.x.x.x', () => {
		expect(isPrivateOrLocalAddress('127.0.0.1')).toBe(true);
		expect(isPrivateOrLocalAddress('127.255.255.255')).toBe(true);
	});

	it('detects RFC 1918 addresses', () => {
		expect(isPrivateOrLocalAddress('10.0.0.1')).toBe(true);
		expect(isPrivateOrLocalAddress('10.255.255.255')).toBe(true);
		expect(isPrivateOrLocalAddress('172.16.0.1')).toBe(true);
		expect(isPrivateOrLocalAddress('172.31.255.255')).toBe(true);
		expect(isPrivateOrLocalAddress('192.168.0.1')).toBe(true);
		expect(isPrivateOrLocalAddress('192.168.255.255')).toBe(true);
	});

	it('rejects public addresses', () => {
		expect(isPrivateOrLocalAddress('8.8.8.8')).toBe(false);
		expect(isPrivateOrLocalAddress('1.2.3.4')).toBe(false);
		expect(isPrivateOrLocalAddress('172.15.0.1')).toBe(false);
		expect(isPrivateOrLocalAddress('172.32.0.1')).toBe(false);
		expect(isPrivateOrLocalAddress('192.169.0.1')).toBe(false);
	});

	it('detects IPv6 loopback', () => {
		expect(isPrivateOrLocalAddress('::1')).toBe(true);
	});

	it('detects IPv6 link-local', () => {
		expect(isPrivateOrLocalAddress('fe80::1')).toBe(true);
	});

	it('detects IPv6 ULA', () => {
		expect(isPrivateOrLocalAddress('fd00::1')).toBe(true);
		expect(isPrivateOrLocalAddress('fc00::1')).toBe(true);
	});

	it('detects .local mDNS', () => {
		expect(isPrivateOrLocalAddress('myserver.local')).toBe(true);
	});

	it('rejects public hostnames', () => {
		expect(isPrivateOrLocalAddress('example.com')).toBe(false);
		expect(isPrivateOrLocalAddress('api.openai.com')).toBe(false);
	});
});
