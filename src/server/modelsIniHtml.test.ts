/**
 * Contract tests for the models manager webview (static HTML + controller).
 *
 * The webview is three files, edited without TypeScript tooling:
 *   - media/models-manager/index.html                    (static markup + CSS)
 *   - media/models-manager/models-manager-controller.js  (view logic — posts actions)
 *   - media/js/webview-core.js                           (shared kernel — ready/setState)
 * The host↔webview protocol documented in the HTML header is enforced here
 * against the raw file contents (string-based on purpose: vitest runs in a
 * node environment, no DOM). The shared kernel is tested once in
 * wizardHtml.test.ts — here only the view-specific contract.
 *
 * If you add a new action in the webview, also add it to the WebviewMessage
 * union and MODELS_MANAGER_ACTION_TYPES in modelsIniUI.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MODELS_MANAGER_ACTION_TYPES } from './modelsIniUI';

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'media');
const HTML_PATH = path.join(MEDIA_ROOT, 'models-manager', 'index.html');
const CORE_PATH = path.join(MEDIA_ROOT, 'js', 'webview-core.js');
const CONTROLLER_PATH = path.join(MEDIA_ROOT, 'models-manager', 'models-manager-controller.js');

const SCRIPTS_TOKEN = '__LLAMA_WEBVIEW_SCRIPTS__';

/**
 * Strip HTML comments: the header documentation contains code examples that
 * must not be treated as real protocol usage.
 */
function stripComments(html: string): string {
	return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * All action `type` strings posted via post({ type: 'x' }) or
 * postMessage({ type: 'x' }) in the given code.
 */
function postedActionTypes(code: string): Set<string> {
	const posted = new Set<string>();
	for (const re of [/post\(\{\s*type:\s*'([^']+)'/g, /postMessage\(\{\s*type:\s*'([^']+)'/g]) {
		for (const match of code.matchAll(re)) {
			posted.add(match[1]);
		}
	}
	return posted;
}

describe('models manager webview contract (media/models-manager + media/js)', () => {
	let html: string;
	let controller: string;

	beforeAll(() => {
		for (const p of [HTML_PATH, CORE_PATH, CONTROLLER_PATH]) {
			expect(fs.existsSync(p), `missing ${p}`).toBe(true);
		}
		html = stripComments(fs.readFileSync(HTML_PATH, 'utf8'));
		controller = fs.readFileSync(CONTROLLER_PATH, 'utf8');
	});

	describe('index.html (static markup)', () => {
		it('has the app root with data-controller="mm"', () => {
			expect(html).toContain('data-controller="mm"');
		});

		it('has the preset row template and the row container', () => {
			expect(html).toContain('data-mm-target="presetRowTemplate"');
			expect(html).toContain('data-mm-target="presetRows"');
		});

		it('wraps the table in the read-only controls fieldset', () => {
			expect(html).toContain('data-mm-target="controls"');
		});

		it('contains the webview scripts placeholder exactly once (injected by modelsIniUI.ts)', () => {
			expect(html.match(new RegExp(SCRIPTS_TOKEN, 'g'))?.length).toBe(1);
		});

		it('has no external resources (the webview CSP blocks remote content)', () => {
			// The two webview scripts are injected by the host through the
			// placeholder, so the template itself carries no <script src>.
			expect(html).not.toMatch(/<script[^>]+src\s*=/i);
			expect(html).not.toMatch(/<link[^>]+href\s*=/i);
			expect(html).not.toMatch(/https?:\/\//);
		});
	});

	describe('models-manager-controller.js (view logic)', () => {
		for (const type of MODELS_MANAGER_ACTION_TYPES) {
			it(`posts the '${type}' action`, () => {
				expect(controller).toMatch(new RegExp(`type:\\s*'${type}'`));
			});
		}

		it('does not post action types the host does not know about', () => {
			// 'ready' is posted by the shared kernel and is a known host action.
			const known = [...MODELS_MANAGER_ACTION_TYPES, 'ready'];
			const posted = postedActionTypes(controller);
			expect(posted.size).toBeGreaterThan(0);
			for (const type of posted) {
				expect(known, `unknown action type '${type}'`).toContain(type);
			}
		});
	});
});
