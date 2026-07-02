import * as vscode from 'vscode';

/**
 * Extract reasoning content from an assistant message's LanguageModelThinkingPart entries.
 *
 * Mirrors Copilot BYOK anthropicMessageConverter.ts behavior:
 * 1. Skip parts with metadata.vscode_reasoning_done === true
 * 2. Prefer metadata._completeThinking if any part has it
 * 3. Otherwise concatenate all non-empty thinking values
 */
export function extractReasoningFromAssistantMessage(
	msg: vscode.LanguageModelChatRequestMessage
): string | undefined {
	const ThinkingPart = (vscode as { LanguageModelThinkingPart?: Function }).LanguageModelThinkingPart;

	const thinkingParts: Array<{ value: string | string[]; metadata?: Record<string, unknown> }> = [];
	for (const part of msg.content) {
		const isThinking =
			(ThinkingPart && part instanceof ThinkingPart) ||
			(part != null && typeof part === 'object' && 'value' in part &&
				part.constructor?.name === 'LanguageModelThinkingPart');
		if (!isThinking) continue;

		const tp = part as { value: string | string[]; metadata?: Record<string, unknown> };

		if (tp.metadata?.vscode_reasoning_done === true) continue;

		thinkingParts.push(tp);
	}

	if (thinkingParts.length === 0) return undefined;

	// Prefer _completeThinking if any part carries it
	for (const tp of thinkingParts) {
		const complete = tp.metadata?._completeThinking;
		if (typeof complete === 'string' && complete.length > 0) return complete;
	}

	// Concatenate incremental values
	const joined = thinkingParts
		.map((tp) => (Array.isArray(tp.value) ? tp.value.join('') : tp.value))
		.filter(Boolean)
		.join('');

	return joined.length > 0 ? joined : undefined;
}

function hasToolCalls(msg: vscode.LanguageModelChatRequestMessage): boolean {
	return msg.content.some((part) => part instanceof vscode.LanguageModelToolCallPart);
}

function hasToolResults(msg: vscode.LanguageModelChatRequestMessage): boolean {
	return msg.content.some((part) => part instanceof vscode.LanguageModelToolResultPart);
}

/** True if the last message is a new user message (no tool results). */
export function isNewUserMessage(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
	if (messages.length === 0) return false;
	const last = messages[messages.length - 1];
	return (
		last.role === vscode.LanguageModelChatMessageRole.User && !hasToolResults(last)
	);
}
