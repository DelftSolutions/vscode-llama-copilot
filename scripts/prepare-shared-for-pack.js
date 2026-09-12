#!/usr/bin/env node
/**
 * Replace the npm-workspaces symlink for @llama-copilot/shared with a
 * real, minimal copy (package.json + out/) so vsce does not follow the
 * symlink into the monorepo and pack gigabytes of unrelated files.
 *
 * Usage: node scripts/prepare-shared-for-pack.js <extension-package-dir>
 */
const fs = require('node:fs');
const path = require('node:path');

const extDir = path.resolve(process.argv[2] || process.cwd());
const repoRoot = path.resolve(extDir, '../..');
const sharedSrc = path.join(repoRoot, 'packages/shared');
const dest = path.join(extDir, 'node_modules/@llama-copilot/shared');

if (!fs.existsSync(path.join(sharedSrc, 'out/index.js'))) {
	console.error('Shared package is not compiled. Run tsc -b first.');
	process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

fs.copyFileSync(
	path.join(sharedSrc, 'package.json'),
	path.join(dest, 'package.json'),
);

fs.cpSync(path.join(sharedSrc, 'out'), path.join(dest, 'out'), { recursive: true });

console.log(`Prepared ${dest} for packaging (real copy, not symlink).`);
