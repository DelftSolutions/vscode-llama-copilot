import * as vscode from 'vscode';
import { requestInfill } from '../llamaClient';
import { buildInfillContext } from './contextBuilder';
import { EndpointsConfig } from '../types';
import { parseModelId, getEndpointConfig, getMergedModelConfig } from '../modelInfo';
import {
	getInlineCompletionModel,
	getInlineCompletionTimeoutMs,
	getInlineCompletionDebounceMs,
	getInlineCompletionMaxInputBytes,
	isInlineCompletionContextEnabled,
	isDebugEnabled,
	DEBUG_INLINE_COMPLETION,
} from '../config';
import { logDebug } from '../logger';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	constructor(private readonly endpoints: EndpointsConfig) {}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const triggerKind = context.triggerKind;
		if (triggerKind !== vscode.InlineCompletionTriggerKind.Automatic && triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
			return undefined;
		}

		const modelId = getInlineCompletionModel();
		if (!modelId) {
			return undefined;
		}

		const doRequest = async (): Promise<vscode.InlineCompletionItem[] | undefined> => {
			if (token.isCancellationRequested) return undefined;

			const { baseModelId, endpointId } = parseModelId(modelId);
			if (!endpointId) {
				if (isDebugEnabled(DEBUG_INLINE_COMPLETION)) {
					logDebug(DEBUG_INLINE_COMPLETION, 'Inline completion: model must include endpoint (e.g. model@local)', { modelId });
				}
				return undefined;
			}

			let endpointConfig;
			try {
				endpointConfig = getEndpointConfig(this.endpoints, endpointId);
			} catch (e) {
				if (isDebugEnabled(DEBUG_INLINE_COMPLETION)) {
					logDebug(DEBUG_INLINE_COMPLETION, 'Inline completion: endpoint not found', { endpointId, error: String(e) });
				}
				return undefined;
			}

			const { headers: mergedHeaders, requestBody: mergedRequestBody } = getMergedModelConfig(
				this.endpoints,
				endpointId,
				baseModelId
			);

			const maxInputBytes = getInlineCompletionMaxInputBytes();
			let otherFiles: Array<{ filename: string; text: string }> | undefined;
			if (isInlineCompletionContextEnabled()) {
				otherFiles = getOtherOpenFiles(document);
			}
			const { input_prefix, input_suffix, input_extra } = buildInfillContext(
				document,
				position,
				maxInputBytes,
				otherFiles
			);

			const controller = new AbortController();
			const timeoutMs = getInlineCompletionTimeoutMs();
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
			token.onCancellationRequested(() => controller.abort());

			if (isDebugEnabled(DEBUG_INLINE_COMPLETION)) {
				logDebug(DEBUG_INLINE_COMPLETION, 'Inline completion request', {
					triggerKind: triggerKind === vscode.InlineCompletionTriggerKind.Automatic ? 'Automatic' : 'Invoke',
					uri: document.uri.toString(),
					prefixBytes: Buffer.byteLength(input_prefix, 'utf8'),
					suffixBytes: Buffer.byteLength(input_suffix, 'utf8'),
					extraCount: input_extra.length,
				});
			}

			try {
				const content = await requestInfill(
					endpointConfig.url,
					baseModelId,
					{ input_prefix, input_suffix, input_extra: input_extra.length > 0 ? input_extra : undefined },
					timeoutMs,
					controller.signal,
					endpointConfig.apiToken,
					mergedHeaders,
					mergedRequestBody
				);
				if (token.isCancellationRequested || !content) return undefined;
				const range = new vscode.Range(position, position);
				if (isDebugEnabled(DEBUG_INLINE_COMPLETION)) {
					logDebug(DEBUG_INLINE_COMPLETION, 'Inline completion success', {
						contentLength: content.length,
						preview: content.length > 100 ? content.slice(0, 100) + '...' : content,
					});
				}
				return [new vscode.InlineCompletionItem(content, range)];
			} catch (err) {
				if (isDebugEnabled(DEBUG_INLINE_COMPLETION)) {
					const msg = err instanceof Error ? err.message : String(err);
					const isAbort = err instanceof Error && err.name === 'AbortError';
					logDebug(DEBUG_INLINE_COMPLETION, isAbort ? 'Inline completion cancelled or timeout' : 'Inline completion error', {
						error: msg,
					});
				}
				return undefined;
			} finally {
				clearTimeout(timeoutId);
			}
		};

		if (triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
			const debounceMs = getInlineCompletionDebounceMs();
			return new Promise<vscode.InlineCompletionItem[] | undefined>((resolve) => {
				const timerId = setTimeout(() => {
					doRequest().then(resolve);
				}, debounceMs);
				token.onCancellationRequested(() => {
					clearTimeout(timerId);
					resolve(undefined);
				});
			});
		}

		return doRequest();
	}
}

function getOtherOpenFiles(currentDocument: vscode.TextDocument): Array<{ filename: string; text: string }> {
	const result: Array<{ filename: string; text: string }> = [];
	const currentUri = currentDocument.uri.toString();
	for (const editor of vscode.window.visibleTextEditors) {
		const doc = editor.document;
		if (doc.uri.toString() === currentUri) continue;
		if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') continue;
		const filename = vscode.workspace.asRelativePath(doc.uri, false);
		result.push({ filename, text: doc.getText() });
	}
	return result;
}
