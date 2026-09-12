/**
 * Persistence + step machine for the onboarding wizard state.
 * Pure: operates on a KVStore abstraction (vscode.Memento satisfies it),
 * so it is unit-testable without VS Code.
 */

/** Steps the wizard can be paused on (resume points). */
export type OnboardingStep = 'mode' | 'downloading' | 'model' | 'starting' | 'remote' | 'remote_done';

/** Terminal: done (setup complete or user chose bring-your-own), skipped (explicit "not now"). */
export type OnboardingStatus = 'in_progress' | 'done' | 'skipped';

export type OnboardingMode = 'managed' | 'advanced';

export interface OnboardingData {
	status: OnboardingStatus;
	step: OnboardingStep;
	mode?: OnboardingMode;
	presetId?: string;
}

/**
 * Storage abstraction satisfied by vscode.ExtensionContext.globalState.
 */
export interface KVStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): unknown;
}

export const ONBOARDING_STORAGE_KEY = 'llamaCopilot.onboarding';

const VALID_STEPS: readonly string[] = ['mode', 'downloading', 'model', 'starting', 'remote', 'remote_done'];

export function isValidStep(value: unknown): value is OnboardingStep {
	return typeof value === 'string' && VALID_STEPS.includes(value);
}

/**
 * Load and validate persisted onboarding state.
 * Returns null when absent or corrupted (corrupted → treated as fresh install).
 */
export async function loadOnboardingState(store: KVStore): Promise<OnboardingData | null> {
	const raw = store.get<OnboardingData>(ONBOARDING_STORAGE_KEY);
	if (!raw || typeof raw !== 'object') return null;

	if (raw.status !== 'in_progress' && raw.status !== 'done' && raw.status !== 'skipped') {
		return null;
	}
	if (!isValidStep(raw.step)) return null;

	const data: OnboardingData = { status: raw.status, step: raw.step };
	if (raw.mode === 'managed' || raw.mode === 'advanced') data.mode = raw.mode;
	if (typeof raw.presetId === 'string' && raw.presetId) data.presetId = raw.presetId;
	return data;
}

export async function saveOnboardingState(store: KVStore, data: OnboardingData): Promise<void> {
	await store.update(ONBOARDING_STORAGE_KEY, data);
}

/**
 * The step to auto-resume on next launch, or null when the wizard must not
 * auto-open:
 * - done / skipped → never auto-open (skip is an explicit user choice).
 * - in_progress → resume at the saved step.
 */
export function getResumeStep(data: OnboardingData | null): OnboardingStep | null {
	if (!data || data.status !== 'in_progress') return null;
	return data.step;
}

/** Fresh in-progress onboarding state. */
export function freshOnboardingData(step: OnboardingStep = 'mode'): OnboardingData {
	return { status: 'in_progress', step };
}
