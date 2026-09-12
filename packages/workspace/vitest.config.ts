import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			vscode: path.resolve(root, '../../src/test/vscode-shim.ts'),
			'@llama-copilot/shared': path.resolve(root, '../shared/src/index.ts'),
		},
	},
	test: {
		globals: false,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['node_modules', 'out'],
	},
});
