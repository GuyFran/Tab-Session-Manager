# Fork Review — Tab Session Manager

**Fork:** `GuyFran/Tab-Session-Manager` (origin) — upstream `sienori/Tab-Session-Manager`
**Reviewed at:** commit `113b272` ("Update BACKERS.md"), extension version **7.4.0**
**Last reassessed:** 2026-08-19; current version **7.4.18**, documentation handoff prepared; dev build verified clean; runtime QA pending
**Review date:** 2026-08-07
**Working tree at review time:** clean, no fork-specific commits yet (993 commits, all upstream)

---

## 1. What this project is

A cross-browser WebExtension (Chrome MV3 + Firefox MV3) that saves and restores browser
window/tab state, with auto-save, tagging, search, undo/redo, backup-to-disk, and optional
Google Drive sync.

| Area | Stack |
| --- | --- |
| UI | React 16 + react-router 5, SCSS, `@svgr/webpack` |
| Build | webpack 5, Babel, `zip-webpack-plugin` → `dist/*.zip` |
| Storage | IndexedDB (`sessions` object store), `storage.local` for settings, `storage.session` for ephemeral state |
| Sync | Google Drive `appDataFolder` via OAuth2 (`identity.launchWebAuthFlow`) |
| i18n | 34 locales via Crowdin |
| License | MPL-2.0 |

Roughly 8.3k lines of JS/JSX across `src/background`, `src/popup`, `src/options`,
`src/settings`, `src/common`, `src/offscreen`, `src/replaced`.

### Architecture at a glance

- `background/background.js` — service worker; single `onMessage` switch is the app's whole RPC surface.
  Every listener calls a lazy `init()` guard because MV3 service workers restart constantly.
- `background/sessions.js` — thin hand-rolled IndexedDB wrapper (put/get/getAll/delete/search + a
  cursor-streaming `getAllWithStream` used to page large session lists into the popup).
- `background/autoSave.js` — a `temp`-tagged session is continuously rewritten (debounced 1.5 s) so
  that window-close / browser-exit can be reconstructed from it.
- `background/track.js` — "tracking" sessions keep a saved session in sync with a live window.
- `background/export.js` + `offscreen/` — Chrome MV3 service workers have no `URL.createObjectURL`,
  so exports round-trip through an offscreen document.
- `replaced/` — the lazy-loading placeholder page; tab URL/title/favicon are carried in query params.

---

## 2. Build & tooling status (current — verified 2026-08-17)

