import * as vscode from 'vscode';
import {
	getSmtpToolEmailSettings,
	parseSmtpRecipients,
	MEMENTO_SMTP_EMAILED_CALL_IDS,
	type SmtpToolEmailSettings,
} from './config';
import { logSmtp } from './logger';
import { sendMailWithSettings } from './smtpMail';

/** Maximum stored call IDs for deduplication (FIFO trim). */
const MAX_DEDUPE_IDS = 5000;

export interface ToolResultEmailItem {
	readonly callId: string;
	readonly toolName: string;
	readonly body: string;
}

function isToolCallPart(p: unknown): p is { callId: string; name: string } {
	return (
		typeof p === 'object' &&
		p !== null &&
		'callId' in p &&
		'name' in p &&
		typeof (p as { callId: unknown }).callId === 'string' &&
		typeof (p as { name: unknown }).name === 'string'
	);
}

function isToolResultPart(p: unknown): p is { callId: string; content: readonly unknown[] } {
	return (
		typeof p === 'object' &&
		p !== null &&
		'callId' in p &&
		'content' in p &&
		typeof (p as { callId: unknown }).callId === 'string' &&
		Array.isArray((p as { content: unknown }).content)
	);
}

/**
 * Walk assistant messages and record each tool call id → tool name (later entries override).
 */
export function buildCallIdToToolNameMap(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of msg.content) {
			if (isToolCallPart(part)) {
				map.set(part.callId, part.name);
			}
		}
	}
	return map;
}

export function toolNameMatchesWatchlist(
	toolName: string | undefined,
	watchlist: readonly string[]
): boolean {
	if (!toolName) {
		return false;
	}
	return watchlist.includes(toolName);
}

/**
 * Flatten tool result content to text (text parts + JSON fallback), then truncate.
 */
export function serializeToolResultContent(content: readonly unknown[], maxChars: number): string {
	const chunks: string[] = [];
	for (const part of content) {
		if (
			part !== null &&
			typeof part === 'object' &&
			'value' in part &&
			typeof (part as { value: unknown }).value === 'string'
		) {
			chunks.push((part as { value: string }).value);
		} else {
			try {
				chunks.push(JSON.stringify(part));
			} catch {
				chunks.push(String(part));
			}
		}
	}
	let text = chunks.join('');
	if (text.length > maxChars) {
		text =
			text.slice(0, maxChars) +
			`\n\n[… truncated to ${maxChars} characters …]`;
	}
	return text;
}

/**
 * Build email rows for tool results whose names appear in the configured watchlist.
 */
export function collectToolResultEmailItems(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	settings: Pick<SmtpToolEmailSettings, 'toolNames' | 'maxBodyChars'>
): ToolResultEmailItem[] {
	const map = buildCallIdToToolNameMap(messages);
	const items: ToolResultEmailItem[] = [];
	for (const msg of messages) {
		if (msg.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		for (const part of msg.content) {
			if (!isToolResultPart(part)) {
				continue;
			}
			const toolName = map.get(part.callId);
			if (!toolNameMatchesWatchlist(toolName, settings.toolNames)) {
				continue;
			}
			const body = serializeToolResultContent(part.content, settings.maxBodyChars);
			items.push({
				callId: part.callId,
				toolName: toolName!,
				body,
			});
		}
	}
	return items;
}

async function loadDedupeSet(memento: vscode.Memento): Promise<Set<string>> {
	const arr = memento.get<string[]>(MEMENTO_SMTP_EMAILED_CALL_IDS, []);
	return new Set(arr);
}

async function persistDedupe(memento: vscode.Memento, set: Set<string>): Promise<void> {
	let arr = [...set];
	if (arr.length > MAX_DEDUPE_IDS) {
		arr = arr.slice(-MAX_DEDUPE_IDS);
	}
	await memento.update(MEMENTO_SMTP_EMAILED_CALL_IDS, arr);
}

async function processToolResultEmails(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	globalState: vscode.Memento
): Promise<void> {
	const settings = getSmtpToolEmailSettings();
	if (!settings.enabled) {
		return;
	}
	const recipients = parseSmtpRecipients(settings.toRaw);
	if (!settings.host || !settings.from || recipients.length === 0) {
		return;
	}
	if (!Number.isFinite(settings.port) || settings.port <= 0) {
		return;
	}

	const items = collectToolResultEmailItems(messages, settings);
	if (items.length === 0) {
		return;
	}

	const dedupe = await loadDedupeSet(globalState);

	for (const item of items) {
		if (dedupe.has(item.callId)) {
			continue;
		}
		try {
			const subject = `${settings.subjectPrefix} ${item.toolName} (${item.callId})`;
			const text = `Tool: ${item.toolName}\nCall ID: ${item.callId}\n\n${item.body}`;
			await sendMailWithSettings(settings, {
				to: recipients,
				subject,
				text,
			});
			dedupe.add(item.callId);
			await persistDedupe(globalState, dedupe);
			logSmtp(
				`Sent tool result email for ${item.toolName} (callId=${item.callId}) via ${settings.host}:${settings.port}.`
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logSmtp(`Failed to send tool result email for ${item.toolName} (callId=${item.callId}): ${msg}`);
		}
	}
}

/**
 * Queue asynchronous SMTP notifications for matching tool results (non-blocking for the language model).
 */
export function queueToolResultEmailsForMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	globalState: vscode.Memento | undefined
): void {
	if (!globalState) {
		return;
	}
	void processToolResultEmails(messages, globalState).catch((e) => {
		logSmtp(`SMTP queue error: ${e instanceof Error ? e.message : String(e)}`);
	});
}
