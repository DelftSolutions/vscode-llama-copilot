import { createHash } from 'crypto';
import type { OpenAIChatMessage, OpenAIToolCall } from '@llama-copilot/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identity of a single tool call: tool name + canonical args + result text. */
export interface ToolCallSignature {
	readonly name: string;
	readonly argsHash: string;
	readonly resultHash: string;
}

/** One assistant message with tool_calls paired with its role:tool result messages. */
export interface AssistantRound {
	/** Index of the assistant message in the segment's message array. */
	assistantIdx: number;
	/** The assistant message itself. */
	assistantMsg: OpenAIChatMessage;
	/** Paired tool result messages (role:tool), in message-array order. */
	toolResults: Array<{ idx: number; msg: OpenAIChatMessage }>;
	/** Pre-computed signatures, one per tool_call in the assistant message. */
	signatures: string[];
}

/** A single cycle member identified by checkForLoop. */
export interface CycleMember {
	/** The signature hash (identity / dedup key). */
	signature: string;
	/** Original tool name, e.g. "read_file". */
	toolName: string;
	/** Original args JSON string. */
	args: string;
	/** Full text of the tool result (from the first-seen round). */
	result: string;
	/** Occurrences in the 9-round detection window (used for summary "xN"). */
	windowCount: number;
	/** Occurrences across all rounds in the current segment (used for escalation). */
	totalCount: number;
	/** Index into the rounds array where this member first appeared. */
	firstSeenRound: number;
}

/** Result of checkForLoop when a loop is detected. */
export interface LoopDetection {
	/** The signature that triggered detection (count >= 3 in window). */
	trigger: string;
	/** All cycle members (signatures with count >= 2 in the trigger-to-end range). */
	cycleMembers: CycleMember[];
	/** Tool names to remove from the tool list (escalation count >= 6, loop active at end). */
	toolsToFilter: string[];
	/** Whether any non-cycle-member tool calls exist in the cycle range. */
	hasNonCycleMembers: boolean;
}

/** Return type of processLoopDetection. */
export interface LoopDetectionResult {
	/** The (possibly pruned) message array — always a new array, input is never mutated. */
	messages: OpenAIChatMessage[];
	/** Detection from the last segment, or null if no loop was found. */
	lastDetection: LoopDetection | null;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys so JSON.stringify output is stable regardless of
 * property insertion order. Arrays are recursed element-wise; primitives pass through.
 */
export function sortKeysDeep(value: unknown): unknown {
	if (value === null || value === undefined || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

/**
 * Canonicalize a tool-call arguments JSON string and return an md5 hash (12 hex chars).
 * Handles malformed JSON defensively by hashing the raw string.
 */
export function hashArgs(args: string): string {
	let canonical: string;
	try {
		const parsed = JSON.parse(args);
		canonical = JSON.stringify(sortKeysDeep(parsed));
	} catch {
		canonical = args;
	}
	return createHash('md5').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Hash arbitrary text (tool result content) to 12 hex chars.
 */
function hashText(text: string): string {
	return createHash('md5').update(text).digest('hex').slice(0, 12);
}

/**
 * Compute a single string signature for a tool call + its result.
 */
function computeSignature(toolCall: OpenAIToolCall, resultText: string): string {
	const name = toolCall.function.name;
	const ah = hashArgs(toolCall.function.arguments);
	const rh = hashText(resultText);
	return `${name}:${ah}:${rh}`;
}

// ---------------------------------------------------------------------------
// Segment splitting
// ---------------------------------------------------------------------------

interface SegmentSplit {
	/** Message parts — either a boundary (single message) or a segment (assistant+tool block). */
	parts: Array<{ type: 'boundary'; msg: OpenAIChatMessage } | { type: 'segment'; messages: OpenAIChatMessage[] }>;
}

/**
 * Split the message array into segments at each role:user or role:system message.
 * Boundary messages pass through unmodified.
 */
export function splitSegments(messages: OpenAIChatMessage[]): SegmentSplit {
	const parts: SegmentSplit['parts'] = [];
	let currentSegment: OpenAIChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'user' || msg.role === 'system') {
			if (currentSegment.length > 0) {
				parts.push({ type: 'segment', messages: currentSegment });
				currentSegment = [];
			}
			parts.push({ type: 'boundary', msg });
		} else {
			currentSegment.push(msg);
		}
	}
	if (currentSegment.length > 0) {
		parts.push({ type: 'segment', messages: currentSegment });
	}

	return { parts };
}

// ---------------------------------------------------------------------------
// Round extraction
// ---------------------------------------------------------------------------

/**
 * Extract the text content from an OpenAI message, handling string | null | ContentPart[].
 */
function getMessageText(msg: OpenAIChatMessage): string {
	if (typeof msg.content === 'string') return msg.content;
	if (msg.content === null || msg.content === undefined) return '';
	return msg.content
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map(p => p.text)
		.join('');
}

/**
 * Walk a single segment's messages and pair each assistant message (with tool_calls)
 * with its subsequent role:tool result messages.
 */
export function extractAssistantRounds(segment: OpenAIChatMessage[]): AssistantRound[] {
	const rounds: AssistantRound[] = [];

	for (let i = 0; i < segment.length; i++) {
		const msg = segment[i];
		if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) {
			continue;
		}

		const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id));
		const toolResults: AssistantRound['toolResults'] = [];

