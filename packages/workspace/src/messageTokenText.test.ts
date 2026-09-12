import { describe, it, expect } from 'vitest';
import {
	LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelThinkingPart,
} from 'vscode';
import { extractTextFromRequestMessage } from './provider';

describe('extractTextFromRequestMessage', () => {
	it('serializes text-only message', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
			new LanguageModelTextPart('hello'),
			new LanguageModelTextPart(' world'),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('hello world');
	});

	it('includes tool call name and args', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelTextPart('calling'),
			new LanguageModelToolCallPart('c1', 'myTool', { x: 1 }),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('callingmyTool{"x":1}');
	});

	it('includes nested tool result text', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
			new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('result text')]),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('result text');
	});

	it('includes thinking content', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('my reasoning'),
			new LanguageModelTextPart('answer'),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('answermy reasoning');
	});

	it('prefers _completeThinking over incremental values', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('partial'),
			new LanguageModelThinkingPart('x', undefined, { _completeThinking: 'complete thought' }),
			new LanguageModelTextPart('answer'),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('answercomplete thought');
	});

	it('skips vscode_reasoning_done markers', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('real thinking'),
			new LanguageModelThinkingPart('', undefined, { vscode_reasoning_done: true }),
			new LanguageModelTextPart('answer'),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('answerreal thinking');
	});

	it('includes text, tool call, and reasoning together', () => {
		const msg = new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
			new LanguageModelThinkingPart('think'),
			new LanguageModelTextPart('hi'),
			new LanguageModelToolCallPart('c1', 'tool', { a: true }),
		]);
		expect(extractTextFromRequestMessage(msg)).toBe('hitool{"a":true}think');
	});
});
