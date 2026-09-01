# Fork Review — Tab Session Manager

**Fork:** `GuyFran/Tab-Session-Manager` (origin) — upstream `sienori/Tab-Session-Manager`
**Reviewed at:** commit `113b272` ("Update BACKERS.md"), extension version **7.4.0**
**Last reassessed:** 2026-08-28; current version **7.4.25**; dev build verified clean and the
private/mixed incognito restore (F-05/F-06/F-07) **verified in real Chrome 152** — see QA-01 in section 5
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

## 2. Build & tooling status (current — verified 2026-08-27)

| Check | Result |
| --- | --- |
| `npm ci` | ✅ 634 packages, exit 0 (not re-run 2026-08-27 — `node_modules/` already present) |
| Dev build (`webpack.config.dev.js`) | ✅ v7.4.25: 0 errors, 27 warnings (26 upstream `moment` dynamic-locale requires plus the debug stylesheet's Sass-loader deprecation) — produces `dev/chrome` + `dev/firefox` |
| Real-browser load | ✅ Chrome 152.0.7977.64, `dev/chrome` loaded unpacked, ID `pheckpgfalekjmbbodbggfohpghjceog`, Allow in Incognito on. **`--load-extension` is ignored by Chrome 152 stable** — use `chrome://extensions` → Load unpacked (see QA-01, section 5) |
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
| DBG-01 | Remove the temporary `DEBUG_RESTORE_TAB_LIMIT = 10` cap in `src/background/open.js` (the constant, the capping block in `createTabs()`, the warn/trace block in `openSession()`, the tracking-suppression branch, the three trace events, and the debug-panel banner) once the incognito restore-routing investigation is finished | P1 | ☐ **Still active in v7.4.24** — every restored window stops after 10 tabs. Since v7.4.24 a window the cap truncated is **not** tracked (protects tracked sessions from being rewritten down to 10 tabs — a confirmed data-loss path). Set the constant to `0` to disable without removing the code. |
| RTR-01 | A saved session whose tabs are not flagged `incognito` restores into a **normal** window with no warning — user-reported 2026-08-27. Root cause not yet confirmed: either the session was saved with `ifSavePrivateWindow` off (default), or `openInNewWindow()`'s `createData.incognito = firstTab.incognito` is reading a tab without the flag | P1 | ☐ Awaiting the user's answer on whether the "Incognito restore debug" window appeared during the bad restore — its absence means `hasIncognitoWindow` was false and the session held no private tabs |
| L-02 | Enable backup export in Options if real sessions are stored | P1 | ☐ **User action** — Options → Backup, once the extension is loaded |

QA-01 (real-Chrome verification of private/mixed restore) was **completed on 2026-08-27** — results
below. Completed items and retired findings remain recorded in sections 4, 6, and 7; they are not
backlog.

> **⚠ Correction (2026-08-27, later the same day).** The QA-01 pass below verified restore
> *routing*, *batching* and *discard mechanics* — it did **not** check that restored tabs kept their
> content, and they did not. Every discarded private tab came back permanently blank
> (`url: ""`, `title: ""`). See BLANK-01 in the review log; fixed in v7.4.22. Read the table below
> as "these specific properties held", not "the restore was correct".

### QA-01 result — verified in real Chrome 152 on 2026-08-27

Run against Chrome **152.0.7977.64** on Windows 10, extension loaded unpacked from `dev/chrome`
at **v7.4.18**, stable ID `pheckpgfalekjmbbodbggfohpghjceog`, **Allow in Incognito enabled**
(`chrome.extension.isAllowedIncognitoAccess() === true`). Settings were stock apart from
`ifSavePrivateWindow` turned on so private windows could be saved at all: `ifLazyLoading` on,
`incognitoTabCreateBatchSize` **5** (untouched default), `tabCreateBatchSize` 20,
`ifPreloadAfterRestore` on. Both restores were requested with property `openInCurrentWindow` —
the routing case that used to leak tabs into the popup's own window.

| Check | Scenario A — private-only | Scenario B — mixed normal + private |
| --- | --- | --- |
| Saved session | 1 private window, 12 tabs | 2 windows: normal 3 tabs + private 8 tabs |
| Requested → effective routing | `openInCurrentWindow` → **`openInNewWindow`** | `openInCurrentWindow` → **`openInNewWindow`** |
| Debug window before private tabs | ✅ `debug-panel-opened` at event 4, first `tab-created` at event 13 | ✅ `debug-panel-opened` at event 3, first `tab-created` at event 10 |
| Windows created | 1 new private window | 2 new windows (1 normal, 1 private) |
| Popup's current regular window | **untouched** — 4 tabs before and after, same tabs | **untouched** — 4 tabs before and after, same tabs |
| Private batch size | configured 5 / effective **5**; batches 5 + 5 + 2 | configured 5 / effective **5**; batches 5 + 3 (normal window used 20) |
| Tabs created | 12/12, **0 failures** | 11/11, **0 failures** |
| Discards | 11 attempted, **11 succeeded**, 0 retries, 0 errors | 7 attempted, **7 succeeded**, 0 retries, 0 errors |
| Browser-side discard truth | private window: 12 tabs, **11 discarded**, 1 active | private window: 8 tabs, **7 discarded**, 1 active |
| Error events in trace | **0** | **0** |
| Automatic downloads | **0 files** | **0 files** |
| Restore duration | 1.6 s | 19.5 s |

- **The one non-discarded tab in each private window is the active tab.** Chrome refuses to
  discard the active tab, and `openTab()` only sets `shouldDiscardAfterCreate` for non-active
  tabs. 11/12 and 7/8 are the correct, expected maxima — not failures.
- **Tabs stay discarded.** A second independent run restored the same 12-tab private session and
  sampled the window at t+5 s, +15 s, +30 s, +60 s, +90 s and +120 s: **11 discarded at every
  sample**, 0 tabs loading. Sessions also survived a full Chrome restart, re-confirming the
  pinned-`key` IndexedDB continuity (L-01).
- **Live debug panel verified in the DOM**, not just in background state: phase `FINISHED`,
  identity line `Extension 7.4.18 | ID pheckpgfalekjmbbodbggfohpghjceog | Requested:
  openInCurrentWindow | Effective: openInNewWindow`, summary tiles `Saved tabs=12`,
  `Windows created=1`, `Batch size=5`, `Batches=3/3`, `Tabs created=12/12`, `Tab failures=0`,
  `Discarded=11`, `Discard errors=0`, 61 live event lines, and the three buttons
  `Copy complete debug log` / `Download log` / `Close`.
- **No download flood.** `chrome.downloads.search({})` returned **0** items after both restores,
  confirming v7.4.16/v7.4.17 removed the automatic trace downloads.
- **Known behaviour, not a defect:** the post-restore preload sweep did not advance during either
  run (240 s wait each). The sweep pauses while the window it is sweeping has focus (F-04), and the
  freshly restored private window holds focus. Tabs therefore simply stayed discarded, which is the
  desired end state; the sweep resumes once focus moves elsewhere.

**Environment note for future runs:** Chrome 152 stable **ignores the `--load-extension` command
line switch** (`extension_service.cc`: `--load-extension is not allowed in Google Chrome,
ignoring.`). `--enable-unsafe-extension-debugging`, `--disable-features=DisableLoadExtensionCommandLineSwitch`
and `--remote-debugging-pipe` do not lift it. The extension must be loaded through the real
`chrome://extensions` → **Load unpacked** flow.

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

**Verified in Chrome 152 on 2026-08-27 (QA-01):** every non-active private tab was discarded on the
first attempt — 11/11 and 7/7 discard calls succeeded with **zero retries and zero errors**,
confirming the v7.4.16 change removed the false-failure path. Tabs remained discarded across
samples out to t+120 s.

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

**Verified in Chrome 152 on 2026-08-27 (QA-01):** both a private-only and a mixed session were
restored with the popup requesting `openInCurrentWindow`; the effective routing was
`openInNewWindow` in both cases, and the popup's own regular window kept exactly its original four
tabs. Batches ran 5 + 5 + 2 (12 private tabs) and 5 + 3 (8 private tabs) with the private window
using the dedicated size 5 while the mixed session's normal window used 20.

**F-07 — Live incognito restore debug (v7.4.17)** (`src/background/restoreDebug.js`,
`src/debug/`). Every restore containing private tabs automatically opens one normal extension popup
window before tab creation. It provides live, URL-free events and summary counts for effective
routing, created windows, configured and completed batches, created/failed tabs, discard outcomes,
and restore errors. It retains at most 2,000 events and updates the visible window while restoring.
Logs are copied or downloaded only by an explicit button click—there are no automatic downloads.
The debug page is excluded from saved sessions so its own window cannot pollute auto-save data.

**Verified in Chrome 152 on 2026-08-27 (QA-01):** the debug window opened before the first private
tab was created in both scenarios (event `debug-panel-opened` preceded the first `tab-created`), it
rendered live counts in the DOM (`Batch size=5`, `Batches=3/3`, `Tabs created=12/12`,
`Tab failures=0`, `Discarded=11`, `Discard errors=0`, 61 event lines) and exposed the
`Copy complete debug log` / `Download log` / `Close` buttons. `chrome.downloads.search({})` returned
**0** items after both restores, confirming no automatic diagnostic downloads.

**Known limits, by design:**
- Only pages actually *viewed* get a thumbnail — background tabs can't be captured
  (`captureVisibleTab` is active-tab-only; that's a browser restriction, same for all suspender
  extensions). Coverage accumulates as you browse.
- Chrome's own Memory-Saver-discarded tabs can't be given a placeholder image — the tab keeps its
  real URL and Chrome controls the discard; placeholders only exist for tabs the extension opens.
- Thumbnails match on exact URL.
- ~~Incognito tabs briefly show their URL instead of the saved title, until the sweep loads them
  once.~~ **No longer true since v7.4.22** — waiting for the navigation to register before
  discarding preserves both the URL and the title, so discarded private tabs show their real title
  immediately without being loaded.
- Incognito thumbnails are still gated by `ifSavePrivateWindow` (default off), so by default an
  incognito sweep loads and re-suspends but stores nothing. That is the v7.4.3 privacy decision.
- Re-running a **manual** sweep re-processes incognito tabs, because a swept tab returns to the
  "discarded incognito" state that defines the target set. Harmless but not free. The automatic
  post-restore sweep is unaffected.
- All of this requires "Allow in Incognito" to be enabled for the extension in `chrome://extensions`.
  Without it the extension cannot see incognito windows at all and nothing here applies.
- The restored private window keeps focus, and the post-restore sweep pauses while its target window
  is focused (F-04). In practice the sweep therefore does not start until you switch away — observed
  over 240 s in the 2026-08-27 QA run. Tabs stay discarded in the meantime, which is the intended end
  state, so this is a timing characteristic rather than a fault.

---

## 7. Review log

| Date | Change |
| --- | --- |
| 2026-09-01 | **v7.4.47 — trace identity is index-only: no URL, no title.** Per user requirement, the tabRef attached to failure events (v7.4.46) drops the title — events identify a tab solely by its position in the window (index) plus internal tab id. Verified: the full exported debug JSON contains zero "title" and zero "url" fields, poisoned-tab events read {index: N} only, and Export JSON still works. |
| 2026-09-01 | **v7.4.46 — failure events identify the tab (index + title, never the URL); reliable Export JSON in the panel.** Every failure-class trace event now carries a tabRef — the tab's **window index and title (first 48 chars)** — so "which tab failed and why" is answerable from the panel without recording URLs: restore events (tab-create-start/error, tab-url-commit-timeout, tab-url-renavigate, tab-discard-skipped-no-url, tab-discard-error/failed, tab-blank-repair, and per-tab saved-blank-url listing each poisoned entry), sweep events (sweep-tab-loaded, capture-skipped, sweep-tab-swapped, sweep-tab-bg-processed, sweep-ph-commit-timeout), and thumb-failed. Sanitization now runs on ALL events centrally in appendEvent (restore-trace included), so a title containing a URL-like string is scrubbed before recording. The panel's Download button (background downloads API, unreliable with data: URLs in MV3) is replaced by **Export JSON**: the panel page itself builds a Blob and saves tsm-debug-<timestamp>.json — always works. **Verified in Chrome 152:** poisoned restore produced two saved-blank-url events with index identities and zero URL leakage; Export JSON saved a valid 41-event file; save-mid-load still records 4/4 real URLs. |
| 2026-09-01 | **v7.4.45 — about:blank tabs root-caused: two sources, both fixed, both traced.** User report: tabs still restored as about:blank; upstream never did this, so the fault was in fork changes. **(1) The sweep swap (the actual regression):** swapToPlaceholderAndDiscard waited a fixed 300 ms before discarding the freshly created data:URL placeholder. With 1600 px thumbnails (30–60 KB URLs) and parallel sweeps, registration can take longer; discarding then destroyed the placeholder navigation → about:blank tab with URL *and* title lost. Now the swap polls until the placeholder tab actually reports its data: URL (up to 5 s) and only then discards; on timeout it leaves the placeholder undiscarded (it renders correctly either way) and logs sweep-ph-commit-timeout + swap-ph-commit step events to the debug panel. **(2) The save side (second source):** a session saved while tabs are still loading stored about:blank because Chrome exposes the destination only in pendingUrl until commit — pendingUrl was used nowhere. save.js and popup controlSessions.js now fall back to pendingUrl. Restores also detect already-poisoned sessions: a savedBlankUrls counter + red banner ("Blank in saved data") explains that those tabs can only open blank and how to fix by re-saving. **Verified in Chrome 152:** 4 tabs saved mid-load (url empty, pendingUrl set) → session recorded 4/4 real URLs; a hand-poisoned session flagged exactly its 2 blanks; full sweep regression green (5/5 placeholders with correct fragments, 6/6 thumbnails, roundtrip 6/6 real URLs / 0 leaks, groups preserved, zero commit timeouts). |
| 2026-08-30 | **v7.4.44 — debug panel: reopen button, session-persistent data, group-creation tracking.** (1) A 🐞 button in the popup's Open-windows header reopens (or focuses) the debug panel any time. (2) Debug data now survives service-worker restarts: the state is mirrored to storage.session (persisted on each broadcast, hydrated at SW start, cleared by the Clear button and browser exit) — so reopening the panel later in the same browser session shows everything. getRestoreDebug() awaits hydration. (3) Restore-time tab-group creation is instrumented: createTabGroups() now awaits tabs.group and emits tab-group-created {groupId, tabCount} / tab-group-error {error}; the panel's "Tab groups created" tile shows created(/planned) with grouped-tab count, the Group errors tile aggregates create+regroup failures, and a red banner surfaces the last group error verbatim. Sweep window skips (with reasons) also get an explainer line. **Verified in Chrome 152:** a grouped incognito session restored with tab-group-created (3 tabs, 0 errors), persisted state present in storage.session (35 events), and the 🐞 button opened the panel showing the group tiles. |
| 2026-08-30 | **v7.4.43 — blank-URL regression root-caused and closed (BLANK-01 hardening).** User report: some tabs restored with an empty URL. Root cause: discardAfterCreate() called waitForUrlCommit() but **ignored its result** — when the 3 s commit wait expired (routine under heavy restores or slow pages, whose navigation only commits when response headers arrive), the tab was discarded mid-navigation anyway, permanently blanking it. Fix is a three-layer guard using the saved tab URL (now passed to discardAfterCreate): (1) commit timeout → explicitly re-navigate to the intended URL and wait again; (2) still uncommitted → **refuse to discard** (the tab keeps loading; the manual sweep can hibernate it later — far better than a blank tab); (3) if a discard ever returns hasUrl=false → repair by re-navigating the discarded tab and discarding again. New trace events: tab-url-renavigate, tab-discard-skipped-no-url, tab-blank-repair. **Verified in Chrome 152** with a server that stalls response headers 9 s during restore (guaranteed blanks before): 8/8 tabs ended with correct URLs, 0 blanks, trace showed 3 renavigates + 3 refused discards. |
| 2026-08-30 | **v7.4.42 — always-visible "Open windows" panel replaces the hidden sweep dropdown.** User feedback: the dropdown menu gave no visible listing of open windows, so there was no easy UI to sweep one window or all. The popup sidebar now has a permanent **Open windows** panel between the filter row and the session list: a header with the window count and a **Sweep all** button (parallel), and one row per open window — 🪟/🕶 badge, active-tab title (current window pinned first as "This window"), tab count, per-window remaining counter while sweeping, and a Sweep/Stop button per row. The list refreshes every 3 s while the popup is open. getPreloadSweepStatus() now also returns remainingByWindow. The interim dropdown menu, its ▾ toggle and the filter-row sweep icon were removed; the header button keeps the global sweep. |
| 2026-08-30 | **v7.4.41 — sweeps are manual-only now.** The automatic post-restore sweep (startPreloadSweep(restoredWindowIds) behind ifPreloadAfterRestore) is removed from open.js — restored tabs simply stay hibernated at their real URLs until the user asks for a sweep. Exactly two entry points remain, both manual from the popup: the **header sweep button** now runs the global sweep — every open window in parallel (re-click = stop all) — and the **filter-row menu** offers Sweep all windows plus per-window Sweep/Stop rows. The deferred-resume machinery stays (it re-runs a *user-started* sweep whose window was hidden, once that window is focused). The ifPreloadAfterRestore setting is now inert. **Verified in Chrome 152:** after a 6-tab private restore, isSweeping stayed false for 20 s and 0 placeholders appeared; the manual global sweep then ran and finished in 13 s with 5/5 placeholders. |
| 2026-08-30 | **v7.4.40 — debug panel: skip-reason breakdown and tab-group visibility.** "Thumb skipped" alarmed the user, but skips are de-duplication, not lost thumbnails — the tile is now labeled "(benign)" and a plain-language explainer lists the per-reason counts (rate-limit = duplicate attempt for an already-captured URL: the sweep plus two passive listeners fire for the same tab and only one must succeed; pre-check = tab still loading / not http(s); private-gate = passive incognito capture with save-private-windows off). Summary tracks thumbSkipReasons per reason. Tab groups: restore now emits tab-groups-restore (group count + grouped-tab count) and the sweep swap emits sweep-tab-regrouped ok/error per placeholder; new tiles "Tab groups restored", "Groups kept on hibernate", and a warning "Group errors" tile when a regroup fails. |
| 2026-08-30 | **v7.4.38 — parallel per-window sweeps + sweep menu, and two engine fixes the parallel work exposed.** The sweep engine now runs one concurrent run per window (windowId→run map replaces the single-run globals); status carries sweepingWindowIds, the badge sums remaining across runs, stopPreloadSweep(windowId) stops one window (no arg stops all), and the deferred auto-resume can start while other windows sweep. The popup filter-row sweep button opens a menu: Sweep all windows, plus one row per open window (This window / active-tab title, tab count, incognito badge) with Sweep/Stop per row. Engine fixes: (1) activation only auto-reloads a discarded tab in the FOCUSED window (measured: visible-but-unfocused windows sat unloaded for the full 30 s timeout) — the sweep now issues an explicit tabs.reload(), which works regardless of focus, making parallel sweeps possible and every sweep faster; (2) captureVisibleTab() can hang forever (never settles) on a window with no drawable frames, and one hang froze the shared capture queue for ALL windows — every capture now races a 5 s timeout (this also explains the historic run-14 stall). **Verified in Chrome 152:** two tiled incognito windows (5 tabs each) swept concurrently — sweepingWindowIds held both ids — completing BOTH in 15 s with 4/4 thumbnails and 4/4 placeholders per window; single-window regression suite green (6/6 thumbnails, 5/5 placeholders, save roundtrip 6/6 real URLs / 0 leaks, stays-on-placeholder, order intact). |
| 2026-08-30 | **v7.4.37 — DEBUG_RESTORE_TAB_LIMIT removed; DBG-01 closed.** The temporary 10-tabs-per-window restore cap (added v7.4.20 for the incognito routing investigation, per-window since v7.4.21, tracking-protected since v7.4.24) is fully deleted from open.js: the constant, the openSession() warn/trace block, the createTabs() capping block, and the truncated-window tracking suppression (tracking now always starts for tracked sessions). The debug panel banner code remains but can never fire (summary.debugTabLimit stays null). **Verified in Chrome 152:** a 14-tab private session restored 14/14 with all URLs intact, 0 blank tabs, and 0 debug-tab-limit events in the restore trace. |
| 2026-08-30 | **v7.4.36 — sweep button in the filter row; debug panel gets Clear + reliable scrolling.** The header sweep button was easy to miss, so a second manual-sweep button (same current-window immediate sweep, same stop-on-reclick, remaining-count badge) now sits in the session-list filter row next to the search icon. Debug panel: a **Clear** button empties the log (background clearRestoreDebug() drops the session; the next event lazily recreates it), and the event log now actually scrolls — html/body/root are pinned to viewport height so the flex event log gets the scrollbar instead of the page growing unbounded. Verified with CDP screenshots of both surfaces. |
| 2026-08-30 | **v7.4.35 — manual sweep of the current window from the popup.** User report: the automatic sweep-on-focus resume seems unreliable in real use, so the popup sweep button (header, update icon) is now a dependable manual trigger: it sweeps the **current window** (was: all windows), starts **immediately** (a manual flag skips the 10 s wait-while-focused courtesy delay — the user explicitly asked for the sweep and is watching the window), and removes that window from the deferred list so a later auto-resume cannot double-fire. Clicking again while sweeping still stops the sweep. Verified in Chrome 152 with auto-resume deliberately disabled (deferred list wiped): focusing the window starts nothing, the manual message starts the sweep within ~2 s and completes 6/6 thumbnails, 5/5 placeholders, roundtrip save clean, tab group preserved. |
| 2026-08-30 | **v7.4.34 — near-fullscreen thumbnail, and the first-tab thumbnail loss root-caused and fixed.** Display: the placeholder image now flex-fills the whole viewport minus a slim bottom bar (title · hint · Open page button); captures raised 920→1600 px (~14 KB JPEGs). The persistent "first tab has no thumbnail" (5/6 in most runs, always the first tab the resumed sweep processes) was root-caused via new per-step debug events: during the hidden phase the first renderability probe can race the focus transition and report true, the sweep then activates the tab in an unrendered window where it never loads (30 s timeout, no capture) — and the deferral exit path swapped that unloaded tab into a thumbnail-less placeholder, which future sweeps exclude, locking the miss in permanently. Fix: sweepWindow() tracks completedTabIds and swapToPlaceholderAndDiscard() only swaps tabs whose load actually completed; unfinished tabs get a plain discard and stay sweep targets, so the resumed sweep re-processes them. Also added a 3-attempt capture retry before each swap. **Verified: 6/6 thumbnails including the first tab** — plus full suite green (5/5 placeholders, roundtrip 6/6 real URLs / 0 leaks, stays-on-placeholder, tab-group + order preserved). Per-tab order inside tab groups confirmed preserved (3-tab group, exact original sequence). |
| 2026-08-29 | **v7.4.33 — readable placeholder URL.** The placeholder data:URL was fully percent-encoded (`%3C!doctype%20html…`) — an unreadable wall of hex (user report). A data:URL path only *requires* `%` and `#` escaped; everything else round-trips raw through tabs.create → tab.url → render → discard → fragment parse (probed with a title containing `%`, `#`, `<>`, `&`, quotes and non-ASCII). The builder now: puts `<title>PAGE TITLE · hibernated</title>` FIRST so the address bar reads `data:text/html;charset=utf-8,<title>QA Page 2 · hibernated</title><style>…`; uses rgb() instead of `#hex` colors so the body needs no `#` escapes; and escapes only `%`→`%25` and `#`→`%23`. (Also answered in-session: an extension-hosted template page like replaced/index.html is impossible in incognito — spanning mode renders an error interstitial and tabs.create with an extension URL silently re-routes to a normal window; split mode would break shared session storage.) Verified: full proof suite green — 5/5 placeholders, save roundtrip 6/6 real URLs / 0 leaks, stays-on-placeholder, tab group preserved. |
| 2026-08-29 | **v7.4.32 — placeholder polish from user feedback: bigger thumbnail, manual load, tab-group preservation.** (1) Thumbnails now captured at 920 px wide (was 500) and displayed near full-width (`min(94%,1400px)`) on the placeholder — stored blobs roughly double (~7.5 KB vs ~3.6 KB in QA). (2) The placeholder no longer auto-loads the real page on activation: it stays put showing the thumbnail, with an **Open page** button; clicking the button, the thumbnail image, or pressing Enter loads the real URL. (3) The swap (create-placeholder → remove-original) was dropping the tab out of its tab group; the sweep now re-inserts the placeholder into the original tab's group via `tabs.group({tabIds, groupId})` (works with the "tabs" permission; guarded for Firefox which lacks the API). Also added temporary `sweep-step` markers (wait-load/capture/swap phases) to the debug event stream after one non-reproducing sweep stall — they pinpoint the exact step if it recurs. **Verified in Chrome 152:** two tabs grouped before the sweep kept their group id on their placeholders; activation stays on the placeholder (no auto reload); the button loads the real page; 5/5 placeholders, save roundtrip still 6/6 real URLs with 0 data: leaks. |
| 2026-08-29 | **v7.4.31 — incognito tabs now hibernate on a thumbnail placeholder instead of the real URL.** User report: hibernating incognito tabs at their real URL made thumbnails pointless — activating a tab immediately reloaded the real page and nothing was ever shown. Root constraint (verified with DOM evidence): under `"incognito": "spanning"` an incognito tab navigated to a chrome-extension:// page renders Chrome error interstitial (`main-frame-error`, no script execution), `tabs.create` with an extension URL into an incognito window silently re-routes the tab to a normal window, and `tabs.update` to a `data:` URL is silently ignored — but **`tabs.create` with a `data:` URL into an incognito window works** (renders, keeps incognito, survives discard with URL+title intact, full URL incl. fragment readable). New `background/incognitoPlaceholder.js` builds a self-contained data:URL page: embedded thumbnail JPEG, real title, real URL + title + http favicon in a `#tsm=` fragment, and an inline script that redirects to the real URL the moment the page becomes visible (normal-window lazy-loading parity). The sweep now finalizes each captured incognito tab by **create-placeholder → remove-original → discard-placeholder** (`swapToPlaceholderAndDiscard`); `isSweepTarget` excludes finished placeholders (else infinite re-processing). Session-save integrity: `save.js` (covers manual, auto-save and tracking via `loadCurrentSession`) and popup `controlSessions.js` map placeholder tabs back to real URL/title/favicon before persisting. **Verified in Chrome 152:** after restore+sweep, 5/5 non-active incognito tabs are discarded data-placeholders; re-saving the session yields 6/6 real URLs with 0 data-URL leaks; activating a placeholder lands on the real page; `sweep-tab-swapped` events in the debug panel; URL-leak check clean. |
| 2026-08-29 | **v7.4.29 — sweep/thumbnail diagnostics streamed to the debug panel (URL-free), plus a resume deadlock fix the new tracing exposed.** User still reported missing thumbnails, so the Incognito restore debug window now traces the entire capture pipeline with zero URLs recorded (details are scrubbed of URL-like strings before recording; automated leak check clean): thumb-stored/thumb-failed/thumb-skip events with reasons (pre-check, rate-limit, rate-limit-queued, private-gate) keyed by tab id only; sweep lifecycle events (start, per-window start/finish/skip/error, per-tab renderable checks and load results, deferral, deferred-resume, iteration cap); new summary tiles (Thumbs stored / Thumb failures / Thumb skipped / Sweeps deferred), a last-failure banner, and a plain-language banner explaining that a deferred sweep resumes when the window is focused. A sweep-only debug session is lazily created if the SW restarted since the restore, so an open panel keeps receiving events. The tracing immediately exposed a deadlock: resuming the instant a window is focused can find it not yet rendered (Chrome render lag), re-defer it, and never get another focus event — fixed by polling renderability up to 8 s (waitForRenderable) and retrying on a 3 s timer when deferring an already-focused window. Verified in Chrome 152: 6/6 thumbnails, 1 defer / 1 resume, 0 capture failures, URL leak check clean, panel screenshot captured. Doc entry added in v7.4.30. |
| 2026-08-28 | **v7.4.28 — capture quota exhaustion fixed; 6/6 thumbnails, repeatable.** With v7.4.27's deferred sweep running, one random tab per run still lost its thumbnail (5/6 across four runs, a different tab each time). Lightweight tracing added to `captureActiveTab()` (`globalThis.__thumbLog`, kept) produced the smoking gun: `This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota` — Chrome hard-limits `captureVisibleTab()` to 2 calls/second, the sweep processes cached pages ~600 ms apart, and each tab fires up to three capture attempts (sweep + passive `onActivated` + passive `onUpdated`), so the burst tripped the quota and all of one tab's attempts failed inside the same second with no retry. Two fixes in `thumbnails.js`: (1) the per-URL rate-limit stamp moved to *after* a successful store, so a transient failure no longer poisons the 10 s dedupe window and blocks the concurrent duplicate that would have succeeded; (2) all captures now run through a serialized queue with 600 ms spacing (`enqueueCapture`), with the dedupe re-checked inside the queue so sweep/passive duplicates drop out instead of burning quota. **Verified twice consecutively in Chrome 152: 6/6 incognito thumbnails, 5 hibernated + 1 active, deferred sweep auto-resume intact.** Visual proof captured (mid-sweep shot, final window shot, and a proof page rendering the six JPEGs read back from IndexedDB). Dev build 7.4.28: 0 errors, 27 known warnings. |
| 2026-08-28 | **v7.4.27 — hidden-window sweep fixed: defer to focus instead of silently failing.** User report: after restore, tabs got "refreshed" but no thumbnail was captured and hibernation misbehaved. Reproduced in Chrome 152: when the restored incognito window is NOT rendered (covered by another window, minimized — e.g. the popup/debug window keeps focus after restore), the sweep degraded completely: activating a discarded tab in an occluded window does **not** reload it (probe: still `unloaded` after 6 s), so every tab burned the full 30 s `waitForLoad` timeout, and `captureVisibleTab()` fails with *"view is invisible"* — 1/6 thumbnails, ~30 s/tab. Probes established the primitives: `tabs.reload()` and `tabs.update({url})` DO load in background windows; capture never works there. Fix: `sweepWindow()` probes `isWindowRenderable()` (one cheap capture attempt) per tab. Rendered → existing activate/load/capture/discard path. Hidden + placeholder (normal windows) → background-navigate to the real URL without activation, then discard — real URL/title preserved, no thumbnail possible. Hidden + incognito discarded tab → the window is registered in `storage.session` (`deferredSweepWindowIds`, survives SW restarts, cleared on browser exit) and the sweep moves on; a new `windows.onFocusChanged` listener re-launches the sweep for that window the moment the user focuses it, capturing thumbnails while the window is actually rendered. **Verified in Chrome 152 (repro-check):** phase A with the incognito window fully covered — sweep exits in ~37 s total (was 180 s+ of dead timeouts), tabs untouched (URL/title/discard intact), deferral registered; phase B on focusing the window — deferred sweep auto-starts in ≤4 s, terminates in 16 s, 5/6 thumbnails stored, 5/6 tabs re-hibernated (the miss was harness focus-flapping during one capture). Dev build 7.4.27: 0 errors, 27 known warnings. |
| 2026-08-28 | **v7.4.26 — incognito thumbnail capture no longer gated on `ifSavePrivateWindow` during the sweep.** `shouldSweepWindow()` skipped incognito windows and `captureActiveTab()` refused incognito tabs whenever `ifSavePrivateWindow` was off — but that setting's purpose is who gets *saved*, not who gets a thumbnail after the user explicitly restored a session. The sweep now requires only `ifCaptureThumbnails` (default on) and calls `captureActiveTab(windowId, { fromSweep: true })`, which bypasses the private-window gate; the passive browse-time path keeps the gate. (Note: `save.js` skips incognito tabs even on manual save while the setting is off, so anyone restoring private sessions necessarily has it on — this change matters for mixed/edge configurations, and the real user-reported failure turned out to be the hidden-window defect fixed in v7.4.27.) Dev build 7.4.26: 0 errors, 27 known warnings. |
| 2026-08-28 | **v7.4.25 — incognito thumbnail capture verified; v7.4.24's last caveat closed.** No code change. Three capture paths exercised in real Chrome 152 with `ifSavePrivateWindow` on: (1) a direct `captureVisibleTab()` against an incognito window returned a 21,055-byte JPEG — notably while the OS foreground was a different application, so capture does not require OS-frontmost status, only that Chrome renders the window; (2) the passive browse-time path (`tabs.onUpdated` complete) stored a thumbnail for the incognito page (3,876-byte blob keyed by its URL); (3) the end-to-end path — a 6-tab private session restored and swept — stored **6/6 incognito thumbnails** (3.5–3.7 KB blobs, one per URL) with the sweep terminating in 31 s. The v7.4.24 run that stored zero was an environment condition of that automation run (window not rendered), not a code defect. Documentation-only version bump; dev build at 7.4.25: 0 errors, 27 known warnings. |
| 2026-08-28 | **v7.4.24 — adversarial review of the reload/sweep path; four confirmed critical defects fixed.** A 16-agent review (4 reviewers over sweep-loop / cross-module races / thumbnails-DB / restore-integration, then 2 independent adversarial verifiers per finding) confirmed 4 distinct defects, 10/10 verifier votes, none refuted. **(1) Incognito sweep never terminated:** `processedTabIds` records the pre-discard tab id, but `tabs.discard()` assigns a NEW id, so every hibernated `incognito && discarded` tab re-qualified as a sweep target; with ≥2 private tabs the two lowest-index tabs ping-pong forever, later tabs starve, `isSweeping` sticks true and blocks all future sweeps. Fix: `discardProcessedTab()` awaits the discard and records the returned new id, plus a `2×tabs+20` iteration cap as a backstop. **(2) Browser-wide `handleReplace` suppression stranded user-clicked placeholders** in other windows for the whole sweep. Fix: suppression now applies only to events from the currently swept window (`getSweepingWindowId()`), and `handleReplace` navigates the **event's** window explicitly — the first attempt kept the default `WINDOW_ID_CURRENT` target, which can disagree with the event window, and failed live verification; the amended version passes. **(3) IDB upgrade deadlock:** placeholder pages held never-closed `thumbnails` connections pinned at version 1 with no `onversionchange`, so the background's recovery upgrade blocked forever and `await captureActiveTab()` froze the sweep; a version-1 open against an upgraded DB would also throw `VersionError`. Fix: `replaced.js` opens unversioned, closes its connection when done, and closes on `versionchange`; background `openDB()` gets the same `versionchange` handler plus a 10 s watchdog so a blocked upgrade degrades to "no thumbnail" instead of a frozen sweep. **(4) `DEBUG_RESTORE_TAB_LIMIT` + tracked sessions = permanent data loss:** restoring a tracked session under the cap let `updateTrackingSession()` overwrite the saved window with the truncated live one (40 tabs → 10, 30 gone irreversibly). Fix: tracking is suppressed for any window the debug cap truncated, with a `debug-tab-limit-tracking-suppressed` trace event. **Verified in Chrome 152:** incognito 6-tab sweep terminates in 31 s (7.4.23: provably never), all tabs at real URLs/titles, hibernated; normal 10-tab sweep 42 s with 10/10 thumbnails; a placeholder activated in another window mid-sweep resolves in 1 s (was: never). **Full restart scenario PASS:** an 8-tab incognito session saved, Chrome fully killed and relaunched on the same profile — same extension ID, incognito access persisted, session intact (8 tabs, URLs correct) — and reopened into a new private window: 8/8 created, 7 discarded + 1 active, 0 blank tabs, 0 errors, sweep terminated in 33 s. (Its one caveat — incognito thumbnail capture unverified under automation — was closed the same day: see the v7.4.25 entry above.) Dev build at 7.4.24: 0 errors, 27 known warnings. |
| 2026-08-27 | **v7.4.23 — the post-restore sweep never actually worked; five separate faults fixed.** The "load → capture thumbnail → hibernate" pass (F-04) was inert in practice. (1) **It never started.** `waitWhileWindowFocused()` looped forever while the swept window had focus — and the window just restored *is* focused — so the sweep sat idle indefinitely (measured: 240 s, zero progress). Now bounded to 10 s, and once that budget expires the window is swept anyway; the give-up is remembered per window, otherwise every tab paid the 10 s again. (2) **Windows were swept via `Promise.all`**, so N windows loaded pages simultaneously and undid the batching phase 1 works to enforce; windows are now processed one at a time. (3) **Incognito windows were swept for nothing** — `captureActiveTab()` bails on `tab.incognito && !ifSavePrivateWindow` (off by default), so every private tab was loaded and re-discarded storing nothing; such windows are now skipped, which is safe since v7.4.22 keeps their real URL/title without sweeping. (4) **Placeholders never advanced to their real URL.** `replacePage()` queries the *active* tab and self-retries via `setTimeout`, which is unreliable inside the sweep loop; the sweep now navigates the exact tab directly. On top of that the `tabs.onActivated` → `handleReplace()` listener fired for every tab the sweep activated and issued a *second*, competing navigation on the same tab — the two fought and neither committed, leaving tabs discarded while still placeholders. `handleReplace()` now returns early while `isPreloadSweeping()`. (5) **Thumbnails could never be stored.** The `thumbnails` IndexedDB is opened by both the background and every placeholder page; a restore opens many placeholders at once, so they raced the background's `open()` and the database was created *without* its object store — and `thumbnails.js` cached that broken connection in `let DB` forever, so every capture failed with `One of the specified object stores was not found`. `openDB()` now verifies the store exists, never caches a connection lacking it, and forces a version upgrade to create it; `replaced.js` no longer double-creates the store and tolerates its absence. **Verified in Chrome 152** on a 6-tab restore with the window deliberately left focused: sweep completed in **15 s** (previously 100–130 s of 30 s-per-tab timeouts, or never), **all 6 thumbnails captured**, and all five non-active tabs ended at their real URL with their real title, natively discarded. The active tab stays a placeholder by design — Chrome cannot discard it. Dev build at 7.4.23: 0 errors, 27 known warnings. |
| 2026-08-27 | **v7.4.22 — BLANK-01: incognito restore was permanently destroying every tab's URL.** User-reported ("the restored tabs have empty url") and reproduced: after restoring an 8-tab private session, the active tab was correct but all 7 discarded tabs had `url: ""`, `title: ""`, `status: unloaded`, and `pendingUrl: undefined` via both `tabs.query` and an explicit `tabs.get`. Activating one did **not** recover it — it stayed blank, and the CDP target list showed the tabs as genuinely empty pages. The saved IndexedDB data was intact throughout, so the loss happened during restore. **Root cause:** `tabs.create()` resolves before the new tab's navigation has been registered, and F-05's `discardAfterCreate()` discarded immediately, throwing the pending navigation away and leaving a tab with no navigation entry to reload. Isolated with a five-way `chrome.*` timing experiment in an incognito window: immediate discard → `url: ""`; a 300 ms sleep, waiting for the URL to appear, or waiting for `status: complete` → URL **and** title preserved. Waiting for the URL took only ~50 ms. **Fix:** new `waitForUrlCommit()` polls `tabs.get()` every 50 ms (3 s cap) until the tab reports a non-`about:blank` URL before discarding. The same experiment also showed `tabs.discard()` assigns the tab a **new id** (`No tab with id` on the old one), so `discardAfterCreate()` now returns the discarded tab's id and `openTab()` updates `tabList` with it — previously `tabList` held stale ids after every private-tab discard. Added a `blankTabs` summary counter (a discard that returns no URL) plus `urlCommitTimeouts`, a red panel banner, and a "Blank (URL lost)" tile so this failure can never be silent again; the trace records only `hasUrl: true/false`, never the URL. **Verified in Chrome 152:** the same 8-tab private session now restores with all 8 URLs *and* titles intact, 7 discarded + 1 active, and activating a discarded tab loads it to `status: complete`. Dev build at 7.4.22: 0 errors, 27 known warnings. |
| 2026-08-27 | **v7.4.21 — `DEBUG_RESTORE_TAB_LIMIT` is now per window, not per session (DBG-01).** The v7.4.20 session-wide budget could let a large leading normal window consume the whole allowance and leave a later private window with zero tabs — useless for diagnosing RTR-01, which is precisely about the private window. The cap now applies independently to each restored window, which also removed the `budget` object and its threading through `openSession()`/`createTabs()`; `createTabs()` slices its own sorted list. Panel banner reworded to "per window". **Verified in Chrome 152:** a mixed session of 26 saved tabs (normal 12 + private 14) restored 20 — normal window 10 (2 skipped) and private window 10 (4 skipped), with a separate `debug-tab-limit-applied` event per window, 2 new windows, effective routing `openInNewWindow`, and the private window at 10 tabs / 9 discarded. Under the previous session-wide budget that private window would have received 0 tabs. Private-only 12-tab case unchanged at 10 restored / 2 skipped. Dev build at 7.4.21: 0 errors, 27 known warnings. |
| 2026-08-27 | **v7.4.20 — temporary `DEBUG_RESTORE_TAB_LIMIT` (DBG-01).** Added a testing cap in `src/background/open.js`: `DEBUG_RESTORE_TAB_LIMIT = 10` restores at most 10 tabs per session, counted across every window of that session, so large sessions can be exercised quickly while RTR-01 is diagnosed. A `budget` object is threaded from `openSession()` into `createTabs()`, applied after the tabs are index-sorted so the tabs kept are the first ones; a window whose budget is exhausted returns before the batch/discard machinery runs. Emits `debug-tab-limit` and `debug-tab-limit-applied` trace events, `log.warn`s on every restore, and the debug panel shows a red "DEBUG TAB LIMIT ACTIVE" banner so the cap cannot be mistaken for a restore failure. Set the constant to `0` to disable. **Verified in Chrome 152:** private-only 12-tab session → 10 restored / 2 skipped into a new private window (10 tabs, 9 discarded); mixed session (normal 3 + private 8, 11 tabs) → 10 restored / 1 skipped as normal 3 + private 7, still 2 new windows with effective routing `openInNewWindow` and the private window at 7 tabs / 6 discarded. Note the budget is session-wide, so a large leading normal window can starve the private window of its share. Dev build at 7.4.20: 0 errors, 27 known warnings. |
| 2026-08-27 | **v7.4.19 — QA-01 closed: private/mixed incognito restore verified in real Chrome 152.** Drove Chrome 152.0.7977.64 with an isolated profile over the DevTools protocol, loading `dev/chrome` (v7.4.18) through the real `chrome://extensions` → Load unpacked flow and enabling Allow in Incognito. Both scenarios restored with the popup requesting `openInCurrentWindow`. **Private-only (12 tabs):** effective routing `openInNewWindow`, 1 new private window, batch size 5 (batches 5+5+2), 12/12 tabs created, 0 failures, 11/11 discards succeeded with 0 retries and 0 errors, 0 trace events of any error type, popup's regular window unchanged at 4 tabs. **Mixed (normal 3 + private 8):** effective routing `openInNewWindow`, 2 new windows, private batch 5 (5+3) while the normal window used 20, 11/11 tabs created, 0 failures, 7/7 discards succeeded, popup's regular window unchanged at 4 tabs. The debug window opened before the first private tab in both runs and rendered live counts plus the Copy/Download/Close buttons; `chrome.downloads.search({})` returned 0 items, confirming no automatic download flood. A second run sampled the restored private window at t+5/15/30/60/90/120 s and found 11 tabs discarded at every sample, so tabs stay discarded; saved sessions also survived a Chrome restart, re-confirming the pinned-`key` IndexedDB continuity. The one non-discarded tab per private window is the active tab, which Chrome refuses to discard — the expected maximum. Also recorded that Chrome 152 stable now **ignores `--load-extension`**, so unpacked loading must go through the extensions page. Documentation-only version bump; dev build at 7.4.19: 0 errors, 27 known warnings. |
| 2026-08-19 | **v7.4.18** — Documentation cleanse and multi-agent handoff. Updated the actual build-warning count to 27, corrected the retired audit count to 5, removed stale resolved-risk wording, moved completed items out of the active backlog, and made the exact remaining Chrome verification a single QA-01 task. `AGENTS.md` now defines the read order, single source of truth, parallel-edit safety, closeout, and runtime-evidence protocol. Documentation-only version bump; dev build: 0 errors, 27 known warnings; pushed as `88618c8`. |
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
