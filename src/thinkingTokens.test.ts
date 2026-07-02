import { describe, it, expect } from 'vitest';
import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
} from 'vscode';
import { ThinkingTokensTracker } from './thinkingTokens';

describe('ThinkingTokensTracker', () => {
	it('stores and retrieves reasoning by tool call id', () => {
		const tracker = new ThinkingTokensTracker();
		tracker.set('toolCall_c1', 'my reasoning');

		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelToolCallPart('c1', 'myTool', {}),
		]);
		expect(tracker.getForMessage(msg)).toBe('my reasoning');
	});

	it('returns undefined for unknown tool call ids', () => {
		const tracker = new ThinkingTokensTracker();
		tracker.set('toolCall_c1', 'reasoning');

		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelToolCallPart('c2', 'otherTool', {}),
		]);
		expect(tracker.getForMessage(msg)).toBeUndefined();
	});

	it('returns undefined for messages without tool calls', () => {
		const tracker = new ThinkingTokensTracker();
		tracker.set('toolCall_c1', 'reasoning');

		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelTextPart('hello'),
		]);
		expect(tracker.getForMessage(msg)).toBeUndefined();
	});

	it('clears all stored reasoning', () => {
		const tracker = new ThinkingTokensTracker();
		tracker.set('toolCall_c1', 'reasoning 1');
		tracker.set('toolCall_c2', 'reasoning 2');
		tracker.clear();

		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelToolCallPart('c1', 'tool', {}),
		]);
		expect(tracker.getForMessage(msg)).toBeUndefined();
		expect(tracker.isEmpty).toBe(true);
	});

	it('isEmpty is true when empty', () => {
		const tracker = new ThinkingTokensTracker();
		expect(tracker.isEmpty).toBe(true);
	});

	it('isEmpty is false after set', () => {
		const tracker = new ThinkingTokensTracker();
		tracker.set('key', 'val');
		expect(tracker.isEmpty).toBe(false);
	});

	describe('shouldInclude', () => {
		it('returns false when tracker is empty', () => {
			const tracker = new ThinkingTokensTracker();
			const messages = [
				new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
					new LanguageModelToolCallPart('c1', 'tool', {}),
				]),
			];
			expect(tracker.shouldInclude(messages)).toBe(false);
		});

		it('returns true when tracker has data for a recent assistant tool-call message', () => {
			const tracker = new ThinkingTokensTracker();
			tracker.set('toolCall_c1', 'reasoning');

			const messages = [
				new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
					new LanguageModelToolCallPart('c1', 'tool', {}),
				]),
				new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
					new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('result')]),
				]),
			];
			expect(tracker.shouldInclude(messages)).toBe(true);
		});

		it('returns false when no assistant messages have matching tool calls', () => {
			const tracker = new ThinkingTokensTracker();
			tracker.set('toolCall_c1', 'reasoning');

			const messages = [
				new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
					new LanguageModelToolCallPart('c99', 'tool', {}),
				]),
			];
			expect(tracker.shouldInclude(messages)).toBe(false);
		});
	});
});