		// Collect subsequent tool result messages that match this assistant's tool_call ids
		for (let j = i + 1; j < segment.length; j++) {
			const candidate = segment[j];
			if (candidate.role === 'tool' && candidate.tool_call_id && toolCallIds.has(candidate.tool_call_id)) {
				toolResults.push({ idx: j, msg: candidate });
				toolCallIds.delete(candidate.tool_call_id);
				if (toolCallIds.size === 0) break;
			} else if (candidate.role === 'assistant') {
				break; // next assistant round — stop collecting
			}
		}

		// Compute signatures — one per tool_call
		const signatures: string[] = [];
		for (const tc of msg.tool_calls) {
			const resultMsg = toolResults.find(r => r.msg.tool_call_id === tc.id);
			const resultText = resultMsg ? getMessageText(resultMsg.msg) : '';
			signatures.push(computeSignature(tc, resultText));
		}

		rounds.push({
			assistantIdx: i,
			assistantMsg: msg,
			toolResults,
			signatures,
		});
	}

	return rounds;
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

/**
 * Detect a tool-call loop in one segment's assistant rounds.
 *
 * - Uses the last `windowSize` rounds for trigger detection (signature count >= 3).
 * - Counts cycle-member occurrences across ALL rounds in the segment for escalation.
 * - Returns null if no loop is found.
 */
