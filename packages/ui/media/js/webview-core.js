/**
 * Llama Copilot webview core — a tiny Stimulus-like kernel shared by all
 * webviews (onboarding wizard, models manager, ...).
 *
 * What it provides (no dependencies, plain script tag, `window.LlamaWebview`):
 *
 *   - host API acquisition: uses acquireVsCodeApi() to talk to the host.
 *   - the `ready` handshake: posts { type: 'ready' } once, so the host
 *     re-sends the full current state (state posted before page load is lost).
 *   - the `setState` listener: window 'message' events with
 *     { type: 'setState', state } are forwarded to controller.applyState().
 *   - delegated action routing: ONE click + ONE change listener on the app
 *     root. Any element with a data-action attribute is handled:
 *         data-action="wizard#continue"            (click, implicit)
 *         data-action="change->mm#toggleEnabled"   (explicit event)
 *         data-action="wizard#selectMode"          (explicit controller)
 *     The method is called as controller[method](element, event). Because
 *     routing is delegated on the root, dynamically cloned elements (e.g.
 *     cards built from <template>s) work without rebinding — no
 *     bindEvents() after render, no listener leaks.
 *   - target lookup (Stimulus convention):
 *         controller.target('progressFill')      -> [data-wizard-target="progressFill"]
 *         controller.targets('option')           -> all [data-wizard-target="option"]
 *     where "wizard" is the value of the app root's data-controller.
 *
 * A controller is a class extending LlamaWebview.Controller that implements
 * applyState(state). Boot a page with:
 *
 *     LlamaWebview.start({ controller: MyController });
 *
 * in the controller file, AFTER this core script has loaded.
 *
 * NOTE: this file is shipped inside the VS Code extension and injected into
 * the webview by the host (wizardUI.ts / modelsIniUI.ts) as a
 * <script src> pointing at a webview-origin URI (asWebviewUri). Do not add
 * remote resources here — the webview CSP blocks them.
 */
(function () {
	'use strict';

	/**
	 * Host API. Only valid inside a VS Code webview, where the host injects
	 * acquireVsCodeApi().
	 */
	function acquireApi() {
		return window.acquireVsCodeApi();
	}

	/**
	 * Parse a data-action value.
	 * Formats: "method", "event->method", "event->controller#method",
	 * "controller#method". Default event is "click".
	 */
	function parseAction(raw) {
		let event = 'click';
		let rest = String(raw || '').trim();
		const arrow = rest.indexOf('->');
		if (arrow !== -1) {
			event = rest.slice(0, arrow).trim() || 'click';
			rest = rest.slice(arrow + 2).trim();
		}
		let controllerName = null;
		const hash = rest.indexOf('#');
		if (hash !== -1) {
			controllerName = rest.slice(0, hash).trim() || null;
			rest = rest.slice(hash + 1).trim();
		}
		return { event: event, controllerName: controllerName, method: rest };
	}

	class Controller {
		constructor(name, root, api) {
			this.name = name;
			this.root = root;
			this.api = api;
			this.state = null;
		}

		/** Post an action to the host (see WizardAction in wizardUI.ts etc.). */
		post(action) {
			this.api.postMessage(action);
		}

		/** First [data-<name>-target="<key>"] inside the root, or null. */
		target(key) {
			return this.root.querySelector('[data-' + this.name + '-target="' + key + '"]');
		}

		/** All [data-<name>-target="<key>"] inside the root. */
		targets(key) {
			return Array.prototype.slice.call(
				this.root.querySelectorAll('[data-' + this.name + '-target="' + key + '"]')
			);
		}
	}

	/**
	 * Boot the webview. Finds the app root ([data-controller]), instantiates
	 * the controller, wires setState + delegated actions, posts 'ready'.
	 *
	 * @param {object} options
	 * @param {Function} options.controller  controller class
	 * @param {string}   [options.name]      data-controller value (default:
	 *                                       read from the app root element)
	 * @param {Element}  [options.root]      app root (default: first
	 *                                       [data-controller] in the document)
	 */
	function start(options) {
		const api = acquireApi();
		const root = options.root || document.querySelector('[data-controller]') || document.body;
		const name = options.name || root.getAttribute('data-controller') || 'app';
		const controller = new options.controller(name, root, api);

		// host -> webview: full state on every change
		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg && msg.type === 'setState' && typeof controller.applyState === 'function') {
				controller.applyState(msg.state);
			}
		});

		// webview -> host: delegated action routing (click + change).
		// Both event types bubble through the root, so a checkbox click
		// reaches the handler TWICE (once as click, once as change) — the
		// event declared in data-action must match the event that fired,
		// or every change-> action would post twice.
		for (const type of ['click', 'change']) {
			root.addEventListener(type, event => {
				const el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
				if (!el || !root.contains(el)) return;
				const action = parseAction(el.getAttribute('data-action'));
				if (action.event !== type) return;
				if (action.controllerName && action.controllerName !== name) return;
				if (typeof controller[action.method] === 'function') {
					controller[action.method](el, event);
				}
			});
		}

		if (typeof controller.connect === 'function') {
			controller.connect();
		}

		// Handshake: the host re-sends the full current state in response,
		// so any setState posted before page load is not lost.
		api.postMessage({ type: 'ready' });
	}

	window.LlamaWebview = { Controller: Controller, start: start };
})();
