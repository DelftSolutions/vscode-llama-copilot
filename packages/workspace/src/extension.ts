import * as vscode from 'vscode';
import { initializeLogger, logError } from '@llama-copilot/shared';
import {
	CONFIG_SECTION,
	CONFIG_ENDPOINTS,
} from '@llama-copilot/shared';
import type { EndpointsConfig, EndpointConfig } from '@llama-copilot/shared';
import { deriveAllForwards, deriveRemotePort } from '@llama-copilot/shared';
import { isPrivateOrLocalAddress, getEffectiveEndpoints } from '@llama-copilot/shared';
import { LlamaCopilotChatProvider } from './provider.js';
import { InlineCompletionProvider } from './inlineCompletion/provider.js';
import {
	getConfig,
	endpointsConfigKey,
	endpointsSettingsKey,
	getInlineCompletionModel,
	isServerManaged,
	getServerPort,
} from './config.js';
import { getUIExtensionAPI, getUIExtensionAPIWithRetry, type LlamaCopilotUIAPI } from './uiExtensionApi.js';
import { handleRemoteActivation, probeEndpoint, startProbeLoop } from './remoteSetup.js';

let provider: LlamaCopilotChatProvider | undefined;
let providerDisposable: vscode.Disposable | undefined;
let inlineCompletionDisposable: vscode.Disposable | undefined;
let uiApi: LlamaCopilotUIAPI | undefined;
let uiApiDisposable: vscode.Disposable | undefined;
let probeDisposable: vscode.Disposable | undefined;

const probeResults = new Map<number, boolean>();

function normalizeEndpointUrl(url: string): string {
	let normalized = url.trim();
	if (normalized.endsWith('/v1')) normalized = normalized.slice(0, -3);
	if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
	return normalized;
}

function normalizeEndpoints(endpoints: EndpointsConfig): EndpointsConfig {
	const normalized: EndpointsConfig = {};
	for (const [key, config] of Object.entries(endpoints)) {
		normalized[key] = { ...config, url: normalizeEndpointUrl(config.url) };
	}
	return normalized;
}

/**
 * Build the effective endpoints map.
 *
 * Local sessions: get managed endpoint from UI extension API.
 * Remote sessions: probe-gated managed endpoint + URL rewriting for private endpoints.
 */
function buildEffectiveEndpoints(): EndpointsConfig {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const userEndpoints = config.get<EndpointsConfig>(CONFIG_ENDPOINTS, {});
	const normalized = normalizeEndpoints(userEndpoints);

	if (vscode.env.remoteName) {
		// Remote session — use probe results
		const managedPort = isServerManaged() ? getServerPort() : null;
		const allForwards = deriveAllForwards(managedPort, userEndpoints, isPrivateOrLocalAddress);

		// Managed endpoint: only add if probe succeeded
		if (managedPort !== null) {
			const managedForward = allForwards.find(f => f.label === 'managed server');
			if (managedForward && probeResults.get(managedForward.remotePort) === true) {
				normalized['managed'] = { url: `http://127.0.0.1:${managedForward.remotePort}` };
			}
		}

		// Rewrite private endpoint URLs whose probes succeeded
		return getEffectiveEndpoints(normalized, allForwards, probeResults);
	}

	// Local session — get managed endpoint from UI extension API
	if (uiApi?.getServerState() === 'running') {
		const port = uiApi.getServerPort();
		normalized['managed'] = { url: `http://127.0.0.1:${port}` };
	}

	return normalized;
}

let refreshPending = false;
let refreshRunning = false;

function refreshProviders(context: vscode.ExtensionContext): void {
	if (refreshRunning) { refreshPending = true; return; }
	refreshRunning = true;
	do {
		refreshPending = false;
		const endpoints = buildEffectiveEndpoints();
		const newProvider = registerProvider(endpoints, context);
		updateInlineCompletionProvider(endpoints, context);
		if (newProvider) {
			setTimeout(() => newProvider.fireChangeEvent(), 0);
		}
	} while (refreshPending);
	refreshRunning = false;
}

