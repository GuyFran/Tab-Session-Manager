import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { returnReplaceParameter } from "./replace";
import { captureActiveTab } from "./thumbnails";
import { showBadge, hideBadge } from "./setBadge";

const logDir = "background/preloadSweep";

const LOAD_TIMEOUT_MS = 30 * 1000;
const POLL_INTERVAL_MS = 500;
const FOCUS_RECHECK_MS = 3000;
// フォーカスが外れるのを待つ上限。超えたらフォーカス中でもスウィープを進める
const FOCUS_WAIT_MAX_MS = 10 * 1000;
const RENDER_DELAY_MS = 500;

let isSweeping = false;
let shouldStop = false;
let remainingCount = 0;

export const isPreloadSweeping = () => isSweeping;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const getPreloadSweepStatus = () => ({
  isSweeping: isSweeping && !shouldStop,
  remainingCount: remainingCount
});

// popupにスウィープ状態を通知する
const broadcastStatus = () => {
  browser.runtime
    .sendMessage({
      message: "updatePreloadSweepStatus",
      sweepStatus: getPreloadSweepStatus()
    })
    .catch(() => {});
};

const updateBadge = () => {
  try {
    if (remainingCount > 0) showBadge(String(remainingCount), "#0d9488");
    else hideBadge();
  } catch (e) {}
  broadcastStatus();
};

const isRedirectPlaceholder = tab => {
  const parameter = returnReplaceParameter(tab.url);
  return parameter.isReplaced && parameter.state === "redirect";
};

// placeholderを開けないウィンドウ(Chromeのincognito)では、復元時にdiscard済みで生成されるため、
// incognitoのdiscard済みタブも同じようにスウィープ対象とする
// 通常ウィンドウのdiscard済みタブはユーザやブラウザが破棄したものなので、対象にしない
const isSweepTarget = tab => isRedirectPlaceholder(tab) || (tab.incognito && tab.discarded);

// ユーザが操作中のウィンドウには干渉しないよう、フォーカスが外れるのを少しだけ待つ
// 復元直後のウィンドウはフォーカスされたままなので、無期限に待つとスウィープが永久に
// 始まらない。captureVisibleTab()はウィンドウが表示されている必要もあるため、
// 待機時間を超えたらフォーカス中でもそのまま処理する
const waitWhileWindowFocused = async (windowId, focusState) => {
  // 一度待機上限に達したウィンドウでは、以降のタブで再び待たない
  // (毎タブ待つと、タブ数に比例して待ち時間が積み上がる)
  if (focusState.skipWait) return;
  const deadline = Date.now() + FOCUS_WAIT_MAX_MS;
  while (!shouldStop && Date.now() < deadline) {
    const focusedWindow = await browser.windows.getLastFocused().catch(() => null);
    if (!focusedWindow || !focusedWindow.focused || focusedWindow.id !== windowId) return;
    await sleep(FOCUS_RECHECK_MS);
  }
  log.info(logDir, "waitWhileWindowFocused() proceeding while focused", windowId);
  focusState.skipWait = true;
};

// キャプチャできないウィンドウをスウィープしても、読み込んで再度discardするだけになる
const shouldSweepWindow = async windowId => {
  const window = await browser.windows.get(windowId).catch(() => null);
  if (!window) return false;
  if (!window.incognito) return true;
  // Chromeのincognitoタブは復元時点で既に実URL・実タイトルを保ったままdiscardされている
  // (v7.4.22)。サムネイルを保存できない設定では、スウィープしても得るものがない
  if (!getSettings("ifCaptureThumbnails") || !getSettings("ifSavePrivateWindow")) {
    log.info(logDir, "shouldSweepWindow() skipping incognito window", windowId);
    return false;
  }
  return true;
};

// placeholderのリダイレクトと実ページのロード完了を待つ
const waitForLoad = async tabId => {
  const startTime = Date.now();
  while (!shouldStop && Date.now() - startTime < LOAD_TIMEOUT_MS) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === "complete" && !returnReplaceParameter(tab.url).isReplaced) return tab;
    await sleep(POLL_INTERVAL_MS);
  }
  return await browser.tabs.get(tabId).catch(() => null);
};

