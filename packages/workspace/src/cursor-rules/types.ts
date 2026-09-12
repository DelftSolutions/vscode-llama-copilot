/**
 * Rule metadata extracted from frontmatter
 */
export interface RuleMetadata {
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
}

/**
 * Parsed rule file
 */
export interface ParsedRule {
	/** Relative path from .cursor/rules/ (e.g., "coding-guidelines.md" or "style/markdown.mdc") */
	path: string;
	/** Rule name without extension (e.g., "coding-guidelines") */
	name: string;
	/** Full file name (e.g., "coding-guidelines.md") */
	fileName: string;
	/** Metadata from frontmatter */
	metadata: RuleMetadata;
	/** Rule content (without frontmatter) */
	content: string;
	/** Compiled regex patterns from globs */
	regexPatterns?: RegExp[];
}

/**
 * Session identifier for tracking rules per conversation
 */
export interface SessionId {
	/** Hash of first user message + model ID */
	hash: string;
}
