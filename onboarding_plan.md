# Plan: Llama Copilot Onboarding Wizard (Screens 1 → 3 + Done)

## TL;DR
Build a single-step-machine **WebviewPanel wizard** (mode choice → binary download → model pick → model start → done) hooked into extension activation and `server.managed` config changes. It reuses the existing webview pattern (`src/server/modelsIniUI.ts`), binary download (`BinaryManager`), device query (`queryDevices`), preset model (`MODEL_PRESETS`), and server lifecycle (`LlamaServerManager`). Onboarding state (step + done/skipped) persists in `context.globalState`; `llamaCopilot.server.managed` is written to **true only when the managed path completes**. Upgrading users with a working setup never see the wizard.

## Confirmed decisions (user-approved 2026-08-25)
- **Screen 3 model-load progress**: indeterminate animated bar + note ("This may take a few minutes — you can close this panel and check back later."). No stdout parsing — llama-server only exposes 200/503 on `/health`.
- **"Skip, not now"**: never auto-opens again. Wizard stays available via command palette (`llamaCopilot.onboarding`). Mid-wizard closes (X / Close) DO auto-resume next launch.
- **Screen 1 default selection**: "We download everything and start it for you (Recommended)".

## Extra decisions (recommended, flagged for review)
- **Recommendation rule**: pick highest-quality non-deprecated preset where `minRamMB ≤ floor(systemRamMB × 0.5)` and free disk ≥ 8 GB. Matches sketch examples (16 GB → Qwen 3 4B; 18 GB → Qwen 3 4B). Threshold is a named constant (`RAM_FIT_FRACTION`) in `recommendation.ts`, easy to tune. VRAM-awareness is a follow-up, not v1.
- **Wizard panel column**: `ViewColumn.One` (same as Models Manager).
- **`BinaryManager.download()` / `downloadWithProgress()` are ~80% duplicated** — consolidate into one core with an optional `onProgress` callback (boy-scout, also unblocks live % in the panel).
- **Silent-skip heuristic for upgrade users** (prevents "every upgrading user gets the wizard"): if onboarding state is unset AND (managed mode with binary installed AND models.ini has ≥1 enabled preset, OR non-managed with user endpoints configured) → silently mark onboarding `done`, never open the wizard.
- **Done-screen llama icon**: reuse repo assets `llama-icon-light.png` / `llama-icon-dark.png` (official llama.brand marks) via `webview.asWebviewUri`.

## Screen flow (from sketches)
1. **Screen 1** "How do you want to run your local model?" — 3 radio cards: Skip / Recommended / Advanced + managed-mode disclaimer ("* Managed mode starts a background process, auto-starts it on every VS Code launch, enables binary auto-update, and occupies port 8013"). Buttons: Back (disabled), Continue.
2. **Screen 1.1** "Getting llama-server ready" — live percentage bar, "Downloading llama-server from GitHub (~100 MB)". Error state: categorized cause + Retry. Buttons: Back, Retry.
3. **Screen 2** "Pick your model" — hardware line ("M3 Pro · 18GB RAM · 256GB disk"), recommended card with "Recommended for your machine" badge + reason, "See all models (N available)" expander, Back / Start.
4. **Screen 3** "Starting your model" — checkmarks "Checked your system" ✓, "Started llama-server" ✓, then indeterminate "Loading Qwen 3 4B…", note text, Retry / Close. Close = keep server starting in background, status bar continues.
5. **Done** — "Your local model works. Open chat and type your first request." + **Open Chat** button; info notification "Your model is ready".

## Steps

