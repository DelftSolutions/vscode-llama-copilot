import * as vscode from 'vscode';
import { streamChatCompletion, getTokenCount, prepareCompletionRequest, normalizeStreamUsage } from './llamaClient';
import { EndpointsConfig, OpenAIUsage } from './types';
import { RuleManager } from './cursor-rules/ruleManager';
import { CursorRulesTool, CURSOR_RULES_TOOL_NAME, resolveAndFormatRules } from './cursor-rules/index';
import { logRulesMatching, logToolCall, logToolCallResult } from './logger';
import {
	getRequestTimeoutMs,
	getPromptProgressStatusBarThresholdSeconds,
	getMinPromptProgressElapsedMs,
	isCursorRulesEnabled as isCursorRulesEnabledConfig,
	isShowAllModels,
} from './config';
import { estimatePromptProgress, formatRemaining } from './promptProgressEstimate';
import {
	parseModelId,
	getEndpointConfig,
	getMergedModelConfig,
	getThinkingBudgetFraction,
	provideLanguageModelChatInformation as provideModelInfo,
} from './modelInfo';
import { isNewUserMessage as isNewUserMessageCheck } from './thinkingParts';
import { queueToolResultEmailsForMessages } from './toolResultEmail';

const USAGE_MIME_TYPE = 'usage';

function extractTextFromRequestMessage(msg: vscode.LanguageModelChatRequestMessage): string {
	return msg.content
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map((part) => part.value)
		.join('');
}

export class LlamaCopilotChatProvider implements vscode.LanguageModelChatProvider {
	private endpoints: EndpointsConfig;
	private readonly smtpGlobalState: vscode.Memento | undefined;
	// Event emitter for model information changes
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeLanguageModelChatInformationEmitter.event;
	// Cursor rules manager
	private ruleManager: RuleManager | null = null;
	private rulesTool: CursorRulesTool | null = null;
	private rulesInitialized = false;
	private rulesLoadingPromise: Promise<void> | null = null;

	constructor(endpoints: EndpointsConfig, smtpGlobalState?: vscode.Memento) {
		this.endpoints = endpoints;
		this.smtpGlobalState = smtpGlobalState;
		this.rulesLoadingPromise = this.initializeRules();
	}

	/**
	 * Emit a thinking part to the chat via the proposed LanguageModelThinkingPart API.
	 * VS Code stores these in chat history for round-trip via extractReasoningFromAssistantMessage.
	 */
	private reportThinkingPart(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		content: string,
		metadata?: Record<string, unknown>
	): void {
		const ThinkingPart = (vscode as { LanguageModelThinkingPart?: new (value: string, id?: string, metadata?: Record<string, unknown>) => vscode.LanguageModelResponsePart }).LanguageModelThinkingPart;
		if (typeof ThinkingPart === 'function') {
			progress.report(new ThinkingPart(content, undefined, metadata));
		}
	}

	/**
	 * Emit a reasoning_done marker so the host knows the thinking block is complete.
	 * Matches Copilot's languageModelAccess.ts behavior.
	 */
	private reportReasoningDone(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): void {
		this.reportThinkingPart(progress, '', { vscode_reasoning_done: true });
	}

