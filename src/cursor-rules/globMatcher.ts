/**
 * Convert a glob pattern to a regex pattern
 * Handles both Windows and Unix path separators
 * 
 * @param glob Glob pattern
 * @returns Regex pattern
 */
export function globToRegex(glob: string): RegExp {
	// Normalize path separators - convert backslashes to forward slashes
	let normalized = glob.replace(/\\/g, '/');
	
	// Escape special regex characters except *, ?, [, ]
	let escaped = normalized.replace(/[.+^${}()|]/g, '\\$&');
	
	// Convert ** to match any characters including slashes
	escaped = escaped.replace(/\*\*/g, '[a-zA-Z0-9.~@+=_|\\/-]*');
	
	// Convert * to match any characters except slashes
	escaped = escaped.replace(/\*/g, '[a-zA-Z0-9.~@+=_|-]*');
	
	// Convert ? to match single character except slash
	escaped = escaped.replace(/\?/g, '[a-zA-Z0-9.~@+=_|-]');
	
	// Handle character classes [...] - keep them as-is but ensure they work with both separators
	// Note: Character classes are already escaped above, so we need to handle them specially
	// We'll match them and ensure they can match both / and \
	const charClassPattern = /\[([^\]]+)\]/g;
	escaped = escaped.replace(charClassPattern, (match, content) => {
		// If the character class doesn't already include / or \, add them
		if (!content.includes('/') && !content.includes('\\')) {
			// Don't modify - let it match as specified
			return match;
		}
		return match;
	});
	
	// Anchor to start and end
	return new RegExp(`^${escaped}$`);
}

/**
 * Check if a path matches a glob pattern
 * @param path Path to check (can be relative or absolute)
 * @param glob Glob pattern
 * @returns True if path matches the glob
 */
export function matchesGlob(path: string, glob: string): boolean {
	// Normalize the path - convert backslashes to forward slashes
	const normalizedPath = path.replace(/\\/g, '/');
	const regex = globToRegex(glob);
	return regex.test(normalizedPath);
}

/**
 * Extract filename from attachment reference (e.g., "@src/logger.ts:32" -> "src/logger.ts")
 * @param attachment Attachment reference string
 * @returns File path or null if invalid
 */
export function extractFilePathFromAttachment(attachment: string): string | null {
	// Match @path:line or @path
	const match = attachment.match(/^@([^:]+)/);
	return match ? match[1] : null;
}

/**
 * Check if any glob patterns match a given path
 * @param path Path to check
 * @param globs Array of glob patterns
 * @returns True if any glob matches
 */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
	return globs.some(glob => matchesGlob(path, glob));
}
