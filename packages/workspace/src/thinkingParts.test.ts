import { describe, it, expect } from 'vitest';
import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelThinkingPart,
} from 'vscode';
import { extractReasoningFromAssistantMessage, isNewUserMessage, hasIncomingThinkingParts, getReasoningSource } from './thinkingParts';

describe('extractReasoningFromAssistantMessage', () => {
	it('returns undefined when no thinking parts present', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelTextPart('hello'),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBeUndefined();
	});

	it('concatenates incremental thinking values', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('step 1 '),
			new LanguageModelThinkingPart('step 2'),
			new LanguageModelTextPart('answer'),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBe('step 1 step 2');
	});

	it('prefers _completeThinking metadata over incremental parts', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('partial'),
			new LanguageModelThinkingPart('more', undefined, { _completeThinking: 'full reasoning' }),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBe('full reasoning');
	});

	it('skips parts with vscode_reasoning_done metadata', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('real thinking'),
			new LanguageModelThinkingPart('', undefined, { vscode_reasoning_done: true }),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBe('real thinking');
	});

	it('returns undefined when all parts are reasoning_done markers', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('', undefined, { vscode_reasoning_done: true }),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBeUndefined();
	});

	it('returns undefined when thinking values are empty', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart(''),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBeUndefined();
	});

	it('handles string array values', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart(['chunk1', 'chunk2']),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBe('chunk1chunk2');
	});

	it('extracts thinking alongside tool calls', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('reasoning here'),
			new LanguageModelToolCallPart('call1', 'myTool', { arg: 'val' }),
		]);
		expect(extractReasoningFromAssistantMessage(msg)).toBe('reasoning here');
	});
});

describe('isNewUserMessage', () => {
	it('returns false for empty messages', () => {
		expect(isNewUserMessage([])).toBe(false);
	});

	it('returns true when last message is a user message without tool results', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelTextPart('hello'),
			]),
		];
		expect(isNewUserMessage(messages)).toBe(true);
	});

	it('returns false when last message is a user message with tool results', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelToolResultPart('call1', [new LanguageModelTextPart('result')]),
			]),
		];
		expect(isNewUserMessage(messages)).toBe(false);
	});

	it('returns false when last message is an assistant message', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelTextPart('hi there'),
			]),
		];
		expect(isNewUserMessage(messages)).toBe(false);
	});
});

describe('hasIncomingThinkingParts', () => {
	it('returns false when no assistant messages have thinking parts', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelTextPart('hello'),
			]),
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelTextPart('answer'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		expect(hasIncomingThinkingParts(messages)).toBe(false);
	});

	it('returns true when an assistant message has a thinking part', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('reasoning'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		expect(hasIncomingThinkingParts(messages)).toBe(true);
	});

	it('returns false when only reasoning_done markers exist', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('', undefined, { vscode_reasoning_done: true }),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		expect(hasIncomingThinkingParts(messages)).toBe(false);
	});

	it('ignores user messages with thinking-like parts', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelTextPart('user text'),
			]),
		];
		expect(hasIncomingThinkingParts(messages)).toBe(false);
	});
});

describe('getReasoningSource', () => {
	it('returns none for new user message', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelTextPart('hello'),
			]),
		];
		expect(getReasoningSource(messages, true)).toBe('none');
	});

	it('returns roundtrip when thinking parts exist', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('reasoning'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('result')]),
			]),
		];
		expect(getReasoningSource(messages, false)).toBe('roundtrip');
	});

	it('returns tracker when no thinking parts but tracker has data', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('result')]),
			]),
		];
		expect(getReasoningSource(messages, true)).toBe('tracker');
	});

	it('returns none when no thinking parts and tracker is empty', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('result')]),
			]),
		];
		expect(getReasoningSource(messages, false)).toBe('none');
	});
});
