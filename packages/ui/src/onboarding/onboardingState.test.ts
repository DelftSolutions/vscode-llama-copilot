import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadOnboardingState,
	saveOnboardingState,
	getResumeStep,
	freshOnboardingData,
	isValidStep,
	ONBOARDING_STORAGE_KEY,
	type KVStore,
	type OnboardingData,
} from './onboardingState';

/** In-memory KVStore mimicking vscode.Memento. */
function createMemoryStore(initial: Record<string, unknown> = {}): KVStore {
	const map = new Map<string, unknown>(Object.entries(initial));
	return {
		get<T>(key: string): T | undefined {
			return map.get(key) as T | undefined;
		},
		update(key: string, value: unknown): void {
			map.set(key, value);
		},
	};
}

describe('onboardingState', () => {
	let store: KVStore;

	beforeEach(() => {
		store = createMemoryStore();
	});

	describe('save/load round-trip', () => {
		it('persists and reloads in-progress state', async () => {
			const data: OnboardingData = {
				status: 'in_progress',
				step: 'model',
				mode: 'managed',
				presetId: 'qwen-3.5-2b:q4-128k',
			};
			await saveOnboardingState(store, data);
			const loaded = await loadOnboardingState(store);
			expect(loaded).toEqual(data);
		});

		it('returns null when nothing was saved', async () => {
			expect(await loadOnboardingState(store)).toBeNull();
		});

		it('drops invalid mode/presetId fields on load', async () => {
			store.update(ONBOARDING_STORAGE_KEY, {
				status: 'in_progress',
				step: 'mode',
				mode: 'bogus',
				presetId: '',
			});
			const loaded = await loadOnboardingState(store);
			expect(loaded).toEqual({ status: 'in_progress', step: 'mode' });
		});
	});

	describe('corrupted state handling', () => {
		it('returns null for invalid status', async () => {
			store.update(ONBOARDING_STORAGE_KEY, { status: 'exploded', step: 'mode' });
			expect(await loadOnboardingState(store)).toBeNull();
		});

		it('returns null for invalid step', async () => {
			store.update(ONBOARDING_STORAGE_KEY, { status: 'in_progress', step: 'lunch' });
			expect(await loadOnboardingState(store)).toBeNull();
		});

		it('returns null for non-object values', async () => {
			store.update(ONBOARDING_STORAGE_KEY, 'garbage');
			expect(await loadOnboardingState(store)).toBeNull();
		});

		it('returns null for undefined', async () => {
			store.update(ONBOARDING_STORAGE_KEY, undefined);
			expect(await loadOnboardingState(store)).toBeNull();
		});
	});

	describe('getResumeStep', () => {
		it('null state → no auto-open', () => {
			expect(getResumeStep(null)).toBeNull();
		});

		it('done → no auto-open', () => {
			expect(getResumeStep({ status: 'done', step: 'starting' })).toBeNull();
		});

		it('skipped → no auto-open (explicit user choice)', () => {
			expect(getResumeStep({ status: 'skipped', step: 'mode' })).toBeNull();
		});

		it('in_progress → resume at saved step', () => {
			expect(getResumeStep({ status: 'in_progress', step: 'downloading' })).toBe('downloading');
			expect(getResumeStep({ status: 'in_progress', step: 'starting' })).toBe('starting');
		});
	});

	describe('freshOnboardingData', () => {
		it('defaults to the mode step', () => {
			expect(freshOnboardingData()).toEqual({ status: 'in_progress', step: 'mode' });
		});

		it('accepts an explicit step', () => {
			expect(freshOnboardingData('downloading')).toEqual({ status: 'in_progress', step: 'downloading' });
		});
	});

	describe('isValidStep', () => {
		it('accepts all valid steps', () => {
			expect(isValidStep('mode')).toBe(true);
			expect(isValidStep('downloading')).toBe(true);
			expect(isValidStep('model')).toBe(true);
			expect(isValidStep('starting')).toBe(true);
		});

		it('rejects unknown values', () => {
			expect(isValidStep('done')).toBe(false);
			expect(isValidStep('')).toBe(false);
			expect(isValidStep(42)).toBe(false);
			expect(isValidStep(null)).toBe(false);
		});
	});
});
