import { describe, it, expect } from 'vitest';
import {
	hasEmbeddings,
	hasVisionCapability,
	extractContextSize,
	extractParallel,
	isChatCapable,
	isSingleModelServer,
	calculateMaxOutputTokens,
	parseModelId,
} from './modelInfo';
import type { Model } from './types';

/** Helper: multi-model (router) model with status */
function routerModel(overrides: Partial<Model> = {}): Model {
	return {
		id: 'qwen3-4b',
		object: 'model',
		owned_by: 'llamacpp',
		created: 1769286032,
		status: { value: 'loaded', args: ['--ctx-size', '32768', '--jinja'] },
		...overrides,
	};
}

/** Helper: single-model server model with meta, no status */
function singleModel(overrides: Partial<Model> = {}): Model {
	return {
		id: 'Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf',
		object: 'model',
		owned_by: 'llamacpp',
		created: 1779356866,
		meta: {
			n_ctx: 256000,
			n_ctx_train: 262144,
			n_embd: 2048,
			n_params: 35505251456,
			n_vocab: 248320,
			vocab_type: 2,
			size: 22274089472,
		},
		...overrides,
	};
}

describe('hasEmbeddings', () => {
	it('returns true when --embeddings flag is present', () => {
		expect(hasEmbeddings(routerModel({ status: { value: 'loaded', args: ['--embeddings'] } }))).toBe(true);
	});

	it('returns false when --embeddings flag is absent', () => {
		expect(hasEmbeddings(routerModel())).toBe(false);
	});

	it('returns false when status is undefined (single-model)', () => {
		expect(hasEmbeddings(singleModel())).toBe(false);
	});

	it('returns false when status.args is undefined', () => {
		expect(hasEmbeddings(routerModel({ status: { value: 'loaded' } }))).toBe(false);
	});
});

describe('hasVisionCapability', () => {
	it('returns true when --image-min-tokens is present', () => {
		expect(hasVisionCapability(routerModel({ status: { value: 'loaded', args: ['--image-min-tokens', '64'] } }))).toBe(true);
	});

	it('returns false when flag is absent', () => {
		expect(hasVisionCapability(routerModel())).toBe(false);
	});

	it('returns false when status is undefined (single-model)', () => {
		expect(hasVisionCapability(singleModel())).toBe(false);
	});
});

describe('extractContextSize', () => {
	it('extracts --ctx-size from router model args', () => {
		expect(extractContextSize(routerModel())).toBe(32768);
	});

	it('falls back to meta.n_ctx for single-model', () => {
		expect(extractContextSize(singleModel())).toBe(256000);
	});

	it('prefers --ctx-size over meta.n_ctx when both present', () => {
		const model = routerModel({ meta: { n_ctx: 999999 } });
		expect(extractContextSize(model)).toBe(32768);
	});

	it('returns null when neither source is available', () => {
		const model = routerModel({ status: { value: 'loaded', args: [] } });
		delete (model as Record<string, unknown>).meta;
		expect(extractContextSize(model)).toBeNull();
	});

	it('skips --ctx-size 0 and falls back to meta', () => {
		const model: Model = {
			...routerModel({ status: { value: 'loaded', args: ['--ctx-size', '0'] } }),
			meta: { n_ctx: 131072 },
		};
		expect(extractContextSize(model)).toBe(131072);
	});

	it('returns null when meta.n_ctx is 0', () => {
		expect(extractContextSize(singleModel({ meta: { n_ctx: 0 } }))).toBeNull();
	});

	it('returns null when status is undefined and meta is undefined', () => {
		const model: Model = { id: 'test', object: 'model', owned_by: 'llamacpp', created: 0 };
		expect(extractContextSize(model)).toBeNull();
	});
});

describe('extractParallel', () => {
	it('extracts --parallel from args', () => {
		expect(extractParallel(routerModel({ status: { value: 'loaded', args: ['--parallel', '4'] } }))).toBe(4);
	});

	it('returns null when --parallel is absent', () => {
		expect(extractParallel(routerModel())).toBeNull();
	});

	it('returns null when status is undefined (single-model)', () => {
		expect(extractParallel(singleModel())).toBeNull();
	});
});

describe('isChatCapable', () => {
	it('returns true for normal chat models', () => {
		expect(isChatCapable(routerModel())).toBe(true);
	});

	it('returns false for embeddings-only models', () => {
		expect(isChatCapable(routerModel({ status: { value: 'loaded', args: ['--embeddings'] } }))).toBe(false);
	});

	it('returns true for single-model (no status)', () => {
		expect(isChatCapable(singleModel())).toBe(true);
	});
});

describe('isSingleModelServer', () => {
	it('returns true when all models lack status', () => {
		expect(isSingleModelServer([singleModel()])).toBe(true);
	});

	it('returns true for single model with slash in id and no status', () => {
		expect(isSingleModelServer([singleModel({ id: 'user/repo-GGUF:Q4_K_M' })])).toBe(true);
	});

	it('returns false when any model has status', () => {
		expect(isSingleModelServer([routerModel(), singleModel()])).toBe(false);
	});

	it('returns false for router models', () => {
		expect(isSingleModelServer([routerModel()])).toBe(false);
	});

	it('returns false for empty list', () => {
		expect(isSingleModelServer([])).toBe(false);
	});
});

describe('calculateMaxOutputTokens', () => {
	it('returns 25% of context clamped to min 8192', () => {
		expect(calculateMaxOutputTokens(16000)).toBe(8192);
	});

	it('returns 25% of context for large values', () => {
		expect(calculateMaxOutputTokens(256000)).toBe(64000);
	});

	it('clamps to max 128000', () => {
		expect(calculateMaxOutputTokens(1000000)).toBe(128000);
	});
});

describe('parseModelId', () => {
	it('splits model@endpoint', () => {
		expect(parseModelId('qwen3-4b@local')).toEqual({ baseModelId: 'qwen3-4b', endpointId: 'local' });
	});

	it('handles model id with no @', () => {
		expect(parseModelId('qwen3-4b')).toEqual({ baseModelId: 'qwen3-4b', endpointId: null });
	});

	it('handles gguf filename as model id', () => {
		expect(parseModelId('Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf@remote')).toEqual({
			baseModelId: 'Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf',
			endpointId: 'remote',
		});
	});
});