function registerProvider(endpoints: EndpointsConfig, context: vscode.ExtensionContext) {
	if (provider) { provider.dispose(); provider = undefined; }
	if (providerDisposable) {
		const idx = context.subscriptions.indexOf(providerDisposable);
		if (idx !== -1) context.subscriptions.splice(idx, 1);
		providerDisposable.dispose();
		providerDisposable = undefined;
	}

	provider = new LlamaCopilotChatProvider(endpoints);
	providerDisposable = vscode.lm.registerLanguageModelChatProvider('llama-server', provider);
	context.subscriptions.push(providerDisposable);
	return provider;
}

function updateInlineCompletionProvider(endpoints: EndpointsConfig, context: vscode.ExtensionContext): void {
	if (inlineCompletionDisposable) {
		const idx = context.subscriptions.indexOf(inlineCompletionDisposable);
		if (idx !== -1) context.subscriptions.splice(idx, 1);
		inlineCompletionDisposable.dispose();
		inlineCompletionDisposable = undefined;
	}
	const modelId = getInlineCompletionModel();
	if (modelId && Object.keys(endpoints).length > 0) {
		inlineCompletionDisposable = vscode.languages.registerInlineCompletionItemProvider(
			[{ language: '*' }],
			new InlineCompletionProvider(endpoints),
		);
		context.subscriptions.push(inlineCompletionDisposable);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('Llama Server API');
	context.subscriptions.push(outputChannel);
	initializeLogger(outputChannel);

	const hasLocalHost = vscode.env.uiKind === vscode.UIKind.Desktop;

	// Connect to UI extension API (local sessions only)
	if (hasLocalHost) {
		void tryConnectUIExtension(context);
	}

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('llamaCopilot.openEndpointSettings', () => {
			vscode.commands.executeCommand('workbench.action.openSettings', endpointsSettingsKey());
		}),
	);

	// Initial provider registration
	refreshProviders(context);

	// Watch config changes
	let wasServerManaged = isServerManaged();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(endpointsConfigKey()) || e.affectsConfiguration(`${CONFIG_SECTION}.server`)) {
				const nowManaged = isServerManaged();
				if (nowManaged && !wasServerManaged) {
					// User enabled managed mode — trigger onboarding in UI extension
					vscode.commands.executeCommand('llamaCopilot.onboarding').then(undefined, () => {});
				}
				wasServerManaged = nowManaged;
				refreshProviders(context);
			}
			if (e.affectsConfiguration(`${CONFIG_SECTION}.inlineCompletionModel`)) {
				refreshProviders(context);
			}
		}),
	);

	// Handle remote activation
	if (vscode.env.remoteName) {
		if (hasLocalHost) {
			void handleRemoteSessionActivation(context);
		} else {
			// Codespaces / web: no UI extension, no tunnels
			if (isServerManaged()) {
				vscode.window.showInformationMessage(
					'Managed llama-server is not available in browser-based remote sessions '
					+ '(no local machine to run the server). Configure a reachable endpoint in '
					+ 'Settings → Llama Copilot → Endpoints.',
				);
			}
		}
	}
}

async function tryConnectUIExtension(context: vscode.ExtensionContext): Promise<void> {
	uiApi = await getUIExtensionAPIWithRetry();
	if (uiApi) {
		uiApiDisposable = uiApi.onServerStateChanged(() => {
			refreshProviders(context);
		});
		context.subscriptions.push(uiApiDisposable);
		refreshProviders(context);
	}
}

async function handleRemoteSessionActivation(context: vscode.ExtensionContext): Promise<void> {
	const managedPort = isServerManaged() ? getServerPort() : null;
	const userEndpoints = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<EndpointsConfig>(CONFIG_ENDPOINTS, {});

	probeDisposable = await handleRemoteActivation(
		isServerManaged(),
		managedPort,
		userEndpoints,
		probeResults,
		() => refreshProviders(context),
	) ?? undefined;

	if (probeDisposable) {
		context.subscriptions.push(probeDisposable);
	}
}

export async function deactivate(): Promise<void> {
	if (provider) { provider.dispose(); provider = undefined; }
	if (providerDisposable) { providerDisposable.dispose(); providerDisposable = undefined; }
	if (inlineCompletionDisposable) { inlineCompletionDisposable.dispose(); inlineCompletionDisposable = undefined; }
	if (uiApiDisposable) { uiApiDisposable.dispose(); uiApiDisposable = undefined; }
	if (probeDisposable) { probeDisposable.dispose(); probeDisposable = undefined; }
}
