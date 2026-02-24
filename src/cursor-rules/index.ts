import * as vscode from 'vscode';
import { RuleManager } from './ruleManager';
import { normalizeRuleName } from './utils';

/** Tool name for the cursor rules tool (used by provider and tool) */
export const CURSOR_RULES_TOOL_NAME = 'get-project-rule';

/** Max Levenshtein distance for fuzzy rule name matching */
const FUZZY_MATCH_MAX_DISTANCE = 8;

/**
 * Resolve comma-separated rule names to rule content and return formatted string and normalized names.
 * Shared by CursorRulesTool.invoke and the provider's inline tool handling.
 */
export function resolveAndFormatRules(
	ruleManager: RuleManager,
	inputRule: string
): { formatted: string; ruleNames: string[] } {
	const ruleNames = inputRule.split(',').map((r) => normalizeRuleName(r.trim()));
	const results: Array<{ description: string; content: string }> = [];

	for (const normalizedName of ruleNames) {
		const rule = ruleManager.findRuleFuzzy(normalizedName, FUZZY_MATCH_MAX_DISTANCE);
		if (rule) {
			results.push({
				description: rule.metadata.description || rule.path,
				content: rule.content,
			});
		} else {
			results.push({ description: normalizedName, content: '<empty file>' });
		}
	}

	const formatted = results
		.map((r) => `# ${r.description}\n\n\`\`\`\`\n${r.content}\n\`\`\`\``)
		.join('\n\n');
	return { formatted, ruleNames };
}

export { normalizeRuleName } from './utils';

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

	get name(): string {
		return CURSOR_RULES_TOOL_NAME;
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
		const ruleNames = options.input.rule
			.split(',')
			.map((r) => normalizeRuleName(r.trim()))
			.join(', ');
		
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
		const { formatted } = resolveAndFormatRules(this.ruleManager, options.input.rule);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(formatted),
		]);
	}
}