| Check | Result |
| --- | --- |
| `npm ci` | ✅ 634 packages, exit 0 |
| Dev build (`webpack.config.dev.js`) | ✅ v7.4.17: 0 errors, 27 warnings (26 upstream `moment` dynamic-locale requires plus the debug stylesheet's Sass-loader deprecation) — produces `dev/chrome` + `dev/firefox` |
| `npm run build` (dist zips) | not run since the toolchain was restored — not needed for local unpacked use (see section 4) |
| `npm audit` | ⚠️ 5 vulnerabilities (1 moderate, 4 high) — dev-only transitive deps in the webpack toolchain, not yet triaged, nothing shipped/reachable at runtime |
| `npm run format:check` | ❌ 7 files unformatted, all pre-existing upstream (see B-07, retired) |
| Tests | ❌ none exist — no test runner, no test files |
| CI | ❌ none — `.github/` has only FUNDING + issue templates |
| Lint | ❌ none — Prettier only, no ESLint |

Dev bundle sizes: popup 2.89 MiB, options 2.01 MiB, background 1.68 MiB, replaced 48 KiB,
offscreen 43 KiB. Size-only, no code splitting; not a blocker for local unpacked use.

**Note:** `src/credentials.js` is gitignored and imported by `background/cloudAuth.js`; the build
cannot resolve without it. A placeholder (empty `clientId`/`clientSecret`) is in place. If the
working tree is ever reset from a fresh clone, recreate it before building — **Drive sync will not
work with the placeholder** (see S-01, retired — sync is not used in this fork).

---

## 3. Findings

### Security / fork-specific

**S-01 — You must register your own Google OAuth client. (blocking for sync)**
`src/credentials.js` is gitignored and holds `clientId` / `clientSecret`. It is imported by
`background/cloudAuth.js` and **bundled into the shipped extension**, so the "secret" is not secret —
that is inherent to the installed-app OAuth flow and is fine, but it means the fork cannot reuse
upstream's client. `identity.getRedirectURL()` is derived from the extension ID, so a fork with a
different ID needs its own Google Cloud project, its own client, and its own registered redirect URI.

**S-02 — `credentials.js` is packaged into `dist/copiedSource-*.zip`. (verified)**
`webpack.config.dist.js` copies the whole `src` tree into the source zip (this zip exists for
Mozilla's add-on source-review requirement). Confirmed by inspecting the built artifact: the entry
`credentials.js` is present. Upstream publishes that zip. If you ever publish or share yours, your
client secret goes with it. Add an ignore for `**/credentials.js` in that `CopyWebpackPlugin`
pattern, or never distribute the source zip.

**S-03 — Permission surface is broad but justified.**
`tabs` (full URL + title of every tab), `downloads`, `unlimitedStorage`, `identity`, `alarms`,
`offscreen`. Google host permission and `tabGroups` are correctly optional and requested on demand
(`options/components/SignInButton.js:13`, `common/tabGroups.js:37`). Nothing exfiltrates data except
the user-initiated Drive sync. No `content_scripts`, no remote code. Chrome and Firefox manifests
diverge: `manifest-ff.json` additionally requests `cookies` and non-optional `tabGroups`.

**S-04 — `replaced/replaced.js` HTML-escapes injected values.** `favIconUrl` is escaped before
`insertAdjacentHTML`, and the theme value is whitelisted. Title/URL go through `innerText`/`.value`.
No injection found. Worth keeping in mind if you extend that page — its inputs come from a URL the
extension itself constructs, but they originate from arbitrary page titles.

### Correctness bugs (all pre-existing upstream)

**B-02 — `background/sessions.js:45` references an undefined `Session`.**
`DBUpdate()` calls `Session.getAll()` / `Session.deleteAll()` / `Session.put()` — the module is
`Sessions`. It would throw `ReferenceError` immediately. Currently harmless: the only call site is
commented out (`background/updateOldSessions.js:16`). It is dead code — delete it or fix it before
anyone re-enables it.

**B-03 — `background/sessions.js:109` calls an undeclared `reject`.**
Inside `deleteAll()` the promise executor is `new Promise(resolve => …)` but the `onerror` handler
calls `reject(e)`. If deleting the database ever fails, the error handler itself throws
`ReferenceError` and the promise hangs forever — so `deleteAllSessions()` never resolves and the UI
gets no feedback.

**B-04 — `popup/actions/controlSessions.js:232` — `session?.tabGroups.some(...)`.**
The optional chain guards `session`, not `tabGroups`. Adding the current tab to a session that has no
`tabGroups` key, while that tab belongs to a tab group and `saveTabGroupsV2` is on, throws
`TypeError`. Should be `session?.tabGroups?.some(...)`.

**B-05 — `background/cloudAPIs.js:32` — `file.appProperties.tag = …` unguarded.**
The read side uses `file.appProperties?.tag?.split(",")`, but the assignment target is not optional.
Any Drive file in the app folder without `appProperties` (hand-uploaded, or written by an older
version) makes `listFiles()` throw, which aborts the entire sync.

**B-06 — `background/export.js:20-27` can emit an empty export file.**
`chunkSize = Math.ceil(totalStringSize / 32MB)` is computed from byte size but used to slice the
*array*. One session larger than 32 MB gives `chunkSize = 2` while `sessions.length = 1`, so the
first chunk slices to `[]` and the user gets an extra `… .json` containing `[]` alongside the real
export.

### Code quality / maintainability

**B-07 — `npm run format:check` fails on a clean checkout.**
Unformatted: `src/background/autoSave.js`, `src/options/components/OptionsPage.js`,
`src/popup/components/PopupPage.js`, `src/popup/components/SessionItem.js`,
`src/replaced/replaced.js`, `src/settings/defaultSettings.js`, `BACKERS.md`. You cannot use
formatting as a gate until this is reset. Note `.prettierignore` excludes `_locales`, so a fix is
safe — but running `npm run format` now creates a large diff that will conflict with every upstream
merge. Decide this deliberately (see Recommendations).

**B-08 — No tests, no CI, no linter.** For an extension whose core promise is "don't lose my tabs",
the session-shape migration logic (`background/updateOldSessions.js`,
`options/components/ImportSessionsComponent.js` — which parses TSM, Session Buddy, Session Manager
and Firefox `.jsonlz4` formats) is pure, dependency-free, and the single highest-value place to add
unit tests.

**B-09 — Inconsistent `switch` scoping in `background/background.js:71-190`.**
Some cases are brace-scoped, some are not, so `name`, `property`, `afterSession`, `beforeSession`,
`sessions`, `currentSession` leak into the shared switch block scope. It compiles today, but adding
one more bare `const beforeSession` to an unbraced case is an instant `SyntaxError`. Brace every case.

**B-10 — Engine mismatch.** `package.json` pins `node: 24.13.0` / `npm: 11.7.0`; this machine has
Node 24.19.0 / npm 11.17.0. Not enforced (no `engine-strict`), and the build passes — but the pin is
exact rather than a range, so it will keep drifting.

**B-11 — Comments are predominantly Japanese.** Perfectly legitimate upstream, but if you plan to
diverge meaningfully you will be maintaining code you can't skim. Don't mass-translate (merge
conflicts); translate opportunistically in files you actually touch.

---

## 4. Scope decision — local debug use only

**Decided 2026-08-07:** this fork is for personal, local use as an unpacked ("Load unpacked")
extension. It will not be published to any store, not submitted to Mozilla, not merged back
upstream, and Google Drive sync will not be used.

That retires most of section 3. The rationale is recorded here so it isn't re-litigated:

| Retired | Why it no longer applies |
| --- | --- |
| S-01 (own OAuth client) | Sync unused. The empty placeholder `src/credentials.js` satisfies the import; the build works and the sign-in button simply fails. |
| S-02 (`credentials.js` in source zip) | That zip only exists for Mozilla's source-review requirement. `npm run build` is never run. |
| B-05 (`appProperties` sync crash) | Sync-only code path. |
| Fork strategy / extension ID / `gecko.id` | Nothing to publish, nothing to merge. No `upstream` remote needed. |
| B-07 Prettier drift, B-08 tests/CI, B-10 engines, B-11 comment language | Process hygiene for a multi-contributor project. |
| `npm audit` (5 advisories) | All dev-only transitive deps inside the webpack toolchain. Not shipped, not reachable at runtime. |

### Workflow for this fork

```bash
npm run watch-dev
```

Then `chrome://extensions` → Developer Mode → Load unpacked → `dev/chrome`.
Verified working: `dev/chrome` builds and contains `manifest.json`, `background`, `popup`,
`options`, `replaced`, `offscreen`, `icons`, `_locales`. The `dist` zips are not needed.

### Local-only risks that replace the published-extension ones

**L-01 — Extension ID path risk (resolved in v7.4.1).** Chrome would otherwise derive an unpacked
extension ID from the absolute directory path, making saved IndexedDB sessions unreachable after a
move or rename. `src/manifest.json` now has a pinned `key`, so the current Chrome ID remains
`pheckpgfalekjmbbodbggfohpghjceog`; do not remove or replace that key.

**L-02 — Backup export is off by default.** `ifBackup` defaults to `false`
(`src/settings/defaultSettings.js:268`). An extension being actively edited is precisely the one
that loses its own database. If this holds real sessions, enable backup in Options.

**L-03 — Tab-group session guard (resolved in v7.4.1).** The former conditional
`session.tabGroups` crash was fixed with `session?.tabGroups?.some(...)`; no local action remains.

---

## 5. Backlog

Completed work is documented in section 6 and the review log. Only active work remains here.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| QA-01 | In Chrome, load the v7.4.18 unpacked build; enable “Allow in Incognito”, save a private-only and a mixed session, restore each, and confirm all windows route correctly, batch size 5 is respected, tabs are discarded, and one URL-free live debug panel reports no errors. Record the observed counts/results. | P1 | ☐ User/runtime action — v7.4.15's 226-tab run confirmed batching; v7.4.16/17 changed discard verification and diagnostics afterward. |
| L-02 | Enable backup export in Options if real sessions are stored | P1 | ☐ **User action** — Options → Backup, once the extension is loaded |

Completed items and retired findings remain recorded in sections 4, 6, and 7; they are not backlog.

---

## 6. Fork features (v7.4.2) — mass-restore performance & thumbnails

Motivated by restoring sessions with thousands of tabs freezing the machine.

**F-01 — Batched tab creation** (`src/background/open.js`). Upstream fired every
`tabs.create()` in an unthrottled loop and opened multi-window sessions in parallel — thousands of
near-simultaneous create calls freeze the browser regardless of lazy loading. Now: tab creation
awaits in batches of 20 (`TAB_CREATE_BATCH_SIZE`), `createTabs` is awaited at all call sites, and
subsequent windows open sequentially. TST mode (`ifSupportTst`) keeps its original one-by-one path.

**F-02 — Page thumbnail capture** (`src/background/thumbnails.js`, new). While browsing, the
active tab is captured (`tabs.captureVisibleTab`, jpeg q70) on `tabs.onUpdated`(complete) and
`tabs.onActivated`, throttled to once per 10 s per URL, downscaled to 500 px wide (OffscreenCanvas,
jpeg q0.6, ~15–40 KB each), and stored in a dedicated IndexedDB `thumbnails` DB keyed by URL.
LRU-pruned above 3000 entries. Gated by new setting `ifCaptureThumbnails` (default on, Options →
Open, nested under lazy loading). Required adding `host_permissions: ["<all_urls>"]` to both
manifests — fine for a local extension.

**F-03 — Thumbnail shown on placeholder pages** (`src/replaced/`). The lazy-loading placeholder
looks up the thumbnail for its target URL directly in IndexedDB (same extension origin as the
background) and shows it under the title/URL. Applies to both the `redirect` (not-yet-loaded) and
`open_faild` states.

**F-04 — Preload & suspend sweep (v7.4.6)** (`src/background/preloadSweep.js`, new). After a
session restore (setting `ifPreloadAfterRestore`, default on, nested under lazy loading), each
restored window is swept in parallel, one tab at a time per window: activate the next placeholder →
explicit `replacePage(windowId)` redirect (the passive `onActivated` path only serves the focused
window) → wait for load (30 s timeout) → capture via the F-02 pipeline → `tabs.discard()` once the
next tab is activated (Chrome refuses to discard the active tab, so discard always trails by one).
Pauses while the swept window is focused (3 s recheck); toolbar badge shows the remaining count;
original active tab of each window is re-activated at the end. End state per tab: real URL, real
title, stored thumbnail, natively suspended. Message handlers `startPreloadSweep` (all normal
windows if no ids passed) / `stopPreloadSweep` power the v7.4.7 popup-header manual control.

**F-05 — Incognito restore (v7.4.8, v7.4.16)** (`src/background/open.js`, `src/background/preloadSweep.js`).
Chrome refuses to load extension pages in incognito windows under `"incognito": "spanning"`, so the
lazy-loading placeholder was skipped there (upstream `open.js`) and every restored incognito tab
loaded its real URL immediately — F-01/F-04 did nothing and a large incognito session loaded in full.
Now, when the placeholder is unavailable, each non-active tab is created with its real URL and
`tabs.discard()`ed straight away (one retry after 500 ms, since a freshly created tab is briefly
undiscardable), which reaches the same unloaded end state by a different route. The sweep's target
predicate widened from "is a redirect placeholder" to "is a redirect placeholder **or** is a
discarded incognito tab", so incognito windows now get the same load → capture → re-suspend pass and
recover their real titles. Discarded tabs in *normal* windows are deliberately excluded — those were
suspended by the user or by Chrome's Memory Saver and are not ours to reload.

v7.4.16 uses the `Tab` returned directly by Chrome's `tabs.discard()` call to determine success.
The former extra `tabs.get()` verification can reject for freshly discarded private tabs despite a
successful discard, causing an unnecessary retry and falsely reporting failure.

**F-06 — Incognito restore flooding (v7.4.9, v7.4.15)** (`src/background/open.js`). F-05's
`discardAfterCreate()` was fire-and-forget, so `createTabs()`'s batch barrier
(`await Promise.all(openedTabs)`) only waited for `tabs.create` to return, not for the discard —
restoring a large private session created every tab with its real URL and let hundreds of loads
start before any discard landed. Both call sites in `openTab()` now `await discardAfterCreate()`,
which makes the existing batch boundary meaningful: at most one batch's worth of tabs is briefly
loading at a time. New setting `incognitoTabCreateBatchSize` (Options → Open, default 5, min 1)
lets private-window batching be tuned independently of `tabCreateBatchSize`; `createTabs()` picks
between the two via `isEnabledPlaceholder(currentWindow)`.

v7.4.15 makes each batch an isolated promise list: it waits for and clears one batch before
starting the next, including the final partial batch. It also treats a saved session containing
any private window as an all-new-window restore. This prevents a leading normal saved window in a
mixed session from being restored into the popup's regular window before a later private window is
opened.

**F-07 — Live incognito restore debug (v7.4.17)** (`src/background/restoreDebug.js`,
`src/debug/`). Every restore containing private tabs automatically opens one normal extension popup
window before tab creation. It provides live, URL-free events and summary counts for effective
routing, created windows, configured and completed batches, created/failed tabs, discard outcomes,
and restore errors. It retains at most 2,000 events and updates the visible window while restoring.
Logs are copied or downloaded only by an explicit button click—there are no automatic downloads.
The debug page is excluded from saved sessions so its own window cannot pollute auto-save data.

**Known limits, by design:**
- Only pages actually *viewed* get a thumbnail — background tabs can't be captured
  (`captureVisibleTab` is active-tab-only; that's a browser restriction, same for all suspender
  extensions). Coverage accumulates as you browse.
- Chrome's own Memory-Saver-discarded tabs can't be given a placeholder image — the tab keeps its
  real URL and Chrome controls the discard; placeholders only exist for tabs the extension opens.
- Thumbnails match on exact URL.
- Incognito tabs briefly show their URL instead of the saved title, until the sweep loads them once.
  A placeholder would have shown the title immediately; discarding cannot.
- Incognito thumbnails are still gated by `ifSavePrivateWindow` (default off), so by default an
  incognito sweep loads and re-suspends but stores nothing. That is the v7.4.3 privacy decision.
- Re-running a **manual** sweep re-processes incognito tabs, because a swept tab returns to the
  "discarded incognito" state that defines the target set. Harmless but not free. The automatic
  post-restore sweep is unaffected.
- All of this requires "Allow in Incognito" to be enabled for the extension in `chrome://extensions`.
  Without it the extension cannot see incognito windows at all and nothing here applies.

---

## 7. Review log

| Date | Change |
| --- | --- |
| 2026-08-19 | **v7.4.18** — Documentation cleanse and multi-agent handoff. Updated the actual build-warning count to 27, corrected the retired audit count to 5, removed stale resolved-risk wording, moved completed items out of the active backlog, and made the exact remaining Chrome verification a single QA-01 task. `AGENTS.md` now defines the read order, single source of truth, parallel-edit safety, closeout, and runtime-evidence protocol. Documentation-only version bump; dev build: 0 errors, 27 known warnings. |
| 2026-08-18 | **v7.4.17** — Replaced automatic trace downloads with a live “Incognito restore debug” extension popup, opened before private tab creation. It displays runtime version/ID, effective routing, batch progress, create/discard outcomes, errors, and the last 2,000 URL-free events; Copy and Download are explicit actions. New debug extension page/bundle, background debug-state/message API, and auto-save ignore rule for the page. Removed obsolete `restoreTrace.js`. Dev build: 0 errors; 27 known Sass-loader deprecation warnings (26 baseline plus the same toolchain warning for the new stylesheet). Runtime verification pending. |
| 2026-08-18 | **v7.4.16** — Corrected private-restore diagnostics and discard verification after a real Chrome v7.4.15 run. Its 226-tab private session correctly used batch size 5 but created 95 cumulative trace downloads (start/window plus before/after each of 46 batches); v7.4.16 restores a single finish/error trace download. The trace showed that `tabs.discard()` was followed by a failing `tabs.get()` (`No tab with id`); Chrome returns the discarded `Tab` directly, so the second lookup was removed. Fallback tab-creation errors are now preserved in the trace instead of becoming `undefined`. Dev build: 0 errors, 26 pre-existing `moment` warnings; runtime verification pending. |
| 2026-08-18 | **v7.4.15** — Private-restore routing and live diagnostics. If a saved session contains any private window, every saved window now restores through `openInNewWindow`, preventing a mixed session's leading normal window from going into the popup's current regular window. Reworked the tab batch barrier to wait for and clear each batch (including the final partial batch) before launching another. The private-restore trace now downloads snapshots at startup, window routing/creation, and before/after every batch wait, so it is available even if the restore is stopped. The startup snapshot records the runtime version and stable extension ID for proof that the loaded code is current. Dev build: 0 errors, 26 pre-existing `moment` warnings; runtime verification pending. |
| 2026-08-18 | **v7.4.14** — Added automatic private-restore tracing. A restore involving an incognito window downloads `TabSessionManager/restore-trace-<timestamp>.log` when it finishes or errors; it records runtime version/extension ID, saved-window routing, effective batch values, per-tab create/discard results, batch waits, and errors, without page URLs. This is intended to diagnose reports of tabs leaking into the popup window and batches not waiting. Dev build emitted both manifests at 7.4.14 and contains the trace module; 0 errors, 26 pre-existing `moment` warnings. |
| 2026-08-18 | **v7.4.13** — Corrected the v7.4.12 private-batch migration so its completion marker is saved even when the user already chose a value other than the former default of 20. This preserves that choice and prevents repeated migration checks. Dev build clean: 0 errors, 26 pre-existing `moment` warnings. |
| 2026-08-18 | **v7.4.12** — Incognito restore routing and batching. A saved private window now always opens in a new private Chrome window, even when the popup's default action is “open in current window”; it cannot leak into the regular popup window. Newly created windows are explicitly re-read with `populate: true` before their initial tab is used. `createTabs()` now awaits the final partial batch before moving to another window or starting the sweep. Existing profiles whose persisted private batch setting was the old default of 20 are migrated once to 5; subsequent user-selected values remain untouched. Dev build clean: 0 errors, 26 pre-existing `moment` warnings. Runtime verification remains pending. |
| 2026-08-17 | **v7.4.11** — Lowered the configurable `incognitoTabCreateBatchSize` default and invalid/missing-value fallback from 20 to 5, reducing concurrent brief real-URL loads during a private-window restore. Dev build clean: 0 errors, 26 pre-existing `moment` warnings. |
| 2026-08-17 | **v7.4.10** — P-01/P-02. `autoSave.js` now ignores temp-session scheduling while `preloadSweep.js` reports an active sweep, preventing one whole-profile serialization per swept tab. The popup sweep control is disabled (and titled "Tab lazy loading") if lazy loading is off, so it no longer offers an action the background silently rejects. Dev build clean: 0 errors, 26 pre-existing `moment` warnings. Real-Chrome testing of F-05/F-06 could not be run in this environment because Chrome is not connected to the desktop automation bridge; runtime verification remains pending. |
| 2026-08-17 | **Documentation pass.** Added [`AGENTS.md`](../AGENTS.md) at repo root as the handoff doc for future AI agents (read order, hard constraints, build steps, current status, open backlog highlights). Cleansed this file: section 2 rewritten from the 2026-08-07 baseline (`npm install`/`dist` zips/7.4.0 bundle sizes) to the current, actually-verified state (`npm ci`, dev build, current bundle sizes, current `npm audit` count); fixed a duplicate `## 6.` heading (Review log is now section 7) and a stray doubled `---` separator; added an F-06 entry to section 6 documenting the v7.4.9 incognito-flooding fix, which previously only existed in the changelog below. No extension code changed, no version bump. |
| 2026-08-17 | **Toolchain restored (E-01).** Node 24.19.0 / npm 11.17.0 installed via `winget install OpenJS.NodeJS.LTS` (24.x line; `engines` pins 24.13.0 but is not enforced — no `.npmrc`). `npm ci` → 634 packages. `npx webpack --config webpack.config.dev.js` compiles clean: **0 errors**, 26 warnings (all `moment` dynamic-locale requires, upstream). `dev/chrome` and `dev/firefox` produced; `dev/chrome/manifest.json` reports 7.4.9 with the `key` present, and both `discardAfterCreate` and `incognitoTabCreateBatchSize` are present in the emitted `background/background.js`. `npm run format:check` fails on 7 files (`autoSave.js`, `OptionsPage.js`, `PopupPage.js`, `SessionItem.js`, `replaced.js`, `defaultSettings.js`, `BACKERS.md`) — **all pre-existing upstream**, verified by checking the pre-7.4.9 blob against the project's own `.prettierrc`; no fork change introduced any of them. `npm audit` reports 5 vulnerabilities (1 moderate, 4 high) — dev-dependency chain, not yet triaged. |
| 2026-08-16 | **v7.4.9** — F-06 incognito restore flooding. `discardAfterCreate()` was fire-and-forget, so `createTabs()`'s batch barrier (`await Promise.all`) only waited for `tabs.create` to return, not for the discard. Restoring a large private session created every tab with its real URL and let hundreds of loads start before any discard landed. Both call sites in `openTab()` now `await discardAfterCreate()`, which makes the existing batch boundary meaningful — at most one batch is briefly loading at a time. Added setting `incognitoTabCreateBatchSize` (default 20, min 1) so private-window batching can be tuned separately from `tabCreateBatchSize`; `createTabs()` picks between the two via `isEnabledPlaceholder(currentWindow)`. **Not built or run — Node absent (E-01).** |
| 2026-08-16 | **v7.4.8** — F-05 incognito restore (see section 6). `open.js`: extracted `isEnabledPlaceholder()`, added `discardAfterCreate()` with one retry, and stopped substituting the `open_faild` placeholder in windows that cannot display it. `preloadSweep.js`: new `isSweepTarget()` covering discarded incognito tabs, per-window `processedTabIds` set so a re-suspended tab is not swept twice in one run, seeding count switched to the same predicate (fixes a badge that never reached zero), `replacePage()` now only called for actual placeholders, and the sweep body wrapped in `try/finally` so `isSweeping` cannot latch on. Also fixed a latent crash in `openTab()`'s fallback path where a failed second `tabs.create` fell through to `newTab.id`. **Not built or run — Node is absent from this machine (see below); code-level change only.** |
| 2026-08-16 | Reassessment at `3c8bf9d` / v7.4.7. Confirmed the fork is 1 commit ahead of `sienori/master` (still v7.4.0) and in sync with origin. Build prerequisites have gone missing since 2026-08-08: no `node`/`npm` on PATH anywhere on the machine, no `node_modules/`, no `src/credentials.js`, no `extension-key.pem`. Open review findings recorded against the v7.4.7 sweep: auto-save thrash during sweeps (below), and the sweep button not reflecting `ifLazyLoading`. |
| 2026-08-07 | Initial fork review at `113b272` / v7.4.0. Verified `npm install`, `npm run build`, `npm audit`, `npm run format:check`. Created placeholder `src/credentials.js`. No source changes made. |
| 2026-08-07 | Scope narrowed to local unpacked debug use (section 4). Backlog cut from 15 items to 7; S-01, S-02, B-05, B-07, B-08, B-10, B-11 retired. Verified the dev build (`webpack.config.dev.js`) produces a loadable `dev/chrome`. Added local-only risks L-01 (path-derived extension ID) and L-02 (backup off by default). |
| 2026-08-08 | **v7.4.7** — manual sweep button in the popup header (update icon, after the undo/redo separator): starts a sweep over all normal windows or stops the running one; shows remaining count; highlighted while active. Background broadcasts `updatePreloadSweepStatus` (on every badge update and immediately on stop) and answers `getPreloadSweepStatus` for popup init. Modified: `preloadSweep.js`, `background.js`, `PopupPage.js`, `Header.js`, `Header.scss`, en messages. Dev build clean. Unverified: runtime UI behavior — user tests. |
| 2026-08-08 | **v7.4.6** — F-04 preload & suspend sweep (user-designed): after restore, background-load each placeholder one at a time per window, capture thumbnail, natively discard. New `preloadSweep.js`; setting `ifPreloadAfterRestore` (default on); badge progress; pause-on-focus; message handlers for manual start/stop. Dev build clean. Unverified: runtime sweep behavior — user tests. |
| 2026-08-08 | **v7.4.5** — icon redesign: replaced the flat teal floppy-disk icon with a modern gradient mark (front browser window with tab + session-list rows, ghost window behind). Rewrote `src/icons/icon.svg` + `icon_min.svg` (dedicated simplified 16px variant), regenerated `icon.png` (64) and `icon_min.png` (16) via sharp. Same teal family, visually distinct from the store version. Dev build clean. |
| 2026-08-08 | **v7.4.4** — incognito thumbnail capture now follows the existing `ifSavePrivateWindow` setting (default off → still never captured unless the user opted in to saving private windows). Batch size is now the `tabCreateBatchSize` setting (Options → Open, number input, min 1, default 20), read in `createTabs()` with a clamp. Dev build clean. |
| 2026-08-08 | **v7.4.3** — privacy fix in F-02: incognito tabs are never captured/persisted (`tab.incognito` guard in `thumbnails.js`). Storage design note recorded: thumbnails intentionally live in their own IndexedDB (`thumbnails`) separate from `sessions`, because `Sessions.deleteAll()` deletes the whole `sessions` database and a shared DB would have required a version migration against real session data. Replaced page and background duplicate the v1 schema creation — must stay in lockstep if the schema ever changes. Dev build clean. |
| 2026-08-08 | **v7.4.2** — F-01 batched/serialized tab restore, F-02 thumbnail capture module + `ifCaptureThumbnails` setting + `<all_urls>` host permission, F-03 thumbnail display on placeholder pages. New files: `src/background/thumbnails.js`. Modified: `open.js`, `background.js`, `replaced/*`, `defaultSettings.js`, `_locales/en/messages.json`, both manifests. Dev build clean (0 errors, same 26 baseline warnings). Unverified: runtime behavior (restore of a huge session, capture quality, placeholder rendering) — user tests. |
| 2026-08-07 | **v7.4.1** — implemented L-01, B-02, B-03, B-04, B-06, B-09. Generated RSA keypair; `key` added to `src/manifest.json` (Chrome ID now stable regardless of folder path: `pheckpgfalekjmbbodbggfohpghjceog`), private key kept locally in gitignored `extension-key.pem`. Version bumped 7.4.0 → 7.4.1 in both manifests. Dev build re-verified: both webpack targets compile with 0 errors (same 26 pre-existing child-compilation warnings as baseline); `dev/chrome/manifest.json` carries the key and new version. Left unverified: runtime behavior of the fixed paths (add-tab-to-grouped-session, deleteAll error path, >32 MB export) — not exercised, code-level fixes only. |
