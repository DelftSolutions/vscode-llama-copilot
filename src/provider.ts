import * as vscode from 'vscode';
import { fetchModels, streamChatCompletion, tokenize } from './llamaClient';
import { EndpointsConfig, Model } from './types';
import { RuleManager } from './cursor-rules/ruleManager';
import { CursorRulesTool } from './cursor-rules/index';
import { findClosestMatch } from './cursor-rules/levenshtein';
import { logRulesMatching, logToolCall, logToolCallResult } from './logger';

export class llamaCopilotChatProvider implements vscode.LanguageModelChatProvider {
	private endpoints: EndpointsConfig;
	// Track thinking tokens per assistant message (keyed by message index or content hash)
	private thinkingTokens = new Map<string, string>();
	// Event emitter for model information changes
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeLanguageModelChatInformationEmitter.event;
	// Cursor rules manager
	private ruleManager: RuleManager | null = null;
	private rulesTool: CursorRulesTool | null = null;
	private rulesInitialized = false;
	private rulesLoadingPromise: Promise<void> | null = null;

	constructor(endpoints: EndpointsConfig) {
		this.endpoints = endpoints;
		this.rulesLoadingPromise = this.initializeRules();
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.dispose();
	}

	/**
	 * Initialize cursor rules manager if feature is enabled
	 */
	private async initializeRules(): Promise<void> {
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		const enabled = config.get<boolean>('enableCursorRules', true);
		
		if (!enabled) {
			return;
		}

		try {
			this.ruleManager = new RuleManager();
			await this.ruleManager.initialize();
			this.rulesTool = new CursorRulesTool(this.ruleManager);
			this.rulesInitialized = true;
		} catch (error) {
			console.error('Failed to initialize cursor rules:', error);
		}
	}

	/**
	 * Check if cursor rules feature is enabled
	 */
	private isCursorRulesEnabled(): boolean {
		if (!this.rulesInitialized) {
			return false;
		}
		const config = vscode.workspace.getConfiguration('llamaCopilot');
		return config.get<boolean>('enableCursorRules', true);
	}

	/**
	 * Create cursor rules tool if rules are available for the session
	 */
	private async createCursorRulesTool(
		messages: vscode.LanguageModelChatMessage[],
		modelId: string
	): Promise<vscode.LanguageModelChatTool | null> {
		// Wait for initialization if still in progress
		if (this.rulesLoadingPromise) {
			try {
				await this.rulesLoadingPromise;
				this.rulesLoadingPromise = null;
			} catch (error) {
				console.error('Failed to wait for rules initialization:', error);
				this.rulesLoadingPromise = null;
			}
		}

		if (!this.isCursorRulesEnabled() || !this.ruleManager || !this.rulesTool) {
			logRulesMatching('Rules disabled or not initialized', { 
				enabled: this.isCursorRulesEnabled(), 
				initialized: !!this.ruleManager,
				ruleCount: this.ruleManager?.getRuleCount() ?? 0
			});
			return null;
		}

		// Match rules for this session
		logRulesMatching('Starting rules matching', { 
			messageCount: messages.length,
			modelId 
		});
		
		const matchedRules = this.ruleManager.matchRulesForSession(messages, modelId);
		const availableRules = this.ruleManager.getAvailableRules(messages, modelId);

		logRulesMatching('Rules matching completed', {
			matchedRuleCount: matchedRules.size,
			availableRuleCount: availableRules.length,
			availableRules: availableRules.map(r => r.path)
		});

		if (availableRules.length === 0) {
			logRulesMatching('No rules available for session');
			return null;
		}

		// Build tool description
		const ruleList = availableRules.map(rule => ({
			path: rule.path,
			description: rule.metadata.description || rule.path,
		}));
		const description = this.rulesTool.getDescription(ruleList);

		if (!description) {
			logRulesMatching('Tool description generation failed');
			return null;
		}

		logRulesMatching('Cursor rules tool created', {
			toolName: 'get-project-rule',
			ruleCount: availableRules.length
		});

		// Create LanguageModelChatTool
		return {
			name: 'get-project-rule',
			description: description,
			inputSchema: {
				type: 'object',
				properties: {
					rule: {
						type: 'string',
						description: 'Comma-separated list of rule names to fetch (e.g., "rule:style-guidelines.mdc,rule:extra/example.md"). The "rule:" prefix is optional.',
					},
				},
				required: ['rule'],
			},
		};
	}


