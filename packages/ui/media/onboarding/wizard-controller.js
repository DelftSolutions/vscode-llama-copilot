/**
 * Llama Copilot — onboarding wizard controller.
 *
 * A dumb view: it paints WizardState (see wizardUI.ts) into the static
 * sections of media/onboarding/index.html and forwards user clicks to the
 * host. All logic lives in the extension host (onboarding.ts).
 *
 * Contract with the markup (enforced by wizardHtml.test.ts):
 *   - screens: <section data-screen> + data-wizard-target="screen",
 *     toggled with `hidden`; every step in WIZARD_STEPS (wizardUI.ts) has one
 *   - repeated items: model cards cloned from <template
 *     data-wizard-target="modelCardTemplate">
 *   - sidebar: [data-wizard-target="sidebarStep"] entries carry a
 *     space-separated data-step list of the WizardSteps they cover;
 *     showScreen() toggles .active on the entry that owns the current step
 *   - dynamic text is set with textContent / setAttribute only (rule 3 in
 *     the index.html header) — never innerHTML with dynamic data
 *   - actions: data-action="wizard#method" elements call the matching
 *     method below, which posts the matching WizardAction type
 *
 * Load order (injected by wizardUI.ts): webview-core.js FIRST, then this
 * file. This file boots itself at the bottom via LlamaWebview.start().
 */
