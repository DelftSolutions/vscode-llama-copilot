import * as vscode from 'vscode';
import { LlamaCopilotChatProvider } from './provider';
import { initializeLogger } from './logger';
import { EndpointsConfig } from './types';
import { CONFIG_SECTION, CONFIG_ENDPOINTS, endpointsConfigKey, endpointsSettingsKey, getInlineCompletionModel } from './config';
import { InlineCompletionProvider } from './inlineCompletion/provider';

let provider: LlamaCopilotChatProvider | undefined;
let providerDisposable: vscode.Disposable | undefined;
let inlineCompletionDisposable: vscode.Disposable | undefined;

/**
 * Normalize endpoint URL by stripping trailing `/` or `/v1`
 */
function normalizeEndpointUrl(url: string): string {
	let normalized = url.trim();
	// Strip trailing `/v1`
	if (normalized.endsWith('/v1')) {
		normalized = normalized.slice(0, -3);
	}
	// Strip trailing `/`
	if (normalized.endsWith('/')) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

/**
 * Normalize all endpoint URLs in the configuration
 */
function normalizeEndpoints(endpoints: EndpointsConfig): EndpointsConfig {
	const normalized: EndpointsConfig = {};
	for (const [key, config] of Object.entries(endpoints)) {
		normalized[key] = {
			...config,
			url: normalizeEndpointUrl(config.url),
		};
	}
	return normalized;
}

export function activate(context: vscode.ExtensionContext) {
	// Create output channel for API logging
	const outputChannel = vscode.window.createOutputChannel('LLaMA Server API');
	context.subscriptions.push(outputChannel);
	
	// Initialize logger with output channel
	initializeLogger(outputChannel);

	// Helper function to register the provider
	const registerProvider = (endpoints: EndpointsConfig) => {
		// Dispose and remove existing provider if any
		if (provider) {
			provider.dispose();
			provider = undefined;
		}
		if (providerDisposable) {
			const index = context.subscriptions.indexOf(providerDisposable);
			if (index !== -1) {
				context.subscriptions.splice(index, 1);
			}
			providerDisposable.dispose();
			providerDisposable = undefined;
		}

		// Create and register new provider
		provider = new LlamaCopilotChatProvider(endpoints);
		providerDisposable = vscode.lm.registerLanguageModelChatProvider(
			'llama-server',
			provider
		);

		context.subscriptions.push(providerDisposable);
		
		// Return the provider so we can fire events on it
		return provider;
	};

	/** Register inline completion provider when a model is configured; unregister otherwise. */
	const updateInlineCompletionProvider = (endpoints: EndpointsConfig) => {
		if (inlineCompletionDisposable) {
			const index = context.subscriptions.indexOf(inlineCompletionDisposable);
			if (index !== -1) context.subscriptions.splice(index, 1);
			inlineCompletionDisposable.dispose();
			inlineCompletionDisposable = undefined;
		}
		const modelId = getInlineCompletionModel();
		if (modelId && Object.keys(endpoints).length > 0) {
			const selector = [{ language: '*' }];
			inlineCompletionDisposable = vscode.languages.registerInlineCompletionItemProvider(
				selector,
				new InlineCompletionProvider(endpoints)
			);
			context.subscriptions.push(inlineCompletionDisposable);
		}
	};

	// Register command to open endpoint settings
	const commandDisposable = vscode.commands.registerCommand('llamaCopilot.openEndpointSettings', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', endpointsSettingsKey());
	});
	context.subscriptions.push(commandDisposable);

	// Get endpoints from configuration and register initial provider
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const endpoints = config.get<EndpointsConfig>(CONFIG_ENDPOINTS, {});
	registerProvider(normalizeEndpoints(endpoints));
	updateInlineCompletionProvider(normalizeEndpoints(endpoints));

	// Listen for configuration changes
	const configDisposable = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
		if (e.affectsConfiguration(endpointsConfigKey())) {
			const newEndpoints = vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.get<EndpointsConfig>(CONFIG_ENDPOINTS, {});

			// Unregister old provider and register new one with updated endpoints
			const newProvider = registerProvider(normalizeEndpoints(newEndpoints));
			updateInlineCompletionProvider(normalizeEndpoints(newEndpoints));
			
			// Fire change event on the new provider asynchronously to ensure
			// the provider is fully registered before notifying VSCode
			if (newProvider) {
				// Use setTimeout to ensure the event fires after the current execution context
				setTimeout(() => {
					newProvider.fireChangeEvent();
				}, 0);
			}
		}
		if (e.affectsConfiguration(`${CONFIG_SECTION}.inlineCompletionModel`)) {
			const newEndpoints = vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.get<EndpointsConfig>(CONFIG_ENDPOINTS, {});
			updateInlineCompletionProvider(normalizeEndpoints(newEndpoints));
		}
	});

	context.subscriptions.push(configDisposable);
}

export function deactivate() {
	if (provider) {
		provider.dispose();
		provider = undefined;
	}
	if (providerDisposable) {
		providerDisposable.dispose();
		providerDisposable = undefined;
	}
	if (inlineCompletionDisposable) {
		inlineCompletionDisposable.dispose();
		inlineCompletionDisposable = undefined;
	}
}
