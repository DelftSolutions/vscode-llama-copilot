import * as vscode from 'vscode';

/** Tracks thinking tokens per tool call for inclusion in follow-up requests. */
export class ThinkingTokensTracker {
	private readonly tokens = new Map<string, string>();

	set(key: string, value: string): void {
		this.tokens.set(key, value);
	}

	clear(): void {
		this.tokens.clear();
	}

	/** Get thinking tokens for an assistant message that contains tool calls (by tool call id). */
	getForMessage(msg: vscode.LanguageModelChatMessage): string | undefined {
		if (!hasToolCalls(msg)) return undefined;
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				const value = this.tokens.get(`toolCall_${part.callId}`);
				if (value) return value;
			}
		}
		return undefined;
	}

	/** Whether to include thinking tokens in the request (follow-up with tool results, not new user message). */
	shouldInclude(messages: vscode.LanguageModelChatMessage[]): boolean {
		if (messages.length === 0 || isNewUserMessage(messages)) return false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && hasToolCalls(msg)) {
				return this.getForMessage(msg) !== undefined;
			}
		}
		return false;
	}
}

function hasToolCalls(msg: vscode.LanguageModelChatMessage): boolean {
	return msg.content.some((part) => part instanceof vscode.LanguageModelToolCallPart);
}

function hasToolResults(msg: vscode.LanguageModelChatMessage): boolean {
	return msg.content.some((part) => part instanceof vscode.LanguageModelToolResultPart);
}

/** True if the last message is a new user message (no tool results). */
export function isNewUserMessage(messages: vscode.LanguageModelChatMessage[]): boolean {
	if (messages.length === 0) return false;
	const last = messages[messages.length - 1];
	return (
		last.role === vscode.LanguageModelChatMessageRole.User && !hasToolResults(last)
	);
}