### Phase 0 — Pure logic modules (all parallel, independently testable)
1. **`src/server/presets.ts`**: add `qualityRank: number` to `ModelPreset` (explicit quality order, e.g. gemma3-27b > qwen3-30b-a3b > nemotron-3-nano-30b > glm-4-7-flash > glm-4.5-air > qwen3-4b ≈ gemma3-4b). Update `presets.test.ts` to validate unique ranks + every preset has a rank.
2. **New `src/onboarding/recommendation.ts`**: pure `recommendModel(presets, systemInfo, diskFreeMB): { presetId, reason } | null` implementing the RAM-fit rule; reason string like "Fast and capable, fits comfortably on {N} GB RAM". Plus `formatHardwareLine(cpuName, ramGB, diskGB)`.
3. **New `src/onboarding/diskInfo.ts`**: `getDiskFreeMB(dir)` using `fs.promises.statfs` (Node ≥18.15, cached result); best-effort `getCpuName()` (darwin `sysctl -n machdep.cpu.brand_string`, linux `/proc/cpuinfo`, win fallback) — returns `null` on failure, UI falls back to generic wording.
4. **New `src/onboarding/errorCategorizer.ts`**: `classifySetupError(err): { kind: 'network'|'http'|'disk'|'permission'|'quarantine'|'port'|'unknown', title, detail, retryable }`. Reuse `getErrorCode` from `src/errorUtils.ts` for ENOTFOUND/ECONNREFUSED/ECONNRESET/ETIMEDOUT (network), ENOSPC (disk), EACCES/EPERM (permission; EPERM executing the binary on darwin → quarantine hint), HTTP status from message, "address already in use" (port). Spec: error states must surface the actual cause, not the sketch one-liner.
5. **New `src/onboarding/onboardingState.ts`**: step machine over a memento-agnostic `KVStore` interface (`{ get(key), update(key, value) }` — `globalState` satisfies it; trivial to mock in tests). Steps: `mode → downloading → model → starting → done`, terminal `skipped`/`done`. Persist `{ state, step, selectedMode?, selectedPresetId? }` on every transition. Pure transition-guard functions (which steps may follow which, resume mapping).

**Tests (parallel with above)**: `src/onboarding/recommendation.test.ts` (16/18 GB → qwen3-4b; 32 GB → glm-4-7-flash; 64 GB → gemma3-27b; low-disk → null + reason), `src/onboarding/onboardingState.test.ts` (transitions, resume, skip/done terminal), `src/onboarding/errorCategorizer.test.ts` (crafted errors with `cause` chains — same style as `errorUtils.test.ts`).

### Phase 1 — Plumbing (depends on Phase 0 for state module)
6. **`src/server/binaryManager.ts`**: consolidate `download()` + `downloadWithProgress()` into private `downloadInternal(version, token, onProgress?)` (single source of truth for fetch/extract/quarantine/chmod/verify/state-write). Keep `downloadWithProgress()` public signature (wraps `vscode.window.withProgress`); add `downloadWithCallback(version, onProgress: (percent: number) => void): Promise<boolean>` (false = cancelled) for the wizard.
7. **`src/extension.ts`**:
   - Register new command `llamaCopilot.onboarding` ("Llama Copilot: Run Setup") → opens/resumes the wizard.
   - In `activate()`: non-blocking `maybeAutoRunOnboarding(context)` after existing setup. Auto-open conditions: onboarding state unset AND user has nothing configured (no user endpoints AND no binary installed) → fresh install, open Screen 1; OR managed=true with incomplete setup → resume at saved step. Silent-skip heuristic marks `done` for legacy/upgrade users (see decisions).
   - Extend existing `onDidChangeConfiguration` listener: `server.managed` false→true transition with onboarding not done → open wizard directly at the download/model step (managed path implied).
   - Extract `initManagedServer()` steps 5–6 (server start + background `checkForUpdate`) into shared `startServerAndAutoUpdate(context)` so the wizard's completion path reuses it (no duplication).
   - Wire orchestrator with closures over the existing module-level singletons (`binaryManager`, `modelsIniManager`, `serverManager`) so the wizard and normal managed flow share instances.