	/**
	 * Fire the change event to notify VS Code that model information has changed
	 */
	fireChangeEvent(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	/**
	 * Parse model ID to extract endpoint identifier and base model ID
	 * Returns { baseModelId, endpointId } where endpointId is null if no @identifier found
	 */
	private parseModelId(modelId: string): { baseModelId: string; endpointId: string | null } {
		const atIndex = modelId.lastIndexOf('@');
		if (atIndex === -1 || atIndex === 0 || atIndex === modelId.length - 1) {
			// No @ found, or @ at start/end (invalid)
			return { baseModelId: modelId, endpointId: null };
		}
		const baseModelId = modelId.substring(0, atIndex);
		const endpointId = modelId.substring(atIndex + 1);
		return { baseModelId, endpointId };
	}

	/**
	 * Get endpoint configuration by identifier
	 */
	private getEndpointConfig(endpointId: string) {
		const config = this.endpoints[endpointId];
		if (!config) {
			throw new Error(
				`Endpoint "${endpointId}" not found in configuration. Available endpoints: ${Object.keys(this.endpoints).join(', ') || 'none'}`
			);
		}
		return config;
	}

	/**
	 * Get model-specific configuration and merge with endpoint config
	 * Returns merged headers and requestBody (model config overrides endpoint config)
	 */
	private getMergedModelConfig(endpointId: string, baseModelId: string): {
		headers: Record<string, string>;
		requestBody: Record<string, unknown>;
	} {
		const endpointConfig = this.getEndpointConfig(endpointId);
		const modelConfig = endpointConfig.models?.[baseModelId];

		// Merge headers: endpoint first, then model (model overrides)
		const headers: Record<string, string> = {};
		if (endpointConfig.headers) {
			Object.assign(headers, endpointConfig.headers);
		}
		if (modelConfig?.headers) {
			Object.assign(headers, modelConfig.headers);
		}

		// Merge requestBody: endpoint first, then model (model overrides)
		const requestBody: Record<string, unknown> = {};
		if (endpointConfig.requestBody) {
			Object.assign(requestBody, endpointConfig.requestBody);
		}
		if (modelConfig?.requestBody) {
			Object.assign(requestBody, modelConfig.requestBody);
		}

		return { headers, requestBody };
	}


	/**
	 * Check if model has embeddings flag
	 */
	private hasEmbeddings(model: Model): boolean {
		return model.status.args?.includes('--embeddings') ?? false;
	}

	/**
	 * Extract context size from model args array
	 * Looks for "--ctx-size" followed by the value
	 * Returns the context size as a number, or null if not found
	 */
	private extractContextSize(model: Model): number | null {
		const args = model.status.args;
		if (!args) {
			return null;
		}

		const ctxSizeIndex = args.indexOf('--ctx-size');
		if (ctxSizeIndex === -1 || ctxSizeIndex === args.length - 1) {
			return null;
		}

		const ctxSizeValue = args[ctxSizeIndex + 1];
		const ctxSize = parseInt(ctxSizeValue, 10);
		
		// Return null if parsing failed or value is 0 (which means "fit" mode)
		if (isNaN(ctxSize) || ctxSize === 0) {
			return null;
		}

		return ctxSize;
	}

	/**
	 * Calculate max output tokens based on context size
	 * Returns 25% of context size, clamped between 8192 and 128000
	 */
	private calculateMaxOutputTokens(contextSize: number): number {
		const maxOutput = Math.floor(contextSize * 0.25);
		return Math.max(8192, Math.min(128000, maxOutput));
	}

	/**
	 * Check if model is suitable for chat
	 */
	private isChatCapable(model: Model): boolean {
		const embeddings = this.hasEmbeddings(model);
		// If it has embeddings, it's embeddings-only
		if (embeddings) {
			return false;
		}

		return true;
	}

	/**
	 * Get default capabilities
	 */
	private getDefaultCapabilities(): vscode.LanguageModelChatCapabilities {
		return {
			toolCalling: true, // Enable tool support
			imageInput: false, // Can be enabled if model supports multimodal
		};
	}

	/**
	 * Merge model-specific capabilities with defaults
	 */
	private getMergedCapabilities(modelConfig?: { capabilities?: vscode.LanguageModelChatCapabilities }): vscode.LanguageModelChatCapabilities {
		const defaults = this.getDefaultCapabilities();
		if (!modelConfig?.capabilities) {
			return defaults;
		}
		return {
			...defaults,
			...modelConfig.capabilities,
		};
	}

	/**
	 * Create model information from configuration only (when model is not in server list)
	 */
	private createModelInfoFromConfig(
		endpointId: string,
		modelId: string,
		modelConfig?: { contextSize?: number; maxOutputTokens?: number; capabilities?: vscode.LanguageModelChatCapabilities }
	): vscode.LanguageModelChatInformation {
		const modelIdWithEndpoint = `${modelId}@${endpointId}`;
		
		// Determine context size: model config > default
		const effectiveContextSize = modelConfig?.contextSize ?? 128000;
		const maxInputTokens = effectiveContextSize;
		
		// Determine max output tokens: model config > calculated from context size
		const maxOutputTokens = modelConfig?.maxOutputTokens ?? this.calculateMaxOutputTokens(effectiveContextSize);
		
		// Get merged capabilities (model config overrides defaults)
		const capabilities = this.getMergedCapabilities(modelConfig);
		
		return {
			id: modelIdWithEndpoint,
			name: modelIdWithEndpoint,
			tooltip: `Model from llama-server endpoint "${endpointId}" (configured)`,
			family: 'llama-server',
			maxInputTokens,
			maxOutputTokens,
			version: '1.0.0',
			capabilities,
		};
	}

	/**
	 * Provide information about available chat models
	 */
	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		const allModels: vscode.LanguageModelChatInformation[] = [];

		// Fetch models from all configured endpoints
		for (const [endpointId, endpointConfig] of Object.entries(this.endpoints)) {
			const foundModelIds = new Set<string>();
			
			try {
				const response = await fetchModels(endpointConfig.url, endpointConfig.apiToken, endpointConfig.headers);

				// Filter models:
				// 1. Exclude models with "/" in ID
				// 2. Only include chat-capable models
				const chatModels = response.data.filter(
					(model) => !model.id.includes('/') && this.isChatCapable(model)
				);

				// Append @endpointId to each model ID and name
				const modelsWithEndpoint = chatModels.map((model) => {
					foundModelIds.add(model.id);
					const modelIdWithEndpoint = `${model.id}@${endpointId}`;
					
					// Get model-specific config if available
					const modelConfig = endpointConfig.models?.[model.id];
					
					// Determine context size: model config > extracted from args > default
					const extractedContextSize = this.extractContextSize(model);
					const effectiveContextSize = modelConfig?.contextSize ?? extractedContextSize ?? 128000;
					const maxInputTokens = effectiveContextSize;
					
					// Determine max output tokens: model config > calculated from context size
					const maxOutputTokens = modelConfig?.maxOutputTokens ?? this.calculateMaxOutputTokens(effectiveContextSize);
					
					// Get merged capabilities (model config overrides defaults)
					const capabilities = this.getMergedCapabilities(modelConfig);
					
					const info: vscode.LanguageModelChatInformation = {
						id: modelIdWithEndpoint,
						name: modelIdWithEndpoint,
						tooltip: `Model from llama-server endpoint "${endpointId}" (${model.status.value})`,
						family: 'llama-server',
						maxInputTokens,
						maxOutputTokens,
						version: '1.0.0',
						capabilities,
					};
					return info;
				});

				allModels.push(...modelsWithEndpoint);
			} catch (error) {
				console.error(`Failed to fetch models from endpoint "${endpointId}":`, error);
				// Continue to add configured models even if fetch fails
			}

			// Add any configured models that weren't found in the server response
			if (endpointConfig.models) {
				for (const [modelId, modelConfig] of Object.entries(endpointConfig.models)) {
					// Skip models with "/" in ID (same filter as server models)
					if (modelId.includes('/')) {
						continue;
					}
					
					// Only add if not already found from server
					if (!foundModelIds.has(modelId)) {
						const modelInfo = this.createModelInfoFromConfig(endpointId, modelId, modelConfig);
						allModels.push(modelInfo);
					}
				}
			}
		}

		return allModels;
	}