const sweepWindow = async windowId => {
  const originalActiveTab = (
    await browser.tabs.query({ windowId: windowId, active: true }).catch(() => [])
  )[0];

  // 処理済みのタブは再度スウィープ対象の状態に戻るため、明示的に記録して二度処理しない
  const processedTabIds = new Set();
  const focusState = { skipWait: false };
  let previousTabId = null;
  while (!shouldStop) {
    const tabs = await browser.tabs.query({ windowId: windowId }).catch(() => null);
    if (!tabs) break; //ウィンドウが閉じられた
    const nextTab = tabs.find(
      tab => !tab.active && !processedTabIds.has(tab.id) && isSweepTarget(tab)
    );
    if (!nextTab) break;
    processedTabIds.add(nextTab.id);

    await waitWhileWindowFocused(windowId, focusState);
    if (shouldStop) break;

    // アクティブなタブはdiscardできないため、次のタブをアクティブにしてから前のタブをdiscardする
    await browser.tabs.update(nextTab.id, { active: true }).catch(() => {});
    if (previousTabId != null) browser.tabs.discard(previousTabId).catch(() => {});

    // placeholderは対象タブを直接実URLへ遷移させる。replacePage()はアクティブタブを
    // 問い合わせてsetTimeoutで再試行する作りのため、スウィープのループ内では
    // 取りこぼしが起きる(タブがplaceholderのままdiscardされる)
    // discard済みタブはアクティブ化でブラウザが実URLを読み込むので、遷移は不要
    if (isRedirectPlaceholder(nextTab)) {
      const parameter = returnReplaceParameter(nextTab.url);
      log.info(logDir, "sweepWindow() navigating", nextTab.id, parameter.url);
      if (parameter.isReplaced && parameter.url) {
        await browser.tabs
          .update(nextTab.id, { url: parameter.url })
          .then(t => log.info(logDir, "sweepWindow() navigate ok", t?.id, t?.url))
          .catch(e => log.warn(logDir, "sweepWindow() navigate FAILED", e?.message || String(e)));
      }
    }
    const loadedTab = await waitForLoad(nextTab.id);
    if (loadedTab && loadedTab.status === "complete") {
      await sleep(RENDER_DELAY_MS);
      await captureActiveTab(windowId);
    }
    previousTabId = nextTab.id;
    if (remainingCount > 0) remainingCount--;
    updateBadge();
  }

  // 元のアクティブタブに戻し、最後に処理したタブをdiscardする
  if (originalActiveTab) {
    await browser.tabs.update(originalActiveTab.id, { active: true }).catch(() => {});
  }
  if (previousTabId != null && previousTabId !== originalActiveTab?.id) {
    browser.tabs.discard(previousTabId).catch(() => {});
  }
};

export const startPreloadSweep = async windowIds => {
  if (isSweeping) return;
  if (!getSettings("ifLazyLoading")) return;
  isSweeping = true;
  shouldStop = false;

  try {
    //windowIds未指定なら全ての通常ウィンドウを対象にする
    // incognitoウィンドウは、拡張機能がincognitoで許可されている場合のみ取得できる
    if (!windowIds) {
      const windows = await browser.windows.getAll().catch(() => []);
      windowIds = windows.filter(window => window.type === "normal").map(window => window.id);
    }
    log.info(logDir, "startPreloadSweep()", windowIds);

    remainingCount = 0;
    const sweepableWindowIds = [];
    for (const windowId of windowIds) {
      if (!(await shouldSweepWindow(windowId))) continue;
      sweepableWindowIds.push(windowId);
      const tabs = await browser.tabs.query({ windowId: windowId }).catch(() => []);
      remainingCount += tabs.filter(tab => !tab.active && isSweepTarget(tab)).length;
    }
    updateBadge();

    // ウィンドウを並行に処理すると複数ページが同時に読み込まれ、タブ生成時のバッチ制限が
    // 無意味になるため、ウィンドウも1つずつ順番に処理する
    for (const windowId of sweepableWindowIds) {
      if (shouldStop) break;
      await sweepWindow(windowId).catch(e => log.error(logDir, "sweepWindow()", e));
    }
    log.info(logDir, "=>startPreloadSweep() finished");
  } finally {
    // 途中で失敗してもスウィープ中の状態が残らないようにする
    remainingCount = 0;
    isSweeping = false;
    updateBadge();
  }
};

export const stopPreloadSweep = () => {
  log.info(logDir, "stopPreloadSweep()");
  shouldStop = true;
  // ループの終了を待たずに、停止状態を即座にUIへ反映する
  broadcastStatus();
};
