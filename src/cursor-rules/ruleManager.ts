import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ParsedRule } from './types';
import { loadRules } from './ruleParser';
import { extractFilePathFromAttachment, matchesAnyGlob } from './globMatcher';
import { logRulesMatching } from '../logger';
import { normalizeRuleName } from './utils';
import { findClosestMatch } from './levenshtein';

/** Max bytes of tool call params to match against rule globs (avoids scanning huge payloads) */
const TOOL_PARAMS_MATCH_MAX_BYTES = 1024;

/**
 * Manages rules per chat session
 * Tracks which rules are available based on glob matching
 */
export class RuleManager {
	private rules: ParsedRule[] = [];
	private sessionRules: Map<string, Set<string>> = new Map(); // sessionId -> Set of rule paths
	private rulesCache: Map<string, ParsedRule> = new Map(); // path -> rule
	
	/**
	 * Initialize and load rules from .cursor/rules/
	 */
	async initialize(): Promise<void> {
		logRulesMatching('Starting rule initialization');
		
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			logRulesMatching('No workspace folders found');
			return;
		}
		
		logRulesMatching('Loading rules from workspace folders', {
			workspaceFolderCount: workspaceFolders.length
		});
		
		// Load rules from all workspace folders
		const allRules: ParsedRule[] = [];
		for (const folder of workspaceFolders) {
			logRulesMatching('Loading rules from workspace folder', {
				folderName: folder.name,
				folderUri: folder.uri.fsPath
			});
			
			const folderRules = await loadRules(folder);
			allRules.push(...folderRules);
			
			logRulesMatching('Loaded rules from workspace folder', {
				folderName: folder.name,
				ruleCount: folderRules.length,
				rulePaths: folderRules.map(r => r.path)
			});
		}
		
		this.rules = allRules;
		
		logRulesMatching('Rule initialization completed', {
			totalRuleCount: this.rules.length,
			allRulePaths: this.rules.map(r => r.path)
		});
		