(function () {
	'use strict';

	/** Remove all children (used to clear list containers before re-filling). */
	function clear(el) {
		while (el.firstChild) el.removeChild(el.firstChild);
	}

	/** Fill a .error-block target ({title, detail} or null) and toggle it. */
	function setError(el, err) {
		if (!el) return;
		if (err) {
			el.hidden = false;
			el.querySelector('.err-title').textContent = err.title;
			el.querySelector('.err-detail').textContent = err.detail;
		} else {
			el.hidden = true;
		}
	}

	class WizardController extends LlamaWebview.Controller {
		// -- host -> webview ----------------------------------------------

		applyState(state) {
			this.state = state;
			const loading = this.target('loading');
			if (loading) loading.remove();

			// Show/hide conditional sidebar step
			const sshSidebarStep = this.target('sshSidebarStep');
			if (sshSidebarStep) {
				sshSidebarStep.hidden = !state.isRemoteSession;
			}

			this.showScreen(state.step);
			switch (state.step) {
				case 'mode': this.renderMode(state); break;
				case 'downloading': this.renderDownloading(state); break;
				case 'model': this.renderModel(state); break;
				case 'starting': this.renderStarting(state); break;
				case 'remote': this.renderRemote(state); break;
				case 'done': this.renderDone(state); break;
				default: return;
			}
		}

		showScreen(step) {
			for (const el of this.targets('screen')) {
				el.hidden = el.dataset.screen !== step;
			}
			// Highlight the sidebar entry that owns this step (its data-step
			// attribute lists every step it covers, space-separated).
			for (const el of this.targets('sidebarStep')) {
				const owned = String(el.dataset.step || '').split(/\s+/);
				el.classList.toggle('active', owned.includes(step));
			}
		}

		renderMode(state) {
			for (const card of this.targets('option')) {
				card.classList.toggle('selected', card.dataset.mode === state.selectedMode);
			}
		}

		renderDownloading(state) {
			const pct = state.downloadPercent;
			this.target('progressFill').style.width = (pct === null || pct === undefined ? 0 : pct) + '%';
			this.target('progressLabel').textContent = pct === null || pct === undefined ? 'Connecting...' : pct + '%';
			setError(this.target('downloadError'), state.downloadError);
			this.target('retryDownload').hidden = !state.downloadError;
		}

		renderModel(state) {
			const hw = this.target('hardware');
			hw.hidden = !state.hardwareLine;
			hw.textContent = state.hardwareLine || '';

			const rec = state.models.find(m => m.isRecommended);
			const recList = this.target('modelList');
			clear(recList);
			if (rec) recList.appendChild(this.buildModelCard(rec));

			const reason = this.target('recommendedReason');
			reason.hidden = !state.recommendedReason;
			reason.textContent = state.recommendedReason || '';

			const others = state.models.filter(m => !m.isRecommended);
			const toggle = this.target('showAll');
			toggle.hidden = others.length === 0;
			toggle.textContent = state.showAllModels
				? 'Hide other models'
				: 'See all models (' + others.length + ' available)';

			const otherList = this.target('otherModels');
			clear(otherList);
			otherList.hidden = !state.showAllModels;
			if (state.showAllModels) {
				for (const m of others) otherList.appendChild(this.buildModelCard(m));
			}

			this.target('start').disabled = !state.selectedPresetId;
		}

		buildModelCard(m) {
			const tpl = this.target('modelCardTemplate');
			const card = tpl.content.firstElementChild.cloneNode(true);
			card.dataset.model = m.id;
			const title = card.querySelector('.title');
			title.textContent = m.displayName;
			if (m.isRecommended) {
				const badge = document.createElement('span');
				badge.className = 'badge';
				badge.textContent = 'Recommended for your machine';
				title.appendChild(badge);
			}
			const ram = card.querySelector('.ram-info');
			ram.textContent = 'Needs ~' + Math.ceil(m.minRamMB / 1024) + ' GB RAM' +
				(m.exceedsRam ? ' — not enough on this machine' : '');
			if (m.exceedsRam) {
				card.classList.add('disabled');
				card.setAttribute('title', 'Needs more RAM than available on this machine');
			}
			card.classList.toggle('selected', m.id === this.state.selectedPresetId);
			return card;
		}

		renderStarting(state) {
			const systemCheck = this.target('systemCheck');
			systemCheck.classList.toggle('pending', !state.systemChecked);
			const systemMark = this.target('systemCheckMark');
			systemMark.classList.toggle('empty', !state.systemChecked);
			systemMark.textContent = state.systemChecked ? '\u2713' : '';

			// The server check has three faces: pending (empty circle),
			// done (✓), and failed (✗) while an error is shown. startError
			// only concerns the server — the system check above is
			// unaffected.
			const failed = !!state.startError;
			const check = this.target('serverCheck');
			check.classList.toggle('error', failed);
			check.classList.toggle('pending', !state.serverStarted && !failed);
			const mark = this.target('serverCheckMark');
			mark.classList.toggle('error', failed);
			mark.classList.toggle('empty', !state.serverStarted && !failed);
			mark.textContent = failed ? '\u2717' : state.serverStarted ? '\u2713' : '';

			setError(this.target('startError'), state.startError);
			const status = this.target('startStatus');
			const progress = this.target('startProgress');
			const note = this.target('startNote');
			if (state.startError) {
				status.hidden = true;
				progress.hidden = true;
				note.hidden = true;
			} else {
				status.hidden = false;
				progress.hidden = false;
				status.textContent = state.loadingModelName
					? 'Loading ' + state.loadingModelName + '...'
					: 'Starting the server...';
				note.hidden = !state.loadingModelName;
			}
		}

		// -- webview -> host (data-action="wizard#...") -------------------

		selectMode(el) {
			this.post({ type: 'selectMode', mode: el.dataset.mode });
		}

		continueStep() {
			this.post({ type: 'continue' });
		}

		back() {
			this.post({ type: 'back' });
		}

		retry() {
			this.post({ type: 'retry' });
		}

		selectModel(el) {
			if (el.classList.contains('disabled')) return;
			this.post({ type: 'selectModel', presetId: el.dataset.model });
		}

		toggleShowAll() {
			this.post({ type: 'toggleShowAll' });
		}

		start() {
			this.post({ type: 'start' });
		}

		close() {
			this.post({ type: 'close' });
		}

		openChat() {
			this.post({ type: 'openChat' });
		}

		configureSSH() {
			this.post({ type: 'configureSSH' });
		}

		skipSSH() {
			this.post({ type: 'skipSSH' });
		}

		reconnect() {
			this.post({ type: 'reconnect' });
		}

		renderRemote(state) {
			const portEl = this.target('sshLocalPort');
			if (portEl) portEl.textContent = state.forwards.length > 0 ? String(state.forwards[0].localPort) : '';

			const hostEl = this.target('sshHostName');
			if (hostEl) hostEl.textContent = state.sshHost || 'unknown';

			const listEl = this.target('forwardsList');
			if (listEl) {
				clear(listEl);
				for (const fw of state.forwards) {
					const line = document.createElement('div');
					if (fw.alreadyConfigured) {
						line.textContent = '  [already configured] 127.0.0.1:' + fw.remotePort + ' \u2192 ' + fw.localHost + ':' + fw.localPort + '  (' + fw.label + ')';
						line.style.opacity = '0.5';
					} else {
						line.textContent = '  [\u2713] 127.0.0.1:' + fw.remotePort + ' \u2192 ' + fw.localHost + ':' + fw.localPort + '  (' + fw.label + ')';
					}
					listEl.appendChild(line);
				}
			}

			const previewEl = this.target('sshDiffPreview');
			if (previewEl) {
				if (state.sshDiffPreview) {
					previewEl.textContent = state.sshDiffPreview;
					previewEl.hidden = false;
				} else {
					previewEl.hidden = true;
				}
			}

			const errorEl = this.target('sshError');
			if (errorEl) {
				if (state.sshSetupError) {
					errorEl.hidden = false;
					const titleEl = this.target('sshErrorTitle');
					if (titleEl) titleEl.textContent = state.sshSetupError.title;
					const detailEl = this.target('sshErrorDetail');
					if (detailEl) detailEl.textContent = state.sshSetupError.detail;
				} else {
					errorEl.hidden = true;
				}
			}
		}

		renderDone(state) {
			const local = this.target('doneLocal');
			const reconnect = this.target('doneReconnect');
			const manual = this.target('doneManual');

			if (local) local.hidden = state.doneVariant !== 'local';
			if (reconnect) reconnect.hidden = state.doneVariant !== 'reconnect';
			if (manual) manual.hidden = state.doneVariant !== 'manual';

			if (state.doneVariant === 'manual') {
				const linesEl = this.target('manualForwardLines');
				if (linesEl && state.forwards) {
					linesEl.textContent = state.forwards
						.filter(function(f) { return !f.alreadyConfigured; })
						.map(function(f) { return 'RemoteForward 127.0.0.1:' + f.remotePort + ' ' + f.localHost + ':' + f.localPort; })
						.join('\n');
				}
			}
		}
	}

	LlamaWebview.start({ controller: WizardController });
})();