### Phase 2 — Wizard UI (2.8 ∥ 2.9 ∥ 2.10, then integration)
8. **New `src/onboarding/wizardUI.ts`**: `OnboardingWizardPanel` class — singleton panel (view id `llamaCopilot.onboarding`, title "Llama Copilot Setup"), `enableScripts: true`, `retainContextWhenHidden: true`, state pushed via `postMessage({ type: 'setState', ... })`, actions via `onDidReceiveMessage`. Steps rendered as sections toggled by state:
   - mode: 3 radio cards (default = Recommended), disclaimer text, Back/Continue
   - downloading: percent bar, "Downloading llama-server from GitHub (~100 MB)", error block (categorized) + Retry, Back
   - model: hardware line, recommended card (badge + reason), expandable full preset list with RAM-fit indicator (reuse `PresetViewState` shape), Back/Start
   - starting: two checkmarks, indeterminate animated bar, "Loading {model}…", note text, error block + Retry, Close
   - done: llama icon (`llama-icon-light.png` / `llama-icon-dark.png` via `asWebviewUri`), success text, Open Chat button
   - Styling with VS Code CSS variables (`--vscode-*`, `--vscode-progressBar-background`) to match the wireframes.
   - Messages: `ready | selectMode | continue | back | retry | selectModel | start | close`.
   - **Webview architecture (updated 2026-08-26 — static HTML, no inline template literal)**: markup in `media/onboarding/index.html` (all 5 screens as static `<section data-screen>` + `<style>`), logic in `media/onboarding/wizard-controller.js` on the shared kernel `media/js/webview-core.js` (hand-rolled Stimulus-like: delegated `data-action` routing, `data-*-target` lookup, `ready`/`setState` handshake). The HTML is a template: `__LLAMA_WEBVIEW_SCRIPTS__` → two webview-origin `<script src>` tags (core first, controller second), `__LLAMA_ONBOARDING_ICON_URL__` → icon URI. Contract enforced by `wizardHtml.test.ts`; the Models Manager was converted to the same pattern (`media/models-manager/` + `modelsIniHtml.test.ts`).
9. **New `src/onboarding/onboarding.ts`**: `OnboardingOrchestrator` — the state machine driver:
   - Options: `{ context, getBinaryManager, getModelsIniManager, ensureServerManager, refreshProviders, onManagedComplete }` (closures from extension.ts).
   - `run(resumeFrom?)` → reads `onboardingState`, opens panel at correct step.
   - **Skip** → state `skipped`, hide status bar, close panel (no auto-open ever again).
   - **Advanced** → `executeCommand('llamaCopilot.openEndpointSettings')`, state `done`, `server.managed` left false (default, nothing written).
   - **Managed → downloading**: `latestVersion()` → `downloadWithCallback` posting percent to panel + status bar; on failure post categorized error with Retry (re-invokes download); cancel keeps step `downloading`.
   - **After download**: `queryDevices(cliPath)` (checkmark "Checked your system", feeds Screen 2) → `recommendModel` → step `model`.
   - **Start**: `modelsIniManager.enablePreset(selectedId)` → `ensureServerManager()` → `serverManager.start(true)`; subscribe `serverManager.onStateChanged`: `starting` → checkmark 2; `loading_model` → indeterminate "Loading {name}…"; `crashed` → categorized error (port-in-use etc.) + Retry.
   - **Completion (state `running`)**: write `llamaCopilot.server.managed = true` via `vscode.workspace.getConfiguration(CONFIG_SECTION).update('server.managed', true, ConfigurationTarget.Global)` (managed path only); state `done`; panel → done screen; `showInformationMessage('Your model is ready', 'Open Chat')` + Open Chat → `workbench.action.chat.open`; call shared `startServerAndAutoUpdate` tail (background update check); hide status bar (shown only during onboarding/loading/error, then hidden).
   - **Close (X / Close) mid-wizard**: persist step; server keeps starting in background; status bar keeps reflecting state; next launch resumes (during `starting`/`loading` the wizard re-attaches to the existing server state — `tryReusePid()` handles the already-running case).
10. **New `src/onboarding/statusBar.ts`**: persistent `vscode.window.createStatusBarItem` (Left, priority ~100), owned by orchestrator, disposed in `deactivate()`:
    - downloading: `$(sync~spin) Downloading llama-server {pct}%`
    - starting: `$(sync~spin) Starting your model`
    - loading_model: `$(sync~spin) Loading {model}`
    - error: `$(warning) Setup failed — Retry` (command reopens wizard at failed step)
    - hidden on done / skipped / stable running.

