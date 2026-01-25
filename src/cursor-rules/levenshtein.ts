/**
 * Calculate Levenshtein distance between two strings (case-insensitive)
 * @param str1 First string
 * @param str2 Second string
 * @returns The Levenshtein distance
 */
export function levenshteinDistance(str1: string, str2: string): number {
	const s1 = str1.toLowerCase();
	const s2 = str2.toLowerCase();
	const len1 = s1.length;
	const len2 = s2.length;

	// Create a matrix
	const matrix: number[][] = [];

	// Initialize first row and column
	for (let i = 0; i <= len1; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= len2; j++) {
		matrix[0][j] = j;
	}

	// Fill the matrix
	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			if (s1[i - 1] === s2[j - 1]) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j] + 1,     // deletion
					matrix[i][j - 1] + 1,     // insertion
					matrix[i - 1][j - 1] + 1  // substitution
				);
			}
		}
	}

	return matrix[len1][len2];
}

/**
 * Find the closest matching string from a list using Levenshtein distance
 * @param target Target string to match
 * @param candidates List of candidate strings
 * @param maxDistance Maximum allowed distance (default: 8)
 * @returns The closest match or null if no match within maxDistance
 */
export function findClosestMatch(
	target: string,
	candidates: string[],
	maxDistance: number = 8
): string | null {
	let closest: string | null = null;
	let minDistance = maxDistance + 1;

	for (const candidate of candidates) {
		const distance = levenshteinDistance(target, candidate);
		if (distance < minDistance) {
			minDistance = distance;
			closest = candidate;
		}
	}

	return closest;
}
