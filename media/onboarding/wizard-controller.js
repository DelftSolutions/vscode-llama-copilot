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
			this.showScreen(state.step);
			switch (state.step) {
				case 'mode': this.renderMode(state); break;
				case 'downloading': this.renderDownloading(state); break;
				case 'model': this.renderModel(state); break;
				case 'starting': this.renderStarting(state); break;
				case 'done': break;
				default: return;
			}
		}

		showScreen(step) {
			for (const el of this.targets('screen')) {
				el.hidden = el.dataset.screen !== step;
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
			const check = this.target('serverCheck');
			check.classList.toggle('pending', !state.serverStarted);
			const mark = this.target('serverCheckMark');
			mark.classList.toggle('empty', !state.serverStarted);
			mark.textContent = state.serverStarted ? '\u2713' : '';

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
	}

	LlamaWebview.start({ controller: WizardController });
})();
