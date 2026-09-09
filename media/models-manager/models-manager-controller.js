/**
 * Llama Copilot — models manager controller.
 *
 * A dumb view: it paints WebviewState (see modelsIniUI.ts) into the static
 * markup of media/models-manager/index.html and forwards user clicks to the
 * host. All logic (ini read/write, presets, system info) lives in the
 * extension host.
 *
 * Contract with the markup (enforced by modelsIniHtml.test.ts):
 *   - preset rows: cloned from <template data-mm-target="presetRowTemplate">,
 *     one per state.presets entry; the controller sets data-preset-id per
 *     clone and the action handlers read it via el.closest('tr')
 *   - read-only mode (unsupported ini format): ONE
 *     `fieldset[data-mm-target="controls"].disabled = true` disables every
 *     checkbox/button in the table while the footer stays usable
 *   - dynamic text is set with textContent / setAttribute only (rule 3 in
 *     the index.html header) — never innerHTML with dynamic data
 *
 * Load order (injected by modelsIniUI.ts): webview-core.js FIRST, then this
 * file. This file boots itself at the bottom via LlamaWebview.start().
 */
(function () {
	'use strict';

	function formatRam(mb) {
		if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
		return mb + ' MB';
	}

	/** Remove all children (used to clear list containers before re-filling). */
	function clear(el) {
		while (el.firstChild) el.removeChild(el.firstChild);
	}

	class ModelsManagerController extends LlamaWebview.Controller {
		// -- host -> webview ----------------------------------------------

		applyState(state) {
			this.state = state;
			const readOnly = !!state.iniFormatError;

			const banner = this.target('errorBanner');
			if (state.iniFormatError) {
				banner.hidden = false;
				banner.textContent = 'This models.ini uses format version ' + state.iniFormatError.fileVersion +
					', but Llama Copilot only supports version ' + state.iniFormatError.supportedVersion +
					'. Update the extension, or edit the file manually.';
			} else {
				banner.hidden = true;
			}

			// One flag disables every checkbox/button inside the <fieldset>.
			this.target('controls').disabled = readOnly;

			const tbody = this.target('presetRows');
			clear(tbody);
			const tpl = this.target('presetRowTemplate');
			for (const preset of state.presets) {
				tbody.appendChild(this.buildRow(tpl, preset, readOnly));
			}

			const userSection = this.target('userSection');
			userSection.hidden = state.userSections.length === 0;
			const userModels = this.target('userModels');
			clear(userModels);
			for (const name of state.userSections) {
				const div = document.createElement('div');
				div.className = 'user-model';
				div.textContent = '[' + name + ']';
				userModels.appendChild(div);
			}

			const ram = this.target('footerRam');
			ram.hidden = !(state.systemRamMB > 0);
			ram.textContent = state.systemRamMB > 0 ? 'System RAM: ' + formatRam(state.systemRamMB) : '';
			const vram = this.target('footerVram');
			vram.hidden = !(state.totalVramMB > 0);
			vram.textContent = state.totalVramMB > 0 ? ' | VRAM: ' + formatRam(state.totalVramMB) : '';
		}

		buildRow(tpl, preset, readOnly) {
			const row = tpl.content.firstElementChild.cloneNode(true);
			row.dataset.presetId = preset.id;
			row.classList.toggle('disabled', preset.exceedsRam);
			row.classList.toggle('deprecated', preset.deprecated);

			row.querySelector('.name').textContent = preset.displayName;
			row.querySelector('.badge-deprecated').hidden = !preset.deprecated;
			row.querySelector('.badge-warning').hidden = !(preset.exceedsVram && !preset.exceedsRam);

			row.querySelector('.ram').textContent = formatRam(preset.minRamMB);
			row.querySelector('.ram-info .tooltip').hidden = !preset.exceedsRam;

			const inputs = row.querySelectorAll('input[type="checkbox"]');
			const enabled = inputs[0];
			if (preset.deprecated && preset.enabled) {
				enabled.checked = true;
				enabled.disabled = true;
				enabled.setAttribute('title', 'Deprecated — use the migrate button');
			} else {
				enabled.checked = preset.enabled;
				enabled.disabled = readOnly || preset.exceedsRam;
				if (preset.exceedsRam) {
					enabled.setAttribute('title', 'Exceeds available system RAM');
				} else if (readOnly) {
					enabled.setAttribute('title', 'models.ini format version is unsupported');
				} else {
					enabled.removeAttribute('title');
				}
			}

			const autoupdate = inputs[1];
			autoupdate.checked = preset.autoupdate;
			autoupdate.disabled = readOnly || !preset.enabled;

			const btn = row.querySelector('.action-cell button');
			const migrate = preset.deprecated && preset.enabled && preset.successorName;
			if (migrate) {
				btn.hidden = false;
				btn.className = '';
				btn.textContent = 'Change to ' + preset.successorName;
				btn.dataset.action = 'mm#migrate';
			} else if (preset.hasUpdate) {
				btn.hidden = false;
				btn.className = 'secondary-btn';
				btn.textContent = 'Upgrade';
				btn.dataset.action = 'mm#upgrade';
			} else {
				btn.hidden = true;
			}
			return row;
		}

		// -- webview -> host (data-action="mm#..." / "change->mm#...") ----

		toggleEnabled(el) {
			const row = el.closest('tr');
			this.post({ type: 'toggleEnabled', presetId: row.dataset.presetId, enabled: el.checked });
		}

		toggleAutoupdate(el) {
			const row = el.closest('tr');
			this.post({ type: 'toggleAutoupdate', presetId: row.dataset.presetId, autoupdate: el.checked });
		}

		upgrade(el) {
			const row = el.closest('tr');
			this.post({ type: 'upgrade', presetId: row.dataset.presetId });
		}

		migrate(el) {
			const row = el.closest('tr');
			this.post({ type: 'migrate', presetId: row.dataset.presetId });
		}

		openIni() {
			this.post({ type: 'openIni' });
		}
	}

	LlamaWebview.start({ controller: ModelsManagerController });
})();
