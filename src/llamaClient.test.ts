import { describe, it, expect } from 'vitest';
import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelThinkingPart,
	LanguageModelChatToolMode,
} from 'vscode';
import {
	convertVSCodeMessagesToOpenAI,
	convertInputPartToOpenAI,
	mapToolModeToToolChoice,
} from './llamaClient';

describe('convertVSCodeMessagesToOpenAI', () => {
	it('converts a simple user message', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelTextPart('hello'),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages);
		expect(result).toEqual([{ role: 'user', content: 'hello' }]);
	});

	it('converts assistant message with tool calls', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelToolCallPart('c1', 'myTool', { x: 1 }),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages);
		expect(result).toEqual([
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'c1',
						type: 'function',
						function: { name: 'myTool', arguments: '{"x":1}' },
					},
				],
			},
		]);
	});

	it('extracts reasoning_content from ThinkingPart in assistant message', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('my reasoning'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, { isNewUserMessage: false });
		expect(result[0].reasoning_content).toBe('my reasoning');
	});

	it('skips reasoning_content when isNewUserMessage is true', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('my reasoning'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, { isNewUserMessage: true });
		expect(result[0].reasoning_content).toBeUndefined();
	});

	it('does not set reasoning_content for empty thinking', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart(''),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, { isNewUserMessage: false });
		expect(result[0].reasoning_content).toBeUndefined();
	});

	it('prefers _completeThinking over incremental values', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('partial'),
				new LanguageModelThinkingPart('x', undefined, { _completeThinking: 'complete thought' }),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, { isNewUserMessage: false });
		expect(result[0].reasoning_content).toBe('complete thought');
	});

	it('skips vscode_reasoning_done markers', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('real thinking'),
				new LanguageModelThinkingPart('', undefined, { vscode_reasoning_done: true }),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, { isNewUserMessage: false });
		expect(result[0].reasoning_content).toBe('real thinking');
	});

	it('uses tracker when reasoningSource is tracker', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, {
			reasoningSource: 'tracker',
			getThinkingTokens: (msg) => {
				for (const p of msg.content) {
					if (p instanceof LanguageModelToolCallPart && p.callId === 'c1') {
						return 'tracker reasoning';
					}
				}
				return undefined;
			},
		});
		expect(result[0].reasoning_content).toBe('tracker reasoning');
	});

	it('roundtrip ignores getThinkingTokens even if provided', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('round-trip reasoning'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, {
			reasoningSource: 'roundtrip',
			getThinkingTokens: () => 'should not appear',
		});
		expect(result[0].reasoning_content).toBe('round-trip reasoning');
	});

	it('none omits both roundtrip and tracker reasoning', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
				new LanguageModelThinkingPart('thinking'),
				new LanguageModelToolCallPart('c1', 'tool', {}),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages, {
			reasoningSource: 'none',
			getThinkingTokens: () => 'should not appear',
		});
		expect(result[0].reasoning_content).toBeUndefined();
	});

	it('converts tool result messages', () => {
		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('result text')]),
			]),
		];
		const result = convertVSCodeMessagesToOpenAI(messages);
		expect(result).toEqual([
			{ role: 'tool', content: 'result text', tool_call_id: 'c1' },
		]);
	});
});

describe('convertInputPartToOpenAI', () => {
	it('converts LanguageModelTextPart to text content part', () => {
		const part = new LanguageModelTextPart('hello');
		const result = convertInputPartToOpenAI(part);
		expect(result).toEqual({ type: 'text', text: 'hello' });
	});

	it('returns undefined for unknown part types', () => {
		const result = convertInputPartToOpenAI({ random: true });
		expect(result).toBeUndefined();
	});

	it('returns undefined for null', () => {
		const result = convertInputPartToOpenAI(null);
		expect(result).toBeUndefined();
	});
});

describe('mapToolModeToToolChoice', () => {
	it('returns undefined when no tools', () => {
		expect(mapToolModeToToolChoice(LanguageModelChatToolMode.Auto, false)).toBeUndefined();
	});

	it('returns auto for Auto mode', () => {
		expect(mapToolModeToToolChoice(LanguageModelChatToolMode.Auto, true)).toBe('auto');
	});

	it('returns required for Required mode', () => {
		expect(mapToolModeToToolChoice(LanguageModelChatToolMode.Required, true)).toBe('required');
	});

	it('returns auto when toolMode is undefined', () => {
		expect(mapToolModeToToolChoice(undefined, true)).toBe('auto');
	});
});