export function checkForLoop(
	allRounds: AssistantRound[],
	windowSize: number = 9
): LoopDetection | null {
	if (allRounds.length === 0) return null;

	// Window = last windowSize rounds
	const windowStart = Math.max(0, allRounds.length - windowSize);
	const windowRounds = allRounds.slice(windowStart);

	// Count signatures in window
	const windowCounts = new Map<string, number>();
	for (const round of windowRounds) {
		for (const sig of round.signatures) {
			windowCounts.set(sig, (windowCounts.get(sig) ?? 0) + 1);
		}
	}

	// Find trigger: first signature with count >= 3 (by highest count, then first seen)
	let triggerSig: string | null = null;
	let triggerCount = 0;
	windowCounts.forEach((count, sig) => {
		if (count >= 3 && count > triggerCount) {
			triggerSig = sig;
			triggerCount = count;
		}
	});
	if (!triggerSig) return null;

	// Find the first occurrence of the trigger in the window
	let firstTriggerWindowIdx = 0;
	for (let i = 0; i < windowRounds.length; i++) {
		if (windowRounds[i].signatures.includes(triggerSig)) {
			firstTriggerWindowIdx = i;
			break;
		}
	}

	// Collect all signatures in the range [firstTrigger..end] with count >= 2
	const rangeSignatures = new Map<string, number>();
	for (let i = firstTriggerWindowIdx; i < windowRounds.length; i++) {
		for (const sig of windowRounds[i].signatures) {
			rangeSignatures.set(sig, (rangeSignatures.get(sig) ?? 0) + 1);
		}
	}

	const cycleMemberSigs = new Set<string>();
	rangeSignatures.forEach((count, sig) => {
		if (count >= 2) {
			cycleMemberSigs.add(sig);
		}
	});

	// Ensure the trigger is included
	cycleMemberSigs.add(triggerSig);

	// Count cycle-member occurrences across ALL rounds in the segment (for escalation)
	const totalCounts = new Map<string, number>();
	for (const round of allRounds) {
		for (const sig of round.signatures) {
			if (cycleMemberSigs.has(sig)) {
				totalCounts.set(sig, (totalCounts.get(sig) ?? 0) + 1);
			}
		}
	}

	// Build CycleMember objects — stash raw args/result from first-seen occurrence in window
	const cycleMembers: CycleMember[] = [];
	const seenSigs = new Set<string>();

	for (let i = firstTriggerWindowIdx; i < windowRounds.length; i++) {
		const round = windowRounds[i];
		for (let j = 0; j < round.signatures.length; j++) {
			const sig = round.signatures[j];
			if (!cycleMemberSigs.has(sig) || seenSigs.has(sig)) continue;
			seenSigs.add(sig);

			const tc = round.assistantMsg.tool_calls![j];
			const resultMsg = round.toolResults.find(r => r.msg.tool_call_id === tc.id);
			const resultText = resultMsg ? getMessageText(resultMsg.msg) : '';

			cycleMembers.push({
				signature: sig,
				toolName: tc.function.name,
				args: tc.function.arguments,
				result: resultText,
				windowCount: windowCounts.get(sig) ?? 0,
				totalCount: totalCounts.get(sig) ?? 0,
				firstSeenRound: windowStart + i,
			});
		}
	}

	// Check if loop is active at end (last round has at least one cycle-member tool call)
	const lastRound = allRounds[allRounds.length - 1];
	const activeAtEnd = lastRound.signatures.some(sig => cycleMemberSigs.has(sig));

	// Check for non-cycle-member tool calls in range
	let hasNonCycleMembers = false;
	for (let i = firstTriggerWindowIdx; i < windowRounds.length; i++) {
		if (windowRounds[i].signatures.some(sig => !cycleMemberSigs.has(sig))) {
			hasNonCycleMembers = true;
			break;
		}
	}

	// Collect tools to filter (escalation count >= 6 AND loop active at end)
	const toolsToFilter: string[] = [];
	if (activeAtEnd) {
		const filteredNames = new Set<string>();
		for (const member of cycleMembers) {
			if (member.totalCount >= 6 && !filteredNames.has(member.toolName)) {
				filteredNames.add(member.toolName);
				toolsToFilter.push(member.toolName);
			}
		}
	}

	return {
		trigger: triggerSig,
		cycleMembers,
		toolsToFilter,
		hasNonCycleMembers,
	};
}

// ---------------------------------------------------------------------------
// Summary building
// ---------------------------------------------------------------------------

/**
 * Truncate a tool-call arguments JSON string for display in the loop summary.
 */
export function truncateArgs(argsJson: string, maxLen: number = 80): string {
	if (argsJson.length <= maxLen) return argsJson;

	try {
		const parsed = JSON.parse(argsJson);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			const truncated: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === 'string' && value.length > 40) {
					truncated[key] = value.slice(0, 37) + '...';
				} else {
					truncated[key] = value;
				}
			}
			const result = JSON.stringify(truncated);
			if (result.length <= maxLen) return result;
			return result.slice(0, maxLen - 3) + '...';
		}
	} catch {
		// fall through to hard truncate
	}

	return argsJson.slice(0, maxLen - 3) + '...';
}