	/**
	 * Check if a message contains tool calls
	 */
	private hasToolCalls(msg: vscode.LanguageModelChatMessage): boolean {
		return msg.content.some((part) => part instanceof vscode.LanguageModelToolCallPart);
	}

	/**
	 * Check if a message contains tool results
	 */
	private hasToolResults(msg: vscode.LanguageModelChatMessage): boolean {
		return msg.content.some((part) => part instanceof vscode.LanguageModelToolResultPart);
	}

	/**
	 * Check if the last message is a new user message (not a tool result)
	 * If so, we should NOT include thinking tokens from previous messages
	 */
	private isNewUserMessage(messages: vscode.LanguageModelChatMessage[]): boolean {
		if (messages.length === 0) {
			return false;
		}

		const lastMsg = messages[messages.length - 1];
		return (
			lastMsg.role === vscode.LanguageModelChatMessageRole.User &&
			!this.hasToolResults(lastMsg)
		);
	}

	/**
	 * Get thinking tokens for a specific assistant message with tool calls
	 * Returns the thinking tokens if available, undefined otherwise
	 * This is called when converting messages to OpenAI format
	 */
	private getThinkingTokensForMessage(msg: vscode.LanguageModelChatMessage): string | undefined {
		if (!this.hasToolCalls(msg)) {
			return undefined;
		}

		// Try to find thinking tokens by matching tool call IDs
		// We look for any tool call in the message and return the first matching thinking tokens
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				const key = `toolCall_${part.callId}`;
				const thinking = this.thinkingTokens.get(key);
				if (thinking) {
					return thinking;
				}
			}
		}

		return undefined;
	}

	/**
	 * Check if we should include thinking tokens in the request
	 * Include them when:
	 * - The last assistant message has tool calls
	 * - The current request is following up with tool results (not a new user message)
	 */
	private shouldIncludeThinkingTokens(messages: vscode.LanguageModelChatMessage[]): boolean {
		if (messages.length === 0) {
			return false;
		}

		// If it's a new user message, don't include thinking tokens
		if (this.isNewUserMessage(messages)) {
			return false;
		}

		// Find the last assistant message with tool calls
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && this.hasToolCalls(msg)) {
				// Check if we have thinking tokens for this message
				return this.getThinkingTokensForMessage(msg) !== undefined;
			}
		}

		return false;
	}

	/**
	 * Build assistant message text asking about rules
	 */
	private buildAssistantMessageForRules(ruleNames: string[]): string {
		if (ruleNames.length === 0) {
			return 'Please tell me about the project rules.';
		}
		
		const uniqueRuleNames = [...new Set(ruleNames)];
		if (uniqueRuleNames.length === 1) {
			return `Please tell me about rule ${uniqueRuleNames[0]}.`;
		}
		
		const lastRule = uniqueRuleNames[uniqueRuleNames.length - 1];
		const otherRules = uniqueRuleNames.slice(0, -1);
		return `Please tell me about rules ${otherRules.join(', ')}, and ${lastRule}.`;
	}

	/**
	 * Build user message with tool results
	 */
	private buildUserMessageWithResults(results: string[]): string {
		return results.join('\n\n');
	}

	/**
	 * Build updated message history with assistant and user messages
	 */
	private buildUpdatedMessageHistory(
		originalMessages: vscode.LanguageModelChatMessage[],
		assistantText: string,
		userText: string
	): vscode.LanguageModelChatMessage[] {
		const updatedMessages = [...originalMessages];
		
		// Add assistant message asking about rules
		updatedMessages.push(
			new vscode.LanguageModelChatMessage(
				vscode.LanguageModelChatMessageRole.Assistant,
				[new vscode.LanguageModelTextPart(assistantText)]
			)
		);
		
		// Add user message with tool results
		updatedMessages.push(
			new vscode.LanguageModelChatMessage(
				vscode.LanguageModelChatMessageRole.User,
				[new vscode.LanguageModelTextPart(userText)]
			)
		);
		
		return updatedMessages;
	}

	/**
	 * Make follow-up streaming request after reporting text messages
	 */
	private async makeFollowUpRequest(
		serverUrl: string,
		modelId: string,
		messages: vscode.LanguageModelChatMessage[],
		maxTokens: number,
		apiToken: string | undefined,
		headers: Record<string, string>,
		requestBody: Record<string, unknown>,
		tools: readonly vscode.LanguageModelChatTool[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const completionOptions = {
			tools: tools,
			max_tokens: maxTokens,
			getThinkingTokens: undefined,
			isNewUserMessage: false,
		};

		// Stream follow-up response
		for await (const chunk of streamChatCompletion(
			serverUrl,
			modelId,
			messages,
			completionOptions,
			apiToken,
			headers,
			requestBody
		)) {
			// Check for cancellation
			if (token.isCancellationRequested) {
				return;
			}

			// Handle different chunk types
			if (chunk.type === 'text') {
				progress.report(new vscode.LanguageModelTextPart(chunk.content));
			} else if (chunk.type === 'toolCall') {
				// Report tool calls normally (these should be other tools, not get-project-rule)
				progress.report(chunk.toolCall);
			} else if (chunk.type === 'thinking') {
				progress.report(new vscode.LanguageModelThinkingPart(chunk.content));
			}
		}
	}


	/**
	 * Provide chat response using OpenAI-compatible /v1/chat/completions endpoint
	 */
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: vscode.LanguageModelChatMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		try {
			// Parse model ID to extract endpoint identifier
			const { baseModelId, endpointId } = this.parseModelId(model.id);
			if (!endpointId) {
				throw new Error(
					`Model ID "${model.id}" must include an endpoint identifier (e.g., "model-name@local")`
				);
			}

			// Get endpoint configuration
			const endpointConfig = this.getEndpointConfig(endpointId);
			
			// Get merged headers and requestBody (model config overrides endpoint config)
			const { headers: mergedHeaders, requestBody: mergedRequestBody } = this.getMergedModelConfig(endpointId, baseModelId);

			// Determine if we should include thinking tokens
			// Include them when following up on tool calls with tool results
			const includeThinkingTokens = this.shouldIncludeThinkingTokens(messages);
			const isNewUserMsg = this.isNewUserMessage(messages);

			// Clear thinking tokens when user sends a new message (not tool results)
			// This prevents memory leaks and ensures thinking tokens are removed as specified
			if (isNewUserMsg) {
				this.thinkingTokens.clear();
			}

			const maxTokens = model.maxOutputTokens;
			
			// Add cursor rules tool if available
			const cursorRulesTool = await this.createCursorRulesTool(messages, model.id);
			const tools: readonly vscode.LanguageModelChatTool[] = cursorRulesTool
				? [...(options.tools || []), cursorRulesTool]
				: options.tools || [];

			const completionOptions = {
				tools: tools,
				max_tokens: maxTokens,
				getThinkingTokens: includeThinkingTokens
					? (msg: vscode.LanguageModelChatMessage) => this.getThinkingTokensForMessage(msg)
					: undefined,
				isNewUserMessage: isNewUserMsg,
			};

			// Track thinking tokens for the current response
			let currentThinkingTokens = '';
			
			// Track cursor rules tool calls to convert to text messages
			const cursorRulesToolCalls: Array<{
				toolCall: vscode.LanguageModelToolCallPart;
				result: string;
				ruleNames: string[];
			}> = [];

			// Stream chat completion
			for await (const chunk of streamChatCompletion(
				endpointConfig.url,
				baseModelId,
				messages,
				completionOptions,
				endpointConfig.apiToken,
				mergedHeaders,
				mergedRequestBody
			)) {
				// Check for cancellation
				if (token.isCancellationRequested) {
					return;
				}

				// Handle different chunk types
				if (chunk.type === 'text') {
					progress.report(new vscode.LanguageModelTextPart(chunk.content));
				} else if (chunk.type === 'toolCall') {
					logToolCall(chunk.toolCall.name, chunk.toolCall.callId, chunk.toolCall.input);
					
					// Check if this is our cursor rules tool and handle it specially
					if (chunk.toolCall.name === 'get-project-rule' && this.rulesTool && this.ruleManager) {
						// Collect tool call and invoke handler, but don't report it as a tool call
						try {
							const ruleNames = (chunk.toolCall.input as { rule: string }).rule.split(',').map(r => r.trim());
							const results: Array<{ description: string; content: string }> = [];
							
							for (const ruleName of ruleNames) {
								// Remove "rule:" prefix if present
								const normalizedName = ruleName.replace(/^rule:/, '');
								
								// Try to find the rule
								let rule = this.ruleManager.findRule(normalizedName);
								
								// If not found, try fuzzy matching
								if (!rule) {
									const allRules = this.ruleManager.getAllRules();
									const candidateNames = allRules.map(r => r.path);
									const closest = findClosestMatch(normalizedName, candidateNames, 8);
									
									if (closest) {
										rule = this.ruleManager.findRule(closest);
									}
								}
								
								if (rule) {
									const description = rule.metadata.description || rule.path;
									results.push({
										description,
										content: rule.content,
									});
								} else {
									// Rule not found
									results.push({
										description: normalizedName,
										content: '<empty file>',
									});
								}
							}
							
							// Format result
							const formattedResults = results
								.map(r => `# ${r.description}\n\n\`\`\`\`\n${r.content}\n\`\`\`\``)
								.join('\n\n');
							
							logToolCallResult(chunk.toolCall.name, chunk.toolCall.callId, {
								ruleCount: results.length,
								rulesFound: results.map(r => r.description)
							});
							
							// Store for later conversion to text messages
							cursorRulesToolCalls.push({
								toolCall: chunk.toolCall,
								result: formattedResults,
								ruleNames: ruleNames.map(r => r.replace(/^rule:/, ''))
							});
						} catch (error) {
							console.error('Failed to invoke cursor rules tool:', error);
							logToolCallResult(chunk.toolCall.name, chunk.toolCall.callId, {
								error: error instanceof Error ? error.message : 'Unknown error'
							});
							// Store error result
							cursorRulesToolCalls.push({
								toolCall: chunk.toolCall,
								result: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
								ruleNames: []
							});
						}
					} else {
						// Report other tool calls normally (let VS Code handle them)
						progress.report(chunk.toolCall);
						logToolCallResult(chunk.toolCall.name, chunk.toolCall.callId, {
							note: 'Tool call handled by VS Code'
						});
					}
					
					// Store thinking tokens with the tool call message
					// We'll include them when the tool results come back
					if (currentThinkingTokens) {
						const messageKey = `toolCall_${chunk.toolCall.callId}`;
						this.thinkingTokens.set(messageKey, currentThinkingTokens);
						currentThinkingTokens = '';
					}
				} else if (chunk.type === 'thinking') {
					// Report thinking tokens to VSCode
					progress.report(new vscode.LanguageModelThinkingPart(chunk.content));
					// Accumulate thinking tokens for tool call association
					currentThinkingTokens += chunk.content;
				}
			}
			
			// After initial stream completes, if we have cursor rules tool calls, convert them to text messages
			if (cursorRulesToolCalls.length > 0) {
				// Build assistant and user messages
				const assistantText = this.buildAssistantMessageForRules(
					cursorRulesToolCalls.flatMap(tc => tc.ruleNames)
				);
				const userText = this.buildUserMessageWithResults(
					cursorRulesToolCalls.map(tc => tc.result)
				);
				
				// Report assistant text
				progress.report(new vscode.LanguageModelTextPart(assistantText));
				
				// Report user text
				progress.report(new vscode.LanguageModelTextPart(userText));
				
				// Build updated message history and make follow-up request
				const updatedMessages = this.buildUpdatedMessageHistory(messages, assistantText, userText);
				
				// Make follow-up request (without cursor rules tool to prevent loops)
				await this.makeFollowUpRequest(
					endpointConfig.url,
					baseModelId,
					updatedMessages,
					model.maxOutputTokens,
					endpointConfig.apiToken,
					mergedHeaders,
					mergedRequestBody,
					options.tools?.filter(t => t.name !== 'get-project-rule') || [],
					progress,
					token
				);
			}

			// If we have remaining thinking tokens after streaming completes,
			// store them for potential use with tool calls
			if (currentThinkingTokens) {
				// Store with a timestamp-based key as fallback
				const fallbackKey = `response_${Date.now()}`;
				this.thinkingTokens.set(fallbackKey, currentThinkingTokens);
			}
		} catch (error) {
			console.error('Failed to provide chat response:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			progress.report(
				new vscode.LanguageModelTextPart(
					`Error: ${errorMessage}. Please check your endpoint configuration and that llama-server is running.`
				)
			);
			throw error;
		}
	}

	/**
	 * Provide token count using /tokenize endpoint
	 */
	async provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		try {
			// Parse model ID to extract endpoint identifier
			const { baseModelId, endpointId } = this.parseModelId(model.id);
			if (!endpointId) {
				throw new Error(
					`Model ID "${model.id}" must include an endpoint identifier (e.g., "model-name@local")`
				);
			}

			// Get endpoint configuration
			const endpointConfig = this.getEndpointConfig(endpointId);
			
			// Get merged headers and requestBody (model config overrides endpoint config)
			const { headers: mergedHeaders, requestBody: mergedRequestBody } = this.getMergedModelConfig(endpointId, baseModelId);

			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				// Extract text from message (content is always an array)
				content = text.content
					.filter((part) => part instanceof vscode.LanguageModelTextPart)
					.map((part) => (part as vscode.LanguageModelTextPart).value)
					.join('');
			}

			return await tokenize(
				endpointConfig.url,
				baseModelId,
				content,
				endpointConfig.apiToken,
				mergedHeaders,
				mergedRequestBody
			);
		} catch (error) {
			console.error('Failed to count tokens:', error);
			// Return 0 on error as fallback
			return 0;
		}
	}
}
