/**
 * Temporary fallback reasoning tracker.
 *
 * VS Code should round-trip LanguageModelThinkingPart in chat history, but
 * some builds / Copilot versions omit them from the messages passed back to
 * provideLanguageModelChatResponse. This tracker accumulates reasoning
 * content during streaming and re-injects it on the next request when the
 * round-trip path has no data.
 *
 * Delete this module once VS Code round-trips LanguageModelThinkingPart
 * reliably (grep for ThinkingTokensTracker to find all usage sites).
 */
import * as vscode from 'vscode';

export class ThinkingTokensTracker {
	private readonly tokens = new Map<string, string>();

	set(key: string, value: string): void {
		this.tokens.set(key, value);
	}

	clear(): void {
		this.tokens.clear();
	}

	get isEmpty(): boolean {
		return this.tokens.size === 0;
	}

	getForMessage(msg: vscode.LanguageModelChatRequestMessage): string | undefined {
		if (!hasToolCalls(msg)) return undefined;
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				const value = this.tokens.get(`toolCall_${part.callId}`);
				if (value) return value;
			}
		}
		return undefined;
	}

	shouldInclude(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
		if (this.isEmpty) return false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && hasToolCalls(msg)) {
				return this.getForMessage(msg) !== undefined;
			}
		}
		return false;
	}
}

function hasToolCalls(msg: vscode.LanguageModelChatRequestMessage): boolean {
	return msg.content.some((part) => part instanceof vscode.LanguageModelToolCallPart);
}
