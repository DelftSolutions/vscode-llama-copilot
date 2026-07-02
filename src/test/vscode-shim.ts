/**
 * Minimal stub for running unit tests under Vitest (no VS Code host).
 * Real builds use the embedded vscode typings from @types/vscode at compile time only.
 */

export const workspace = {
	getConfiguration(_section?: string) {
		return {
			get<T>(_key: string, defaultValue?: T): T {
				return defaultValue as T;
			},
		};
	},
};

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
}

export class LanguageModelToolCallPart {
	constructor(
		public callId: string,
		public name: string,
		public input: object
	) {}
}

export class LanguageModelToolResultPart {
	constructor(
		public callId: string,
		public content: unknown[]
	) {}
}

export class LanguageModelTextPart {
	constructor(public value: string) {}
}

export class LanguageModelThinkingPart {
	constructor(
		public value: string | string[],
		public id?: string,
		public metadata?: Record<string, unknown>
	) {}
}

export class LanguageModelDataPart {
	static image(data: Uint8Array, mime: string): LanguageModelDataPart {
		return new LanguageModelDataPart(data, mime);
	}
	static json(value: unknown, mime?: string): LanguageModelDataPart {
		const json = JSON.stringify(value);
		return new LanguageModelDataPart(new TextEncoder().encode(json), mime ?? 'application/json');
	}
	static text(value: string, mime?: string): LanguageModelDataPart {
		return new LanguageModelDataPart(new TextEncoder().encode(value), mime ?? 'text/plain');
	}
	constructor(
		public data: Uint8Array,
		public mimeType: string
	) {}
}

export class LanguageModelPromptTsxPart {
	constructor(public value: unknown) {}
}

export enum LanguageModelChatToolMode {
	Auto = 1,
	Required = 2,
}

export class LanguageModelChatMessage {
	static User(content: string | unknown[]): LanguageModelChatMessage {
		const c = Array.isArray(content) ? content : [content];
		return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, c);
	}

	static Assistant(content: string | unknown[]): LanguageModelChatMessage {
		const c = Array.isArray(content) ? content : [content];
		return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, c);
	}

	name: string | undefined = undefined;

	constructor(
		public role: LanguageModelChatMessageRole,
		public content: unknown[]
	) {}
}

export type LanguageModelChatRequestMessage = LanguageModelChatMessage;

export type PrepareLanguageModelChatModelOptions = { silent: boolean };

export type Memento = unknown;