	/**
	 * Emit a usage data part so Copilot's context window widget can display token counts.
	 */
	private reportUsage(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		usage: OpenAIUsage
	): void {
		const DataPart = vscode.LanguageModelDataPart;
		if (typeof DataPart === 'function') {
			progress.report(new DataPart(
				new TextEncoder().encode(JSON.stringify(usage)),
				USAGE_MIME_TYPE
			));
		}
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
		messages: readonly vscode.LanguageModelChatRequestMessage[],
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
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		return provideModelInfo(this.endpoints, getRequestTimeoutMs(), isShowAllModels());
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
		originalMessages: readonly vscode.LanguageModelChatRequestMessage[],
		assistantText: string,
		userText: string
	): vscode.LanguageModelChatRequestMessage[] {
		const updatedMessages: vscode.LanguageModelChatRequestMessage[] = [...originalMessages];
		
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
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		modelLimits: { maxInputTokens: number; maxOutputTokens: number },
		apiToken: string | undefined,
		headers: Record<string, string>,
		requestBody: Record<string, unknown>,
		tools: readonly vscode.LanguageModelChatTool[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
		requestTimeoutMs: number,
		statusBarRef: { disposable: vscode.Disposable | undefined },
		clearStatusBar: () => void,
		thinkingBudgetFraction?: number
	): Promise<void> {
		const abortController = new AbortController();
		token.onCancellationRequested(() => abortController.abort());

		const preparedRequest = await prepareCompletionRequest(
			serverUrl,
			modelId,
			messages,
			{ isNewUserMessage: false },
			modelLimits,
			apiToken,
			headers,
			requestBody,
			requestTimeoutMs,
			abortController.signal
		);

		const completionOptions = {
			tools: tools,
			max_tokens: modelLimits.maxOutputTokens,
			isNewUserMessage: false,
			preparedRequest,
			thinkingBudgetFraction,
		};

		// Stream follow-up response
		try {
			let promptProgressShown = false;
			let lastUsage: OpenAIUsage | undefined;
			for await (const chunk of streamChatCompletion(
				serverUrl,
				modelId,
				messages,
				completionOptions,
				apiToken,
				headers,
				requestBody,
				requestTimeoutMs,
				abortController.signal
			)) {
				// Check for cancellation
				if (token.isCancellationRequested) {
					clearStatusBar();
					return;
				}

				// Handle different chunk types
				if (chunk.type === 'prompt_progress') {
					const threshold = getPromptProgressStatusBarThresholdSeconds();
					const minElapsed = getMinPromptProgressElapsedMs();
					const result = estimatePromptProgress(
						{ total: chunk.total, processed: chunk.processed, time_ms: chunk.time_ms },
						threshold,
						minElapsed
					);
					const shouldShowOrUpdate = result.showStatusBar || promptProgressShown;
					const msg =
						result.percent !== undefined && result.remainingMs !== undefined
							? `Processing prompt... ${result.percent}% (about ${formatRemaining(result.remainingMs)} remaining)`
							: result.percent !== undefined
								? `Processing prompt... ${result.percent}%`
								: result.remainingMs !== undefined
									? `Processing prompt... (about ${formatRemaining(result.remainingMs)} remaining)`
									: '';
					if (shouldShowOrUpdate && msg) {
						clearStatusBar();
						statusBarRef.disposable = vscode.window.setStatusBarMessage(msg);
						if (result.showStatusBar) {
							promptProgressShown = true;
						}
					}
				} else if (chunk.type === 'usage') {
					lastUsage = chunk.usage;
				} else {
					clearStatusBar();
					promptProgressShown = false;
					if (chunk.type === 'text') {
						progress.report(new vscode.LanguageModelTextPart(chunk.content));
					} else if (chunk.type === 'toolCall') {
						progress.report(chunk.toolCall);
					} else if (chunk.type === 'thinking') {
						this.reportThinkingPart(progress, chunk.content);
					}
				}
			}
			clearStatusBar();

			const usage = normalizeStreamUsage(lastUsage, undefined, preparedRequest.requestTokenCount);
			if (usage) {
				this.reportUsage(progress, usage);
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				clearStatusBar();
				return;
			}
			throw error;
		}
	}


	/**
	 * Provide chat response using OpenAI-compatible /v1/chat/completions endpoint
	 */
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const statusBarRef = { disposable: undefined as vscode.Disposable | undefined };
		const clearStatusBar = () => {
			statusBarRef.disposable?.dispose();
			statusBarRef.disposable = undefined;
		};
		try {
			queueToolResultEmailsForMessages(messages, this.smtpGlobalState);

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

			const isNewUserMsg = isNewUserMessageCheck(messages);

			const maxTokens = model.maxOutputTokens;
			const thinkingBudgetFraction = getThinkingBudgetFraction(this.endpoints, endpointId, baseModelId);

			// Add cursor rules tool if available
			const cursorRulesTool = await this.createCursorRulesTool(messages, model.id);
			const tools: readonly vscode.LanguageModelChatTool[] = cursorRulesTool
				? [...(options.tools || []), cursorRulesTool]
				: options.tools || [];

			const requestTimeoutMs = getRequestTimeoutMs();

			const abortController = new AbortController();
			token.onCancellationRequested(() => abortController.abort());

			const preparedRequest = await prepareCompletionRequest(
				endpointConfig.url,
				baseModelId,
				messages,
				{ isNewUserMessage: isNewUserMsg },
				{ maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens },
				endpointConfig.apiToken,
				mergedHeaders,
				mergedRequestBody,
				requestTimeoutMs,
				abortController.signal
			);

			const completionOptions = {
				tools: tools,
				max_tokens: maxTokens,
				toolMode: options.toolMode,
				modelOptions: options.modelOptions,
				isNewUserMessage: isNewUserMsg,
				preparedRequest,
				thinkingBudgetFraction,
			};

			// Stream-level thinking state for reasoning_done marker
			let thinkingActive = false;
			
			// Track cursor rules tool calls to convert to text messages
			const cursorRulesToolCalls: Array<{
				toolCall: vscode.LanguageModelToolCallPart;
				result: string;
				ruleNames: string[];
			}> = [];

			// Stream chat completion
			let promptProgressShown = false;
			let lastUsage: OpenAIUsage | undefined;
			for await (const chunk of streamChatCompletion(
				endpointConfig.url,
				baseModelId,
				messages,
				completionOptions,
				endpointConfig.apiToken,
				mergedHeaders,
				mergedRequestBody,
				requestTimeoutMs,
				abortController.signal
			)) {
				// Check for cancellation
				if (token.isCancellationRequested) {
					clearStatusBar();
					return;
				}

				// Handle different chunk types
				if (chunk.type === 'prompt_progress') {
					const threshold = getPromptProgressStatusBarThresholdSeconds();
					const minElapsed = getMinPromptProgressElapsedMs();
					const result = estimatePromptProgress(
						{ total: chunk.total, processed: chunk.processed, time_ms: chunk.time_ms },
						threshold,
						minElapsed
					);
					const shouldShowOrUpdate = result.showStatusBar || promptProgressShown;
					const msg =
						result.percent !== undefined && result.remainingMs !== undefined
							? `Processing prompt... ${result.percent}% (about ${formatRemaining(result.remainingMs)} remaining)`
							: result.percent !== undefined
								? `Processing prompt... ${result.percent}%`
								: result.remainingMs !== undefined
									? `Processing prompt... (about ${formatRemaining(result.remainingMs)} remaining)`
									: '';
					if (shouldShowOrUpdate && msg) {
						clearStatusBar();
						statusBarRef.disposable = vscode.window.setStatusBarMessage(msg);
						if (result.showStatusBar) {
							promptProgressShown = true;
						}
					}
				} else if (chunk.type === 'usage') {
					lastUsage = chunk.usage;
				} else {
					clearStatusBar();
					promptProgressShown = false;
					if (chunk.type === 'text') {
						if (thinkingActive) {
							this.reportReasoningDone(progress);
							thinkingActive = false;
						}
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
					
					// Close thinking block before tool calls
					if (thinkingActive) {
						this.reportReasoningDone(progress);
						thinkingActive = false;
					}
				} else if (chunk.type === 'thinking') {
					this.reportThinkingPart(progress, chunk.content);
					thinkingActive = true;
				}
				}
			}
			
			// Close any open thinking block at stream end
			if (thinkingActive) {
				this.reportReasoningDone(progress);
				thinkingActive = false;
			}

			clearStatusBar();

			// Emit usage from stream (or fall back to prepared request token count)
			const usage = normalizeStreamUsage(lastUsage, undefined, preparedRequest.requestTokenCount);
			if (usage) {
				this.reportUsage(progress, usage);
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
					{ maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens },
					endpointConfig.apiToken,
					mergedHeaders,
					mergedRequestBody,
					options.tools?.filter(t => t.name !== CURSOR_RULES_TOOL_NAME) || [],
					progress,
					token,
					requestTimeoutMs,
					statusBarRef,
					clearStatusBar,
					thinkingBudgetFraction
				);
			}

		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				clearStatusBar();
				return;
			}
			console.error('Failed to provide chat response:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			const displayMessage = errorMessage.includes('Settings → Llama Copilot')
				? errorMessage
				: `${errorMessage} Check Settings → Llama Copilot if the problem continues.`;
			// Throw only; do not report as content — the host shows the error in the Reason UI.
			throw new Error(displayMessage);
		} finally {
			clearStatusBar();
		}
	}

	/**
	 * Provide token count using /tokenize endpoint
	 */
	async provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
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
				content = extractTextFromRequestMessage(text);
			}

			const requestTimeoutMs = getRequestTimeoutMs();
			return await getTokenCount(
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
			throw error;
		}
	}
}
