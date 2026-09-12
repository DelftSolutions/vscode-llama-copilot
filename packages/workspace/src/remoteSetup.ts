import * as vscode from 'vscode';
import { deriveAllForwards, type Forward } from '@llama-copilot/shared';
import { isPrivateOrLocalAddress, getEffectiveEndpoints } from '@llama-copilot/shared';
import { logError } from '@llama-copilot/shared';
import { EndpointsConfig, EndpointConfig } from '@llama-copilot/shared';

const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeResult {
	reachable: boolean;
	status?: string;
}

/**
 * Lightweight HTTP GET to /health to check if a tunnel endpoint is reachable.
 * Distinguishes "connection refused" (tunnel not open) from "server not
 * responding" (tunnel open but server down).
 */
export async function probeEndpoint(
	url: string,
	timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(`${url}/health`, { signal: controller.signal });
		clearTimeout(timer);
		if (res.ok) {
			return { reachable: true, status: 'ok' };
		}
		return { reachable: false, status: `http-${res.status}` };
	} catch (err) {
		clearTimeout(timer);
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
			return { reachable: false, status: 'connection-refused' };
		}
		return { reachable: false, status: 'error' };
	}
}

let probeTimer: ReturnType<typeof setInterval> | undefined;
let probeDisposable: vscode.Disposable | undefined;

/**
 * Start a background re-probe loop for all tunnel endpoints.
 * On state change (reachable <-> unreachable), calls onResult
 * which should trigger refreshProviders().
 */
export function startProbeLoop(
	allForwards: Forward[],
	probeResults: Map<number, boolean>,
	onResult: () => void,
): vscode.Disposable {
	if (probeTimer) {
		clearInterval(probeTimer);
	}

	const runProbes = async () => {
		let changed = false;
		for (const fw of allForwards) {
			const url = `http://127.0.0.1:${fw.remotePort}`;
			const result = await probeEndpoint(url);
			const prev = probeResults.get(fw.remotePort);
			probeResults.set(fw.remotePort, result.reachable);
			if (prev !== result.reachable) {
				changed = true;
			}
		}
		if (changed) {
			onResult();
		}
	};

	void runProbes();
	probeTimer = setInterval(() => void runProbes(), PROBE_INTERVAL_MS);

	probeDisposable = new vscode.Disposable(() => {
		if (probeTimer) {
			clearInterval(probeTimer);
			probeTimer = undefined;
		}
	});

	return probeDisposable;
}

/**
 * Main remote activation logic. Called from workspace extension when
 * vscode.env.remoteName is set and a local UI host exists.
 */
export async function handleRemoteActivation(
	isManaged: boolean,
	managedPort: number | null,
	userEndpoints: EndpointsConfig,
	probeResults: Map<number, boolean>,
	onProbeChange: () => void,
): Promise<vscode.Disposable | undefined> {
	const allForwards = deriveAllForwards(
		managedPort,
		userEndpoints,
		isPrivateOrLocalAddress,
	);

	if (allForwards.length === 0) return undefined;

	// Initial probe of all tunnel endpoints
	for (const fw of allForwards) {
		const url = `http://127.0.0.1:${fw.remotePort}`;
		const result = await probeEndpoint(url);
		probeResults.set(fw.remotePort, result.reachable);
	}

	// Check managed endpoint specifically
	if (isManaged && managedPort !== null) {
		const managedForward = allForwards.find(f => f.label === 'managed server');
		if (managedForward) {
			const reachable = probeResults.get(managedForward.remotePort);
			if (!reachable) {
				showTunnelUnreachableMessage(managedForward.remotePort);
			}
		}
	}

	onProbeChange();

	// Start background re-probe
	return startProbeLoop(allForwards, probeResults, onProbeChange);
}

function showTunnelUnreachableMessage(remotePort: number): void {
	const msg = `The managed llama-server is not reachable through the SSH tunnel on port ${remotePort}. `
		+ 'The server may be running locally but the SSH RemoteForward is not configured.';

	vscode.window.showWarningMessage(msg, 'Configure SSH Forwards', 'Start Server', 'Dismiss')
		.then(action => {
			if (action === 'Configure SSH Forwards') {
				vscode.commands.executeCommand('llamaCopilot.configureSSHForward');
			} else if (action === 'Start Server') {
				vscode.commands.executeCommand('llamaCopilot.startServer');
			}
		});
}
