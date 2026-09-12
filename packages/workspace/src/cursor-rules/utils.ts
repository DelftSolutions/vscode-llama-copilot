/**
 * Normalize a rule name by trimming and stripping the optional "rule:" prefix.
 * Used when the model or user passes rule identifiers that may include the prefix.
 */
export function normalizeRuleName(name: string): string {
	return name.trim().replace(/^rule:/, '').trim();
}
