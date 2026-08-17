# AGENTS.md — handoff for the next AI agent

This is a personal fork of a Chrome/Firefox extension, used for local unpacked debug only.
Read this file first; it points to everything else. Written 2026-08-17.

## Read order

1. **This file** — orientation, constraints, how to build.
2. [`docs/FORK-REVIEW.md`](docs/FORK-REVIEW.md) — the full record: architecture, every fork
   feature (section 6), the open backlog (section 5), and a dated changelog of every change
   made to this fork (section 7). That file is the source of truth for status — keep it current
   whenever you change something; don't create a second status doc.

## What this project is

`sienori/Tab-Session-Manager` (MPL-2.0), forked to `GuyFran/Tab-Session-Manager`. Saves and
restores browser window/tab state. Fork is 1 commit ahead of upstream `master`
(`113b272`) plus this fork's own commits — check with:
```bash
git log --oneline origin/master ^$(git ls-remote https://github.com/sienori/Tab-Session-Manager.git master | cut -f1)
```

**Scope decision (2026-08-07, still in force):** local, unpacked, personal use only. Not
published, not submitted to any store, not merged upstream, Google Drive sync not used. This
retires a whole category of concerns (own OAuth client, source-zip secrecy, engine pinning,
CI/lint/test hygiene) — see `docs/FORK-REVIEW.md` section 4 before re-opening any of them.

## Hard constraints — do not violate

- **Identity:** commits as `GuyFran <guynemerp@free.fr>` (global rule, this project has no
  override). Verify with `git config user.name`/`user.email` before committing if unsure.
- **Auto commit/version/push is standing authorization for this project.** After any code
  change: bump the version in **both** `src/manifest.json` and `src/manifest-ff.json` (they
  must match), commit with the version as the message prefix (`7.4.9 - summary`), push to
  `origin master` directly. No branches, no asking. This is user-confirmed behavior, not a
  guess — see the `auto-commit-version-push` memory if you have access to it.
- **Never delete or reset `dev/chrome`'s extension ID.** `src/manifest.json` has a `key` field
  pinning the Chrome extension ID to `pheckpgfalekjmbbodbggfohpghjceog` — this is what makes
  the saved-sessions IndexedDB survive across rebuilds. Don't touch the `key` field, don't move
  the repo folder (the ID would only be path-derived if `key` were removed).
- **`src/credentials.js` is gitignored but imported by `background/cloudAuth.js`.** If a build
  fails with a module-not-found on `../credentials`, recreate it:
  ```js
  export const clientId = "";
  export const clientSecret = "";
  ```
  Empty values are intentional — Drive sync isn't used in this fork. Don't try to "fix" this by
  making the import optional; that would diverge further from upstream for no benefit.

## Build

Node 24.19.0 / npm 11.17.0 installed 2026-08-17 (`winget install OpenJS.NodeJS.LTS`). If a
fresh session shows `node`/`npm` as not found, it's almost always a stale shell — reopen the
terminal (PATH is picked up at shell start, not live).

```bash
npm ci               # only needed if node_modules/ is missing
npm run watch-dev     # builds dev/chrome + dev/firefox, rebuilds on save, stays running
```

One-shot build without the watcher: `npx webpack --config webpack.config.dev.js`.

Load `dev/chrome` in `chrome://extensions` → Developer mode → Load unpacked. For incognito
testing, also enable "Allow in Incognito" on the extension's card — without it Chrome hides
incognito windows from the extension entirely.

`npm run build` (produces `dist/*.zip`) has not been run since the toolchain was restored and
isn't needed for this fork's local-unpacked workflow.

## Current status (2026-08-17)

- Version **7.4.12**, pushed to `origin/master` (`53aefb3`); dev build verified clean.
- Dev build verified clean: 0 errors, 26 pre-existing warnings.
- Latest fork work: F-05/F-06 fix Chrome-incognito restore, which can't use the normal
  lazy-loading placeholder (extension pages don't load in incognito under
  `"incognito": "spanning"`). Tabs are created live then immediately discarded, batched, with a
  dedicated `incognitoTabCreateBatchSize` setting (default 5). v7.4.12 also forces saved private
  windows into a new private window, rather than the popup's regular window, and waits for the
  final create batch. **Not yet runtime-tested in a real browser —
  that's the next thing to verify**, see `docs/FORK-REVIEW.md` section 5 backlog.
- Open backlog highlight (full list + priorities in `docs/FORK-REVIEW.md` section 5):
  - **L-02** — backup export is off by default; user action, not code.

## Conventions already established

- Comments in touched files may be Japanese (upstream style) or English (fork additions) —
  don't mass-translate, it creates merge-conflict-prone diffs for no benefit.
- Every fork-introduced feature/fix gets an entry in `docs/FORK-REVIEW.md` section 6 (what it
  does) and section 7 (dated changelog line, written as unbuilt/unverified until confirmed
  otherwise — this project's code frequently ships unbuilt because Node has gone missing from
  this machine before; say so explicitly rather than implying something was tested).
- `npm run format:check` fails on 7 files that were already unformatted on a clean upstream
  checkout (retired as B-07) — don't let format-on-save produce a huge unrelated diff if you
  open and save one of them; check `git diff --stat` before committing.