/**
 * Truncate a tool result string for display in the loop summary.
 * Newlines are replaced with literal \n so the summary stays compact.
 */
export function truncateResult(result: string, maxLen: number = 120): string {
	const escaped = result.replace(/\n/g, '\\n');
	if (escaped.length <= maxLen) return escaped;
	return escaped.slice(0, maxLen - 3) + '...';
}

/**
 * Build the full loop summary text for the first synthetic tool result.
 */
export function buildLoopSummary(detection: LoopDetection): string {
	const sorted = [...detection.cycleMembers].sort((a, b) => a.firstSeenRound - b.firstSeenRound);
	const maxCount = Math.max(...sorted.map(m => m.windowCount));
	const memberCount = sorted.length;

	const lines: string[] = [];

	// 1. Header
	lines.push(`[LOOP DETECTED — ${maxCount} repetitions, cycle of ${memberCount} tool calls collapsed]`);
	lines.push('');

	// 2. Cycle member table
	lines.push('Cycle members:');
	for (const member of sorted) {
		lines.push(`  ${member.toolName}(${truncateArgs(member.args)}) x${member.windowCount}`);
		lines.push(`    -> ${truncateResult(member.result)}`);
	}
	lines.push('');

	// 3. Non-member note (only if applicable)
	if (detection.hasNonCycleMembers) {
		lines.push('Non-cycle calls in this range were preserved in the history above.');
		lines.push('');
	}

	// 4. Diagnosis
	lines.push('Each call above returned the same result every time. Retrying will not change the outcome.');
	lines.push('');

	// 5. Directive
	lines.push('Do NOT retry any of these tool calls with the same arguments. Change strategy:');
	lines.push('- Use a different tool or significantly different arguments');
	lines.push('- Search the codebase for alternative approaches');
	lines.push('- Explain what is blocking you and ask the user for guidance');

	// 5b. Tool filtering note
	if (detection.toolsToFilter.length > 0) {
		lines.push('');
		lines.push(`The following tools have been temporarily removed and cannot be called: ${detection.toolsToFilter.join(', ')}.`);
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Prune and summarize a single segment's messages based on a loop detection.
 * Returns a NEW array — never mutates the input.
 */
export function pruneAndSummarize(
	segment: OpenAIChatMessage[],
	detection: LoopDetection,
	rounds: AssistantRound[]
): OpenAIChatMessage[] {
	const cycleSigs = new Set(detection.cycleMembers.map(m => m.signature));

	// Build maps: signature -> first-seen round index, signature -> last-occurrence round index
	const firstSeenRound = new Map<string, number>();
	const lastOccurrenceRound = new Map<string, number>();

	for (let i = 0; i < rounds.length; i++) {
		for (const sig of rounds[i].signatures) {
			if (!cycleSigs.has(sig)) continue;
			if (!firstSeenRound.has(sig)) {
				firstSeenRound.set(sig, i);
			}
			lastOccurrenceRound.set(sig, i);
		}
	}

	// Determine the cycle range (first trigger to end)
	const triggerMember = detection.cycleMembers.find(m => m.signature === detection.trigger);
	const cycleStartRound = triggerMember
		? rounds.findIndex(r => r.signatures.includes(detection.trigger))
		: 0;

	// Classify each round
	const roundsToRemove = new Set<number>();
	const roundsToReplace = new Set<number>(); // last-occurrence rounds

	for (let i = cycleStartRound; i < rounds.length; i++) {
		const round = rounds[i];
		const roundSigs = round.signatures;

		// Is this round the first-seen for any cycle member?
		const isFirstSeen = roundSigs.some(sig => cycleSigs.has(sig) && firstSeenRound.get(sig) === i);
		// Is this round the last-occurrence for any cycle member?
		const isLastOccurrence = roundSigs.some(sig => cycleSigs.has(sig) && lastOccurrenceRound.get(sig) === i);
		// Are ALL tool calls in this round cycle members?
		const allCycleMembers = roundSigs.every(sig => cycleSigs.has(sig));
		// Are all cycle-member sigs in this round already first-seen at an earlier round?
		const allAlreadyFirstSeen = roundSigs
			.filter(sig => cycleSigs.has(sig))
			.every(sig => firstSeenRound.get(sig)! < i);

		if (isLastOccurrence) {
			// Last-occurrence: keep assistant, replace cycle-member results
			roundsToReplace.add(i);
		} else if (isFirstSeen) {
			// First-seen: keep fully intact (do nothing)
		} else if (allCycleMembers && allAlreadyFirstSeen) {
			// Intermediate duplicate: remove entirely
			roundsToRemove.add(i);
		}
		// Non-cycle-member rounds that aren't last-occurrence: keep intact (do nothing)
	}

	// Build the summary text
	const summaryText = buildLoopSummary(detection);

	// Collect message indices to remove and to replace
	const indicesToRemove = new Set<number>();
	roundsToRemove.forEach(ri => {
		const round = rounds[ri];
		indicesToRemove.add(round.assistantIdx);
		for (const tr of round.toolResults) {
			indicesToRemove.add(tr.idx);
		}
	});

	// Map of message index -> replacement content (for tool result messages in last-occurrence rounds)
	const replacements = new Map<number, string>();
	let firstReplacedCallId: string | null = null;

	for (const ri of Array.from(roundsToReplace).sort((a, b) => a - b)) {
		const round = rounds[ri];
		for (let j = 0; j < round.signatures.length; j++) {
			const sig = round.signatures[j];
			if (!cycleSigs.has(sig)) continue;
			// Only replace if this round IS the last-occurrence for this specific signature
			if (lastOccurrenceRound.get(sig) !== ri) continue;

			const tc = round.assistantMsg.tool_calls![j];
			const resultEntry = round.toolResults.find(r => r.msg.tool_call_id === tc.id);
			if (!resultEntry) continue;

			if (firstReplacedCallId === null) {
				// First replacement gets full summary
				replacements.set(resultEntry.idx, summaryText);
				firstReplacedCallId = tc.id;
			} else {
				// Subsequent replacements get back-reference
				replacements.set(
					resultEntry.idx,
					`[LOOP DETECTED] This tool call is part of the same repeating cycle described in the result for ${firstReplacedCallId}. Do not retry.`
				);
			}
		}
	}

	// Build new message array
	const result: OpenAIChatMessage[] = [];
	for (let i = 0; i < segment.length; i++) {
		if (indicesToRemove.has(i)) continue;

		const replacement = replacements.get(i);
		if (replacement !== undefined) {
			result.push({
				...segment[i],
				content: replacement,
			});
		} else {
			result.push(segment[i]);
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Process loop detection across the entire message history.
 *
 * Splits messages into segments at role:user / role:system boundaries, detects and
 * prunes loops in each segment independently, then reassembles.
 *
 * Returns a new message array (never mutates input) and the detection from the
 * last segment (which drives tool filtering).
 */
export function processLoopDetection(messages: OpenAIChatMessage[]): LoopDetectionResult {
	const { parts } = splitSegments(messages);

	let lastDetection: LoopDetection | null = null;
	const outputMessages: OpenAIChatMessage[] = [];

	for (const part of parts) {
		if (part.type === 'boundary') {
			outputMessages.push(part.msg);
			lastDetection = null; // new boundary resets which detection drives filtering
			continue;
		}

		// Process this segment
		const rounds = extractAssistantRounds(part.messages);
		const detection = checkForLoop(rounds);

		if (detection) {
			const pruned = pruneAndSummarize(part.messages, detection, rounds);
			outputMessages.push(...pruned);
			lastDetection = detection;
		} else {
			outputMessages.push(...part.messages);
			lastDetection = null;
		}
	}

	return { messages: outputMessages, lastDetection };
}
