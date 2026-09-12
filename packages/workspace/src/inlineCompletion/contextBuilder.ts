import * as vscode from 'vscode';

const MIN_SUFFIX_BYTES = 4096;

/**
 * Truncate a string to at most maxBytes UTF-8 bytes (from the end).
 * Returns the substring that fits.
 */
function truncateToByteLength(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	const buf = Buffer.from(str, 'utf8');
	if (buf.length <= maxBytes) return str;
	// Find the character boundary at or before maxBytes
	let len = maxBytes;
	while (len > 0 && (buf[len] & 0xc0) === 0x80) {
		len--;
	}
	return Buffer.from(buf.subarray(0, len)).toString('utf8');
}

/**
 * Truncate a string to at most maxBytes UTF-8 bytes (from the start).
 * Returns the substring that fits (keeping the tail).
 */
function truncateStartToByteLength(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	const buf = Buffer.from(str, 'utf8');
	if (buf.length <= maxBytes) return str;
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}
	return Buffer.from(buf.subarray(start)).toString('utf8');
}

function byteLength(str: string): number {
	return Buffer.byteLength(str, 'utf8');
}

export interface InfillContextResult {
	input_prefix: string;
	input_suffix: string;
	input_extra: Array<{ text: string; filename: string }>;
}

/**
 * Build prefix, suffix, and optional input_extra for the /infill endpoint.
 * Ensures total size is at most maxInputBytes; suffix is at least MIN_SUFFIX_BYTES when truncated.
 * Current document must not be included in input_extra.
 */
export function buildInfillContext(
	document: vscode.TextDocument,
	position: vscode.Position,
	maxInputBytes: number,
	otherFiles?: Array<{ filename: string; text: string }>
): InfillContextResult {
	const fullText = document.getText();
	const offset = document.offsetAt(position);
	let prefix = fullText.slice(0, offset);
	let suffix = fullText.slice(offset);

	let prefixBytes = byteLength(prefix);
	let suffixBytes = byteLength(suffix);

	// If over limit, first ensure suffix is at least MIN_SUFFIX_BYTES by truncating it to that size,
	// then shrink prefix if still over limit.
	if (prefixBytes + suffixBytes > maxInputBytes) {
		suffix = truncateToByteLength(suffix, Math.max(MIN_SUFFIX_BYTES, maxInputBytes - prefixBytes));
		suffixBytes = byteLength(suffix);
		if (prefixBytes + suffixBytes > maxInputBytes) {
			prefix = truncateStartToByteLength(prefix, maxInputBytes - suffixBytes);
			prefixBytes = byteLength(prefix);
		}
	}

	let budget = maxInputBytes - prefixBytes - suffixBytes;
	const input_extra: Array<{ text: string; filename: string }> = [];

	if (otherFiles && budget > 0) {
		for (const { filename, text } of otherFiles) {
			if (budget <= 0) break;
			const textBytes = byteLength(text);
			if (textBytes <= budget) {
				input_extra.push({ filename, text });
				budget -= textBytes;
			} else {
				const truncated = truncateToByteLength(text, budget);
				if (truncated.length > 0) {
					input_extra.push({ filename, text: truncated });
					budget = 0;
				}
				break;
			}
		}
	}

	return {
		input_prefix: prefix,
		input_suffix: suffix,
		input_extra,
	};
}
