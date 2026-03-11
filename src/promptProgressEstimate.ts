/** Do not show status bar before this many ms of prompt processing have elapsed. */
export const MIN_ELAPSED_MS = 10_000;

export interface PromptProgressInput {
	total: number;
	processed: number;
	time_ms: number;
}

export interface PromptProgressEstimateResult {
	showStatusBar: boolean;
	remainingMs: number | undefined;
	percent: number | undefined;
}

/**
 * Estimate remaining prompt processing time using quadratic scaling (time ∝ processed²).
 * Returns whether to show the status bar, remaining ms, and a quadratic-corrected display percent.
 * Status bar is shown only when at least MIN_ELAPSED_MS have passed and estimated remaining >= threshold.
 */
export function estimatePromptProgress(
	input: PromptProgressInput,
	thresholdSeconds: number
): PromptProgressEstimateResult {
	if (thresholdSeconds <= 0) {
		return { showStatusBar: false, remainingMs: undefined, percent: undefined };
	}
	if (input.time_ms < MIN_ELAPSED_MS) {
		return { showStatusBar: false, remainingMs: undefined, percent: undefined };
	}
	if (input.total <= 0 || input.processed < 1) {
		return { showStatusBar: false, remainingMs: undefined, percent: undefined };
	}

	const { total, processed, time_ms } = input;
	const pSq = processed * processed;
	const remainingMs = (time_ms * (total * total - pSq)) / pSq;
	const showStatusBar = remainingMs >= thresholdSeconds * 1000;

	// Quadratic percentage so the bar advances roughly linearly in time
	const percent =
		total > 0 && processed > 0
			? Math.min(99, Math.round(100 * (processed * processed) / (total * total)))
			: undefined;

	return { showStatusBar, remainingMs, percent };
}

/**
 * Format remaining milliseconds for status bar message (e.g. "2 min" or "45 s").
 */
export function formatRemaining(remainingMs: number): string {
	if (remainingMs >= 60_000) {
		const min = Math.round(remainingMs / 60_000);
		return min === 1 ? '1 min' : `${min} min`;
	}
	const sec = Math.round(remainingMs / 1000);
	return sec <= 1 ? '1 s' : `${sec} s`;
}
