import { describe, it, expect } from 'vitest';
import type { OpenAIChatMessage, OpenAIToolCall } from './types';
import {
	sortKeysDeep,
	hashArgs,
	splitSegments,
	extractAssistantRounds,
	checkForLoop,
	pruneAndSummarize,
	buildLoopSummary,
	truncateArgs,
	truncateResult,
	processLoopDetection,
} from './toolLoopDetector';

// ---------------------------------------------------------------------------
// Helpers: build OpenAI messages for testing
// ---------------------------------------------------------------------------

function toolCall(id: string, name: string, args: Record<string, unknown>): OpenAIToolCall {
	return {
		id,
		type: 'function',
		function: { name, arguments: JSON.stringify(args) },
	};
}

function assistantMsg(calls: OpenAIToolCall[]): OpenAIChatMessage {
	return { role: 'assistant', content: null, tool_calls: calls };
}

function toolResultMsg(callId: string, content: string): OpenAIChatMessage {
	return { role: 'tool', content, tool_call_id: callId };
}

function userMsg(text: string): OpenAIChatMessage {
	return { role: 'user', content: text };
}

function systemMsg(text: string): OpenAIChatMessage {
	return { role: 'system', content: text };
}

/**
 * Build a simple round: one assistant message with one tool call + one tool result.
 */
function makeRound(
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
	result: string
): OpenAIChatMessage[] {
	return [
		assistantMsg([toolCall(callId, toolName, args)]),
		toolResultMsg(callId, result),
	];
}

// ---------------------------------------------------------------------------
// sortKeysDeep
// ---------------------------------------------------------------------------

