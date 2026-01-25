import * as vscode from 'vscode';
import { RuleManager } from './ruleManager';
import { findClosestMatch } from './levenshtein';

/**
 * Parameters for get-project-rule tool
 */
export interface GetProjectRuleParameters {
	rule: string; // Comma-separated list of rule names
}

/**
 * Cursor Rules Tool implementation
 */
export class CursorRulesTool implements vscode.LanguageModelTool<GetProjectRuleParameters> {
	constructor(private ruleManager: RuleManager) {}
	
	/**
	 * Get tool name
	 */
	get name(): string {
		return 'get-project-rule';
	}
	
	/**
	 * Get tool description
	 * This will be dynamically updated based on available rules
	 */
	getDescription(availableRules: Array<{ path: string; description?: string }>): string {
		if (availableRules.length === 0) {
			return '';
		}
		
		const ruleList = availableRules
			.map(rule => {
				const displayName = rule.description || rule.path;
				return `- [${displayName}](rule:${rule.path})`;
			})
			.join('\n');
		
		return `The user made the following notes about files you are editing:\n${ruleList}`;
	}
	
	/**
	 * Prepare tool invocation (confirmation message)
	 */
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetProjectRuleParameters>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation | undefined> {
		const rules = options.input.rule.split(',').map(r => r.trim());
		const ruleNames = rules.map(r => r.replace(/^rule:/, '')).join(', ');
		
		return {
			invocationMessage: `Fetching project rules: ${ruleNames}`,
			confirmationMessages: {
				title: 'Get Project Rules',
				message: new vscode.MarkdownString(`Fetch the following project rules?\n\n${ruleNames}`),
			},
		};
	}
	
	/**
	 * Invoke the tool
	 */
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetProjectRuleParameters>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const ruleNames = options.input.rule.split(',').map(r => r.trim());
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
		
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(formattedResults),
		]);
	}
}
