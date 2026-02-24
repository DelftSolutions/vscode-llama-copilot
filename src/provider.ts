import * as vscode from 'vscode';
import { streamChatCompletion, tokenize } from './llamaClient';
import { EndpointsConfig } from './types';
import { RuleManager } from './cursor-rules/ruleManager';
import { CursorRulesTool, CURSOR_RULES_TOOL_NAME, resolveAndFormatRules } from './cursor-rules/index';
import { logRulesMatching, logToolCall, logToolCallResult } from './logger';
import { getRequestTimeoutMs, isCursorRulesEnabled as isCursorRulesEnabledConfig } from './config';
import {
	parseModelId,
	getEndpointConfig,
	getMergedModelConfig,
	provideLanguageModelChatInformation as provideModelInfo,
} from './modelInfo';
import { ThinkingTokensTracker, isNewUserMessage as isNewUserMessageCheck } from './thinkingTokens';

export class LlamaCopilotChatProvider implements vscode.LanguageModelChatProvider {
	private endpoints: EndpointsConfig;
	private thinkingTokens = new ThinkingTokensTracker();
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
		if (!isCursorRulesEnabledConfig()) {
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
		return isCursorRulesEnabledConfig();
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
			toolName: CURSOR_RULES_TOOL_NAME,
			ruleCount: availableRules.length
		});

		// Create LanguageModelChatTool
		return {
			name: CURSOR_RULES_TOOL_NAME,
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
	 * Provide information about available chat models
	 */
	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		return provideModelInfo(this.endpoints, getRequestTimeoutMs());
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
		token: vscode.CancellationToken,
		requestTimeoutMs: number
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
			requestBody,
			requestTimeoutMs
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
			}
			// Note: 'thinking' chunks are not reported; LanguageModelThinkingPart is not in the current vscode API types.
			else if (chunk.type === 'thinking') {
				// Ignore (no progress.report)
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
			const { baseModelId, endpointId } = parseModelId(model.id);
			if (!endpointId) {
				throw new Error(
					`Model ID "${model.id}" must include an endpoint identifier (e.g., "model-name@local")`
				);
			}

			// Get endpoint configuration
			const endpointConfig = getEndpointConfig(this.endpoints, endpointId);
			
			// Get merged headers and requestBody (model config overrides endpoint config)
			const { headers: mergedHeaders, requestBody: mergedRequestBody } = getMergedModelConfig(this.endpoints, endpointId, baseModelId);

			// Determine if we should include thinking tokens
			// Include them when following up on tool calls with tool results
			const includeThinkingTokens = this.thinkingTokens.shouldInclude(messages);
			const isNewUserMsg = isNewUserMessageCheck(messages);

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
					? (msg: vscode.LanguageModelChatMessage) => this.thinkingTokens.getForMessage(msg)
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

			const requestTimeoutMs = getRequestTimeoutMs();

			// Stream chat completion
			for await (const chunk of streamChatCompletion(
				endpointConfig.url,
				baseModelId,
				messages,
				completionOptions,
				endpointConfig.apiToken,
				mergedHeaders,
				mergedRequestBody,
				requestTimeoutMs
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
					if (chunk.toolCall.name === CURSOR_RULES_TOOL_NAME && this.rulesTool && this.ruleManager) {
						try {
							const inputRule = (chunk.toolCall.input as { rule: string }).rule;
							const { formatted, ruleNames } = resolveAndFormatRules(this.ruleManager, inputRule);
							logToolCallResult(chunk.toolCall.name, chunk.toolCall.callId, {
								ruleCount: ruleNames.length,
								rulesFound: ruleNames
							});
							cursorRulesToolCalls.push({
								toolCall: chunk.toolCall,
								result: formatted,
								ruleNames,
							});
						} catch (error) {
							console.error('Failed to invoke cursor rules tool:', error);
							logToolCallResult(chunk.toolCall.name, chunk.toolCall.callId, {
								error: error instanceof Error ? error.message : 'Unknown error'
							});
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
					// Accumulate thinking tokens for tool call association.
					// LanguageModelThinkingPart is not in the current vscode API types, so we don't report to progress.
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
					options.tools?.filter(t => t.name !== CURSOR_RULES_TOOL_NAME) || [],
					progress,
					token,
					requestTimeoutMs
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
			const displayMessage = errorMessage.includes('Settings → Llama Copilot')
				? errorMessage
				: `${errorMessage} Check Settings → Llama Copilot if the problem continues.`;
			progress.report(new vscode.LanguageModelTextPart(displayMessage));
			// Throw a fresh error with only our message so the host "Reason" text shows this, not the original fetch error
			throw new Error(displayMessage);
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
			const { baseModelId, endpointId } = parseModelId(model.id);
			if (!endpointId) {
				throw new Error(
					`Model ID "${model.id}" must include an endpoint identifier (e.g., "model-name@local")`
				);
			}

			// Get endpoint configuration
			const endpointConfig = getEndpointConfig(this.endpoints, endpointId);
			
			// Get merged headers and requestBody (model config overrides endpoint config)
			const { headers: mergedHeaders, requestBody: mergedRequestBody } = getMergedModelConfig(this.endpoints, endpointId, baseModelId);

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

			const requestTimeoutMs = getRequestTimeoutMs();
			return await tokenize(
				endpointConfig.url,
				baseModelId,
				content,
				endpointConfig.apiToken,
				mergedHeaders,
				mergedRequestBody,
				requestTimeoutMs
			);
		} catch (error) {
			console.error('Failed to count tokens:', error);
			// Return 0 on error as fallback
			return 0;
		}
	}
}