describe('sortKeysDeep', () => {
	it('sorts top-level keys', () => {
		expect(sortKeysDeep({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
	});

	it('sorts nested object keys recursively', () => {
		expect(sortKeysDeep({ b: { d: 1, c: 2 }, a: 3 })).toEqual({ a: 3, b: { c: 2, d: 1 } });
	});

	it('sorts keys inside arrays', () => {
		expect(sortKeysDeep([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
	});

	it('passes primitives through', () => {
		expect(sortKeysDeep(42)).toBe(42);
		expect(sortKeysDeep('hello')).toBe('hello');
		expect(sortKeysDeep(null)).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

describe('hashArgs', () => {
	it('produces same hash regardless of key order', () => {
		const h1 = hashArgs('{"a":1,"b":2}');
		const h2 = hashArgs('{"b":2,"a":1}');
		expect(h1).toBe(h2);
	});

	it('returns 12-char hex string', () => {
		const h = hashArgs('{"path":"src/auth.ts"}');
		expect(h).toMatch(/^[0-9a-f]{12}$/);
	});

	it('handles malformed JSON gracefully', () => {
		const h = hashArgs('not json');
		expect(h).toMatch(/^[0-9a-f]{12}$/);
	});
});

// ---------------------------------------------------------------------------
// splitSegments
// ---------------------------------------------------------------------------

describe('splitSegments', () => {
	it('treats user messages as boundaries', () => {
		const msgs: OpenAIChatMessage[] = [
			userMsg('hello'),
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			userMsg('next'),
		];
		const { parts } = splitSegments(msgs);
		expect(parts).toHaveLength(3);
		expect(parts[0].type).toBe('boundary');
		expect(parts[1].type).toBe('segment');
		expect(parts[2].type).toBe('boundary');
	});

	it('treats system messages as boundaries', () => {
		const msgs: OpenAIChatMessage[] = [
			systemMsg('you are helpful'),
			userMsg('hi'),
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const { parts } = splitSegments(msgs);
		expect(parts[0].type).toBe('boundary');
		expect(parts[0].type === 'boundary' && parts[0].msg.role).toBe('system');
		expect(parts[1].type).toBe('boundary');
		expect(parts[2].type).toBe('segment');
	});

	it('preserves boundary messages unmodified', () => {
		const u = userMsg('test message');
		const { parts } = splitSegments([u]);
		expect(parts).toHaveLength(1);
		expect(parts[0].type === 'boundary' && parts[0].msg).toBe(u);
	});
});

// ---------------------------------------------------------------------------
// extractAssistantRounds
// ---------------------------------------------------------------------------

describe('extractAssistantRounds', () => {
	it('pairs assistant messages with their tool results', () => {
		const segment = makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content of a.ts');
		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(1);
		expect(rounds[0].toolResults).toHaveLength(1);
		expect(rounds[0].signatures).toHaveLength(1);
	});

	it('handles multiple rounds', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'A'),
			...makeRound('tc2', 'bash', { command: 'npm test' }, 'PASS'),
		];
		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(2);
	});

	it('handles assistant with multiple tool calls', () => {
		const segment: OpenAIChatMessage[] = [
			assistantMsg([
				toolCall('tc1', 'read_file', { path: 'a.ts' }),
				toolCall('tc2', 'bash', { command: 'npm test' }),
			]),
			toolResultMsg('tc1', 'content'),
			toolResultMsg('tc2', 'PASS'),
		];
		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(1);
		expect(rounds[0].signatures).toHaveLength(2);
		expect(rounds[0].toolResults).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// checkForLoop
// ---------------------------------------------------------------------------

describe('checkForLoop', () => {
	it('returns null when all signatures are unique', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'A'),
			...makeRound('tc2', 'read_file', { path: 'b.ts' }, 'B'),
			...makeRound('tc3', 'bash', { command: 'npm test' }, 'PASS'),
		];
		const rounds = extractAssistantRounds(segment);
		expect(checkForLoop(rounds)).toBeNull();
	});

	it('returns null when a signature appears only 2 times (below threshold)', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'bash', { command: 'npm test' }, 'PASS'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const rounds = extractAssistantRounds(segment);
		expect(checkForLoop(rounds)).toBeNull();
	});

	it('triggers at exactly 3 occurrences', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds);
		expect(detection).not.toBeNull();
		expect(detection!.cycleMembers).toHaveLength(1);
		expect(detection!.cycleMembers[0].windowCount).toBe(3);
	});

	it('identifies both tools in A,B,A,B,A,B cycle', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'apply_patch', { path: 'a.ts' }, 'OK'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc4', 'apply_patch', { path: 'a.ts' }, 'OK'),
			...makeRound('tc5', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc6', 'apply_patch', { path: 'a.ts' }, 'OK'),
		];
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds);
		expect(detection).not.toBeNull();
		expect(detection!.cycleMembers).toHaveLength(2);
		const names = detection!.cycleMembers.map(m => m.toolName).sort();
		expect(names).toEqual(['apply_patch', 'read_file']);
	});

	it('partial cycle A,B,C,A,B,A — only A and B are cycle members', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'apply_patch', { path: 'a.ts' }, 'OK'),
			...makeRound('tc3', 'bash', { command: 'npm test' }, 'FAIL'),
			...makeRound('tc4', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc5', 'apply_patch', { path: 'a.ts' }, 'OK'),
			...makeRound('tc6', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds);
		expect(detection).not.toBeNull();
		const names = detection!.cycleMembers.map(m => m.toolName).sort();
		expect(names).toEqual(['apply_patch', 'read_file']);
		expect(detection!.hasNonCycleMembers).toBe(true);
	});

	it('no false positive when results differ (same tool+args, different result)', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'version 1'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'version 2'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'version 3'),
		];
		const rounds = extractAssistantRounds(segment);
		// All three have different result hashes → different signatures → no trigger
		expect(checkForLoop(rounds)).toBeNull();
	});

	it('limits detection to last 9 rounds (window cap)', () => {
		// 10 unique rounds then 3 identical → only last 9 matter
		const segment: OpenAIChatMessage[] = [];
		for (let i = 0; i < 10; i++) {
			segment.push(...makeRound(`tc${i}`, 'read_file', { path: `file${i}.ts` }, `content${i}`));
		}
		// Now add 3 identical rounds (these are rounds 10, 11, 12 — but window sees last 9 = rounds 4-12)
		for (let i = 10; i < 13; i++) {
			segment.push(...makeRound(`tc${i}`, 'bash', { command: 'npm test' }, 'FAIL'));
		}
		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(13);
		const detection = checkForLoop(rounds, 9);
		expect(detection).not.toBeNull();
		expect(detection!.cycleMembers[0].toolName).toBe('bash');
	});

	it('does not trigger when identical calls are outside the window', () => {
		// 3 identical at the start, then 9 unique → window only sees the 9 unique
		const segment: OpenAIChatMessage[] = [];
		for (let i = 0; i < 3; i++) {
			segment.push(...makeRound(`tc${i}`, 'bash', { command: 'npm test' }, 'FAIL'));
		}
		for (let i = 3; i < 12; i++) {
			segment.push(...makeRound(`tc${i}`, 'read_file', { path: `file${i}.ts` }, `content${i}`));
		}
		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(12);
		const detection = checkForLoop(rounds, 9);
		expect(detection).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// pruneAndSummarize — output shape
// ---------------------------------------------------------------------------

describe('pruneAndSummarize', () => {
	it('collapses simple A,A,A loop to first-seen + last-occurrence with refusal', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds)!;
		const pruned = pruneAndSummarize(segment, detection, rounds);

		// Should have: assistant(tc1) + tool(tc1) + assistant(tc3) + tool(tc3-replaced)
		expect(pruned).toHaveLength(4);
		// First round kept intact
		expect(pruned[0]).toBe(segment[0]); // same ref — unchanged
		expect(pruned[1]).toBe(segment[1]);
		// Last round: assistant kept, tool result replaced
		expect(pruned[2]).toBe(segment[4]); // assistant msg for tc3
		expect(pruned[3].role).toBe('tool');
		expect(pruned[3].tool_call_id).toBe('tc3');
		expect(typeof pruned[3].content).toBe('string');
		expect((pruned[3].content as string)).toContain('[LOOP DETECTED');
	});

	it('ABC×3 prune shape: rounds 1-3 kept, 4-6 removed, 7-9 kept with refusals', () => {
		const segment: OpenAIChatMessage[] = [];
		for (let iter = 0; iter < 3; iter++) {
			const base = iter * 3;
			segment.push(...makeRound(`tc${base + 1}`, 'read_file', { path: 'a.ts' }, 'content'));
			segment.push(...makeRound(`tc${base + 2}`, 'apply_patch', { path: 'a.ts', patch: 'diff' }, 'OK'));
			segment.push(...makeRound(`tc${base + 3}`, 'bash', { command: 'npm test' }, 'FAIL'));
		}
		// 9 rounds = 18 messages
		expect(segment).toHaveLength(18);

		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(9);
		const detection = checkForLoop(rounds)!;
		expect(detection).not.toBeNull();

		const pruned = pruneAndSummarize(segment, detection, rounds);

		// Rounds 1-3 kept (6 msgs) + rounds 4-6 removed (0 msgs) + rounds 7-9 kept (6 msgs) = 12
		expect(pruned).toHaveLength(12);

		// First 6 messages: original rounds 1-3
		for (let i = 0; i < 6; i++) {
			expect(pruned[i]).toBe(segment[i]);
		}

		// Next 6 messages: rounds 7-9 with replaced tool results
		// Round 7 = segment[12..13], Round 8 = segment[14..15], Round 9 = segment[16..17]
		expect(pruned[6]).toBe(segment[12]); // assistant for round 7
		expect((pruned[7].content as string)).toContain('[LOOP DETECTED —'); // full summary
		expect(pruned[7].tool_call_id).toBe('tc7');

		expect(pruned[8]).toBe(segment[14]); // assistant for round 8
		expect((pruned[9].content as string)).toContain('same repeating cycle'); // back-reference
		expect(pruned[9].tool_call_id).toBe('tc8');

		expect(pruned[10]).toBe(segment[16]); // assistant for round 9
		expect((pruned[11].content as string)).toContain('same repeating cycle');
		expect(pruned[11].tool_call_id).toBe('tc9');
	});

	it('partial cycle A,B,C,A,B,A — removes only round 4, keeps round 5 and 6 as last-occurrence', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'apply_patch', { path: 'a.ts', patch: 'diff' }, 'OK'),
			...makeRound('tc3', 'bash', { command: 'npm test' }, 'FAIL'),
			...makeRound('tc4', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc5', 'apply_patch', { path: 'a.ts', patch: 'diff' }, 'OK'),
			...makeRound('tc6', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds)!;
		const pruned = pruneAndSummarize(segment, detection, rounds);

		// Rounds 1(A),2(B),3(C) kept intact (6 msgs)
		// Round 4(A) removed (0 msgs)
		// Round 5(B) kept, result replaced (2 msgs)
		// Round 6(A) kept, result replaced (2 msgs)
		expect(pruned).toHaveLength(10);

		// First 6: intact
		for (let i = 0; i < 6; i++) {
			expect(pruned[i]).toBe(segment[i]);
		}

		// Round 5 (last-occurrence B): tool result replaced
		expect(pruned[6]).toBe(segment[8]); // assistant msg for tc5
		expect((pruned[7].content as string)).toContain('[LOOP DETECTED');
		expect(pruned[7].tool_call_id).toBe('tc5');

		// Round 6 (last-occurrence A): tool result replaced (back-reference)
		expect(pruned[8]).toBe(segment[10]); // assistant msg for tc6
		expect((pruned[9].content as string)).toContain('same repeating cycle');
		expect(pruned[9].tool_call_id).toBe('tc6');
	});

	it('never mutates the input segment', () => {
		const segment = [
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const original = [...segment];
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds)!;
		pruneAndSummarize(segment, detection, rounds);
		// Original array unchanged
		expect(segment).toEqual(original);
		expect(segment.length).toBe(original.length);
	});
});

// ---------------------------------------------------------------------------
// Tool filtering (escalation)
// ---------------------------------------------------------------------------

describe('tool filtering (escalation at count >= 6)', () => {
	it('populates toolsToFilter when full-history count >= 6 and loop active at end', () => {
		// 6 identical rounds: A×6
		const segment: OpenAIChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			segment.push(...makeRound(`tc${i}`, 'read_file', { path: 'a.ts' }, 'content'));
		}
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds)!;
		expect(detection).not.toBeNull();
		expect(detection.cycleMembers[0].totalCount).toBe(6);
		expect(detection.toolsToFilter).toContain('read_file');
	});

	it('does not filter when loop is NOT active at end', () => {
		// 6 identical rounds then one different round
		const segment: OpenAIChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			segment.push(...makeRound(`tc${i}`, 'read_file', { path: 'a.ts' }, 'content'));
		}
		segment.push(...makeRound('tc_diff', 'bash', { command: 'ls' }, 'files'));
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds)!;
		expect(detection).not.toBeNull();
		expect(detection.toolsToFilter).toEqual([]);
	});

	it('does not filter when count is 5 (below threshold)', () => {
		const segment: OpenAIChatMessage[] = [];
		for (let i = 0; i < 5; i++) {
			segment.push(...makeRound(`tc${i}`, 'read_file', { path: 'a.ts' }, 'content'));
		}
		const rounds = extractAssistantRounds(segment);
		const detection = checkForLoop(rounds)!;
		expect(detection).not.toBeNull();
		expect(detection.cycleMembers[0].totalCount).toBe(5);
		expect(detection.toolsToFilter).toEqual([]);
	});

	it('escalation counts use full segment history beyond the 9-round window', () => {
		// 3-tool cycle × 6 iterations = 18 rounds
		const segment: OpenAIChatMessage[] = [];
		for (let iter = 0; iter < 6; iter++) {
			segment.push(...makeRound(`tc_a${iter}`, 'read_file', { path: 'a.ts' }, 'content'));
			segment.push(...makeRound(`tc_b${iter}`, 'apply_patch', { path: 'a.ts', patch: 'diff' }, 'OK'));
			segment.push(...makeRound(`tc_c${iter}`, 'bash', { command: 'npm test' }, 'FAIL'));
		}
		const rounds = extractAssistantRounds(segment);
		expect(rounds).toHaveLength(18);

		const detection = checkForLoop(rounds, 9)!;
		expect(detection).not.toBeNull();

		// Window only sees last 9 rounds (2 full iterations + first of 3rd)
		// But totalCount should be 6 for each member
		for (const member of detection.cycleMembers) {
			expect(member.totalCount).toBe(6);
		}
		// All three should be filtered
		expect(detection.toolsToFilter.sort()).toEqual(['apply_patch', 'bash', 'read_file']);
	});
});

