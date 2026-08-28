/**
 * Contract tests for the onboarding webview (static HTML + controller).
 *
 * The webview is three files, edited without TypeScript tooling:
 *   - media/onboarding/index.html            (static markup + CSS)
 *   - media/onboarding/wizard-controller.js  (view logic — posts actions)
 *   - media/js/webview-core.js               (shared kernel — ready/setState)
 * The host↔webview protocol documented in the HTML header — message types,
 * state shape, lifecycle — is enforced here against the raw file contents
 * (string-based on purpose: vitest runs in a node environment, no DOM).
 *
 * If you add a new action in the webview, also add it to the WizardAction
 * union and WIZARD_ACTION_TYPES in wizardUI.ts and handle it in
 * onboarding.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WIZARD_ACTION_TYPES, WIZARD_STEPS } from './wizardUI';

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'media');
const HTML_PATH = path.join(MEDIA_ROOT, 'onboarding', 'index.html');
const CORE_PATH = path.join(MEDIA_ROOT, 'js', 'webview-core.js');
const CONTROLLER_PATH = path.join(MEDIA_ROOT, 'onboarding', 'wizard-controller.js');

const ICON_TOKEN = '__LLAMA_ONBOARDING_ICON_URL__';
const SCRIPTS_TOKEN = '__LLAMA_WEBVIEW_SCRIPTS__';

/**
 * Strip HTML comments: the header documentation contains code examples
 * (e.g. a hypothetical `doThing` action) that must not be treated as real
 * protocol usage.
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

describe('wizard webview contract (media/onboarding + media/js)', () => {
	let html: string;
	let core: string;
	let controller: string;

	beforeAll(() => {
		for (const p of [HTML_PATH, CORE_PATH, CONTROLLER_PATH]) {
			expect(fs.existsSync(p), `missing ${p}`).toBe(true);
		}
		html = stripComments(fs.readFileSync(HTML_PATH, 'utf8'));
		core = fs.readFileSync(CORE_PATH, 'utf8');
		controller = fs.readFileSync(CONTROLLER_PATH, 'utf8');
	});

	describe('index.html (static markup)', () => {
		it('has the app root with data-controller="wizard"', () => {
			expect(html).toContain('data-controller="wizard"');
		});

		it('has a <section data-screen> for every wizard step', () => {
			for (const step of WIZARD_STEPS) {
				expect(html, `missing section for step '${step}'`).toContain(`data-screen="${step}"`);
			}
		});

		it('contains the webview scripts placeholder exactly once (injected by wizardUI.ts)', () => {
			expect(html.match(new RegExp(SCRIPTS_TOKEN, 'g'))?.length).toBe(1);
		});

		it('contains the icon placeholder exactly once (replaced by wizardUI.ts)', () => {
			expect(html.match(new RegExp(ICON_TOKEN, 'g'))?.length).toBe(1);
		});

		it('has no external resources (the webview CSP blocks remote content)', () => {
			// The two webview scripts are injected by the host through the
			// placeholder, so the template itself carries no <script src>.
			expect(html).not.toMatch(/<script[^>]+src\s*=/i);
			expect(html).not.toMatch(/<link[^>]+href\s*=/i);
			expect(html).not.toMatch(/https?:\/\//);
		});
	});

	describe('webview-core.js (shared kernel)', () => {
		it('sends the ready handshake (the host re-sends state in response)', () => {
			expect(core).toMatch(/postMessage\(\{\s*type:\s*'ready'\s*\}\)/);
		});

		it('handles setState messages from the host', () => {
			expect(core).toMatch(/msg\.type\s*===\s*'setState'/);
		});

		it('uses the VS Code webview API when available', () => {
			expect(core).toContain('acquireVsCodeApi');
		});
	});

	describe('wizard-controller.js (view logic)', () => {
		for (const type of WIZARD_ACTION_TYPES) {
			if (type === 'ready') continue; // posted by webview-core.js
			it(`posts the '${type}' action`, () => {
				expect(controller).toMatch(new RegExp(`type:\\s*'${type}'`));
			});
		}

		it('does not post action types the host does not know about', () => {
			const posted = postedActionTypes(core + '\n' + controller);
			expect(posted.size).toBeGreaterThan(0);
			for (const type of posted) {
				expect(WIZARD_ACTION_TYPES, `unknown action type '${type}'`).toContain(type);
			}
		});
	});
});