		// Build cache
		this.rulesCache.clear();
		for (const rule of this.rules) {
			this.rulesCache.set(rule.path, rule);
			// Also cache by name for easier lookup
			this.rulesCache.set(rule.name, rule);
		}
	}
	
	/**
	 * Get or create session ID from messages and model
	 */
	private getSessionId(messages: vscode.LanguageModelChatMessage[], modelId: string): string {
		// Find first user message
		const firstUserMessage = messages.find(msg => 
			msg.role === vscode.LanguageModelChatMessageRole.User
		);
		
		if (!firstUserMessage) {
			// Fallback: use all messages
			const content = messages.map(m => {
				if (m.role === vscode.LanguageModelChatMessageRole.User) {
					return m.content
						.filter(part => part instanceof vscode.LanguageModelTextPart)
						.map(part => (part as vscode.LanguageModelTextPart).value)
						.join('');
				}
				return '';
			}).join('');
			return crypto.createHash('sha256').update(content + modelId).digest('hex');
		}
		
		// Extract text from first user message
		const text = firstUserMessage.content
			.filter(part => part instanceof vscode.LanguageModelTextPart)
			.map(part => (part as vscode.LanguageModelTextPart).value)
			.join('');
		
		// Create hash
		return crypto.createHash('sha256').update(text + modelId).digest('hex');
	}
	
	/**
	 * Check if this is a new conversation (new user message without tool results)
	 */
	private isNewConversation(messages: vscode.LanguageModelChatMessage[]): boolean {
		if (messages.length === 0) {
			return true;
		}
		
		const lastMsg = messages[messages.length - 1];
		if (lastMsg.role !== vscode.LanguageModelChatMessageRole.User) {
			return false;
		}
		
		// Check if last message has tool results
		const hasToolResults = lastMsg.content.some(
			part => part instanceof vscode.LanguageModelToolResultPart
		);
		
		return !hasToolResults;
	}
	
	/**
	 * Match rules against conversation content and update available rules for session
	 */
	matchRulesForSession(
		messages: vscode.LanguageModelChatMessage[],
		modelId: string
	): Set<string> {
		const sessionId = this.getSessionId(messages, modelId);
		
		// If new conversation, reset available rules
		if (this.isNewConversation(messages)) {
			this.sessionRules.set(sessionId, new Set());
		}
		
		const availableRules = this.sessionRules.get(sessionId) || new Set<string>();
		
		// Match rules against messages and attachments
		for (const rule of this.rules) {
			if (!rule.metadata.globs || rule.metadata.globs.length === 0) {
				// Rules without globs are available by default unless explicitly disabled
				if (rule.metadata.alwaysApply !== false) {
					availableRules.add(rule.path);
				}
				continue;
			}
			
			// Check messages
			for (const msg of messages) {
				// Extract text content
				const textParts = msg.content
					.filter(part => part instanceof vscode.LanguageModelTextPart)
					.map(part => (part as vscode.LanguageModelTextPart).value);
				
				const text = textParts.join(' ');
				
				// Check for attachment references (e.g., @src/logger.ts:32)
				const attachmentMatches = text.match(/@[^\s:]+/g) || [];
				for (const attachment of attachmentMatches) {
					const filePath = extractFilePathFromAttachment(attachment);
					if (filePath && matchesAnyGlob(filePath, rule.metadata.globs)) {
						availableRules.add(rule.path);
						break;
					}
				}
				
				// Check if message content matches globs (for file paths mentioned in text)
				if (matchesAnyGlob(text, rule.metadata.globs)) {
					availableRules.add(rule.path);
					break;
				}
			}
			
			// Check tool call parameters (limited size for glob matching)
			for (const msg of messages) {
				const toolCallParts = msg.content.filter(
					part => part instanceof vscode.LanguageModelToolCallPart
				) as vscode.LanguageModelToolCallPart[];
				
				for (const toolCall of toolCallParts) {
					const paramsStr = JSON.stringify(toolCall.input).substring(0, TOOL_PARAMS_MATCH_MAX_BYTES);
					if (matchesAnyGlob(paramsStr, rule.metadata.globs)) {
						availableRules.add(rule.path);
						break;
					}
				}
			}
		}
		
		this.sessionRules.set(sessionId, availableRules);
		return availableRules;
	}
	
	/**
	 * Get available rules for a session
	 */
	getAvailableRules(messages: vscode.LanguageModelChatMessage[], modelId: string): ParsedRule[] {
		const sessionId = this.getSessionId(messages, modelId);
		const availableRulePaths = this.sessionRules.get(sessionId) || new Set<string>();
		
		return Array.from(availableRulePaths)
			.map(path => this.rulesCache.get(path))
			.filter((rule): rule is ParsedRule => rule !== undefined);
	}
	
	/**
	 * Find a rule by name (exact then case-insensitive).
	 */
	findRule(ruleName: string): ParsedRule | null {
		const normalizedName = normalizeRuleName(ruleName);

		// Try exact match first
		for (const rule of this.rules) {
			if (rule.path === normalizedName || rule.name === normalizedName) {
				return rule;
			}
		}

		// Try case-insensitive match
		const lowerName = normalizedName.toLowerCase();
		for (const rule of this.rules) {
			if (rule.path.toLowerCase() === lowerName || rule.name.toLowerCase() === lowerName) {
				return rule;
			}
		}

		return null;
	}

	/**
	 * Find a rule by name with optional fuzzy matching (exact, then case-insensitive, then Levenshtein).
	 * @param maxDistance Max edit distance for fuzzy match (default 8)
	 */
	findRuleFuzzy(ruleName: string, maxDistance: number = 8): ParsedRule | null {
		const rule = this.findRule(ruleName);
		if (rule) return rule;
		const candidateNames = this.rules.map((r) => r.path);
		const closest = findClosestMatch(normalizeRuleName(ruleName), candidateNames, maxDistance);
		return closest ? this.findRule(closest) : null;
	}

	/**
	 * Get all rules
	 */
	getAllRules(): ParsedRule[] {
		return this.rules;
	}

	/**
	 * Get total number of loaded rules
	 */
	getRuleCount(): number {
		return this.rules.length;
	}
}