// ---------------------------------------------------------------------------
// processLoopDetection (segment-based)
// ---------------------------------------------------------------------------

describe('processLoopDetection', () => {
	it('returns unmodified messages when no loop', () => {
		const messages: OpenAIChatMessage[] = [
			systemMsg('you are helpful'),
			userMsg('hello'),
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const { messages: result, lastDetection } = processLoopDetection(messages);
		expect(lastDetection).toBeNull();
		expect(result).toHaveLength(messages.length);
	});

	it('prunes loops within a segment while preserving boundaries', () => {
		const messages: OpenAIChatMessage[] = [
			systemMsg('system prompt'),
			userMsg('do something'),
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const { messages: result, lastDetection } = processLoopDetection(messages);
		expect(lastDetection).not.toBeNull();
		// system + user + first-seen(2) + last-occurrence(2) = 6
		expect(result).toHaveLength(6);
		expect(result[0].role).toBe('system');
		expect(result[1].role).toBe('user');
	});

	it('user messages reset detection between segments', () => {
		const messages: OpenAIChatMessage[] = [
			userMsg('first'),
			// Segment 1: loop of A×3
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
			userMsg('try something else'),
			// Segment 2: no loop
			...makeRound('tc4', 'bash', { command: 'npm test' }, 'PASS'),
		];
		const { messages: result, lastDetection } = processLoopDetection(messages);
		// Last segment has no loop
		expect(lastDetection).toBeNull();
		// Segment 1 still gets pruned (3 rounds → 2 kept = 4 msgs)
		// Total: user(1) + pruned_seg1(4) + user(1) + seg2(2) = 8
		expect(result).toHaveLength(8);
	});

	it('old segment stays pruned even after user message', () => {
		const messages: OpenAIChatMessage[] = [
			userMsg('first'),
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
			userMsg('ok now what'),
			...makeRound('tc4', 'bash', { command: 'ls' }, 'files'),
		];
		const result1 = processLoopDetection(messages);
		// Call again — same input should produce same output (deterministic)
		const result2 = processLoopDetection(messages);
		expect(result1.messages.length).toBe(result2.messages.length);
		// Verify the old loop is still pruned
		const assistantMsgs = result1.messages.filter(m => m.role === 'assistant');
		// Should have 2 assistant from segment 1 (first-seen + last-occurrence) + 1 from segment 2
		expect(assistantMsgs).toHaveLength(3);
	});

	it('never mutates the input array', () => {
		const messages: OpenAIChatMessage[] = [
			userMsg('hi'),
			...makeRound('tc1', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc2', 'read_file', { path: 'a.ts' }, 'content'),
			...makeRound('tc3', 'read_file', { path: 'a.ts' }, 'content'),
		];
		const originalLength = messages.length;
		processLoopDetection(messages);
		expect(messages).toHaveLength(originalLength);
	});
});

// ---------------------------------------------------------------------------
// buildLoopSummary
// ---------------------------------------------------------------------------

describe('buildLoopSummary', () => {
	it('includes header, cycle members, diagnosis, and directive', () => {
		const summary = buildLoopSummary({
			trigger: 'sig_a',
			cycleMembers: [
				{
					signature: 'sig_a',
					toolName: 'read_file',
					args: '{"path":"src/auth.ts"}',
					result: 'import { validateToken }...',
					windowCount: 3,
					totalCount: 3,
					firstSeenRound: 0,
				},
			],
			toolsToFilter: [],
			hasNonCycleMembers: false,
		});
		expect(summary).toContain('[LOOP DETECTED');
		expect(summary).toContain('3 repetitions');
		expect(summary).toContain('cycle of 1 tool calls');
		expect(summary).toContain('read_file');
		expect(summary).toContain('Each call above returned the same result');
		expect(summary).toContain('Do NOT retry');
		expect(summary).not.toContain('Non-cycle calls');
	});

	it('includes non-cycle-member note when applicable', () => {
		const summary = buildLoopSummary({
			trigger: 'sig_a',
			cycleMembers: [
				{
					signature: 'sig_a',
					toolName: 'read_file',
					args: '{}',
					result: 'content',
					windowCount: 3,
					totalCount: 3,
					firstSeenRound: 0,
				},
			],
			toolsToFilter: [],
			hasNonCycleMembers: true,
		});
		expect(summary).toContain('Non-cycle calls in this range were preserved');
	});

	it('includes tool filtering note when tools are filtered', () => {
		const summary = buildLoopSummary({
			trigger: 'sig_a',
			cycleMembers: [
				{
					signature: 'sig_a',
					toolName: 'read_file',
					args: '{}',
					result: 'content',
					windowCount: 3,
					totalCount: 6,
					firstSeenRound: 0,
				},
			],
			toolsToFilter: ['read_file'],
			hasNonCycleMembers: false,
		});
		expect(summary).toContain('temporarily removed');
		expect(summary).toContain('read_file');
	});
});

// ---------------------------------------------------------------------------
// truncateArgs / truncateResult
// ---------------------------------------------------------------------------

describe('truncateArgs', () => {
	it('returns short args as-is', () => {
		expect(truncateArgs('{"path":"a.ts"}')).toBe('{"path":"a.ts"}');
	});

	it('truncates long string values in JSON', () => {
		const longArgs = JSON.stringify({ path: 'a.ts', patch: 'x'.repeat(100) });
		const result = truncateArgs(longArgs, 80);
		expect(result.length).toBeLessThanOrEqual(80);
		expect(result).toContain('...');
	});

	it('hard-truncates non-JSON strings', () => {
		const result = truncateArgs('a'.repeat(100), 80);
		expect(result.length).toBe(80);
		expect(result).toMatch(/\.\.\.$/);
	});
});

describe('truncateResult', () => {
	it('returns short results as-is', () => {
		expect(truncateResult('OK')).toBe('OK');
	});

	it('replaces newlines and truncates long results', () => {
		const result = truncateResult('line1\nline2\nline3\n' + 'x'.repeat(200), 50);
		expect(result.length).toBe(50);
		expect(result).toContain('\\n');
		expect(result).toMatch(/\.\.\.$/);
	});
});
