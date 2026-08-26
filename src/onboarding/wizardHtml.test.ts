/**
 * Contract test for the onboarding webview HTML (media/onboarding/index.html).
 *
 * The HTML file is edited by designers without TypeScript tooling, so this
 * test enforces the host↔webview protocol documented in the HTML header:
 * the file must use the webview API, perform the `ready` handshake, handle
 * `setState`, and only post action types the host knows about.
 *
 * If you add a new action in the HTML, also add it to the WizardAction union
 * and WIZARD_ACTION_TYPES in wizardUI.ts and handle it in onboarding.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WIZARD_ACTION_TYPES } from './wizardUI';

const HTML_PATH = path.join(__dirname, '..', '..', 'media', 'onboarding', 'index.html');

/**
 * Strip HTML comments: the header documentation contains code examples
 * (e.g. a hypothetical `doThing` action) that must not be treated as real
 * protocol usage.
 */
function stripComments(html: string): string {
	return html.replace(/<!--[\s\S]*?-->/g, '');
}

describe('wizard webview HTML contract (media/onboarding/index.html)', () => {
	let code: string;

	beforeAll(() => {
		expect(fs.existsSync(HTML_PATH), `missing ${HTML_PATH}`).toBe(true);
		code = stripComments(fs.readFileSync(HTML_PATH, 'utf8'));
	});

	it('uses the VS Code webview API', () => {
		expect(code).toContain('acquireVsCodeApi()');
	});

	it('sends the ready handshake (the host re-sends state in response)', () => {
		expect(code).toMatch(/postMessage\(\{\s*type:\s*'ready'\s*\}\)/);
	});

	it('handles setState messages from the host', () => {
		expect(code).toMatch(/msg\.type\s*===\s*'setState'/);
	});

	for (const type of WIZARD_ACTION_TYPES) {
		it(`posts the '${type}' action`, () => {
			expect(code).toMatch(new RegExp(`type:\\s*'${type}'`));
		});
	}

	it('does not post action types the host does not know about', () => {
		// Actions go through the post() helper or directly via postMessage().
		const posted = new Set<string>();
		for (const re of [/post\(\{\s*type:\s*'([^']+)'/g, /postMessage\(\{\s*type:\s*'([^']+)'/g]) {
			for (const match of code.matchAll(re)) {
				posted.add(match[1]);
			}
		}
		expect(posted.size).toBeGreaterThan(0);
		for (const type of posted) {
			expect(WIZARD_ACTION_TYPES).toContain(type);
		}
	});

	it('contains the icon placeholder exactly once (replaced by wizardUI.ts)', () => {
		const matches = code.match(/__LLAMA_ONBOARDING_ICON_URL__/g);
		expect(matches?.length).toBe(1);
	});

	it('has no external resources (the webview CSP blocks remote content)', () => {
		expect(code).not.toMatch(/<script[^>]+src\s*=/i);
		expect(code).not.toMatch(/<link[^>]+href\s*=/i);
		expect(code).not.toMatch(/https?:\/\//);
	});

	it('keeps the required structure (#content + render + bindEvents)', () => {
		expect(code).toContain('id="content"');
		expect(code).toMatch(/function render\(/);
		// render() replaces innerHTML, which destroys listeners — bindEvents()
		// must re-run after every render, so both must stay.
		expect(code).toMatch(/function bindEvents\(/);
	});
});