### Phase 3 — Manifest + verification
11. **`package.json`**: add command contribution `llamaCopilot.onboarding` ("Llama Copilot: Run Setup"). No new activation events (already `onStartupFinished`).
12. **`src/test/vscode-shim.ts`**: extend only if Phase 2 modules import vscode at module scope in untestable ways — keep wizardUI/orchestrator out of unit tests (integration-verified manually); Phase 0 modules must not import vscode at all.

## Relevant files
- **New**: `src/onboarding/{onboarding.ts, wizardUI.ts, recommendation.ts, errorCategorizer.ts, onboardingState.ts, diskInfo.ts, statusBar.ts}` + `src/onboarding/{recommendation,onboardingState,errorCategorizer}.test.ts`
- **Modified**:
  - `src/extension.ts` — activation hook `maybeAutoRunOnboarding`, config-change trigger, `llamaCopilot.onboarding` command, extracted `startServerAndAutoUpdate` (from `initManagedServer` steps 5–6), orchestrator wiring
  - `src/server/binaryManager.ts` — consolidated `downloadInternal` + `downloadWithCallback`
  - `src/server/presets.ts` — `qualityRank` field on `ModelPreset`
  - `src/server/presets.test.ts` — rank validation
  - `package.json` — command contribution
- **Reuse as-is (reference patterns)**:
  - `src/server/modelsIniUI.ts` — `openModelsManager`/`loadWebviewHtml`/`updateWebviewState` webview singleton pattern (also converted to static HTML + injected controller on 2026-08-26)
  - `src/server/serverManager.ts` — `start(isFirstStart)`, `onStateChanged`, states `starting`/`loading_model`/`running`/`crashed`, `tryReusePid`
  - `src/server/deviceQuery.ts` — `queryDevices`/`getCachedSystemInfo`/`SystemInfo`
  - `src/server/modelsIniManager.ts` — `enablePreset`, `getEnabledPresets`, `exists`
  - `src/errorUtils.ts` — `getErrorCode`
  - `llama-icon-light.png` / `llama-icon-dark.png` (repo root) — wizard icons (sidebar + done screen)

## Verification
1. `npm test` — all new unit tests green (recommendation matrix, state machine transitions/resume, error categorization, preset rank validation) + existing suite unchanged.
2. `get_errors` clean on all touched files.
3. **Manual, fresh profile** (F5 dev host, empty globalStorage):
   - Wizard auto-opens at Screen 1 with Recommended pre-selected.
   - Managed path: Screen 1.1 shows live % from GitHub download → Screen 2 shows correct hardware line + recommendation for this machine → Start → Screen 3 shows both checkmarks then indeterminate "Loading {model}…" → done screen + "Your model is ready" notification; settings now show `llamaCopilot.server.managed: true`; chat completes a request against the local model.
   - Status bar visible throughout (downloading/starting/loading), hidden after ready.
4. **Manual, Advanced path**: opens Endpoints settings, `server.managed` stays false, wizard never auto-opens again; command palette "Run Setup" still works.
5. **Manual, Skip path**: wizard never auto-opens again.
6. **Resume**: kill VS Code mid-download and mid-load; relaunch → resumes at the correct step (download restarts from 0 — no partial-download resume in v1).
7. **Upgrade-user guard**: profile with installed binary + models.ini with enabled preset + no onboarding state → wizard does NOT open; state silently `done`. Same for non-managed user with configured endpoints.
8. **Config trigger**: flip `llamaCopilot.server.managed` to true in Settings on an onboarded-partially machine → wizard opens at the right step.
9. **Failure states**: airplane mode during download → categorized network error + working Retry; occupy port 8013 → port-in-use error on Screen 3 + Retry; `Retry` from status bar reopens panel.

## Scope boundaries
- **Included**: wizard (5 screens), onboarding state persistence + resume, status bar during onboarding, error categorization, model recommendation (RAM+disk), command palette entry, settings write on completion.
- **Excluded (follow-ups)**: VRAM-aware recommendation; real model-load percentage (would need llama.cpp stdout parsing); partial/resumable binary downloads; i18n; onboarding for remote-workspace sessions (managed mode already unsupported there — wizard simply doesn't auto-open when `isSupportedPlatform()` is false).
