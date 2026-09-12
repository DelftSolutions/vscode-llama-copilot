#!/usr/bin/env node
/**
 * Bundle a VS Code extension entry point with esbuild, then remove
 * unbundled tsc emit so the VSIX only contains out/extension.js.
 *
 * Usage: node scripts/bundle-extension.js <package-dir>
 */
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const pkgDir = path.resolve(process.argv[2] || process.cwd());
const entry = path.join(pkgDir, 'src/extension.ts');
const outDir = path.join(pkgDir, 'out');
const outfile = path.join(outDir, 'extension.js');

if (!fs.existsSync(entry)) {
	console.error(`Entry not found: ${entry}`);
	process.exit(1);
}

esbuild.buildSync({
	entryPoints: [entry],
	bundle: true,
	outfile,
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	sourcemap: false,
	minify: false,
	alias: {
		'@llama-copilot/shared': path.join(pkgDir, '../shared/src/index.ts'),
	},
	logLevel: 'info',
});

// Keep only the bundled extension.js in out/
for (const name of fs.readdirSync(outDir)) {
	if (name === 'extension.js') continue;
	fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
}

console.log(`Bundled ${entry} -> ${outfile}`);
