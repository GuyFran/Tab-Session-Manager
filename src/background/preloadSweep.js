import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { returnReplaceParameter, replacePage } from "./replace";
import { captureActiveTab } from "./thumbnails";
import { showBadge, hideBadge } from "./setBadge";

const logDir = "background/preloadSweep";

const LOAD_TIMEOUT_MS = 30 * 1000;
const POLL_INTERVAL_MS = 500;
const FOCUS_RECHECK_MS = 3000;
const RENDER_DELAY_MS = 500;

let isSweeping = false;
let shouldStop = false;
let remainingCount = 0;

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

// ユーザが操作中のウィンドウには干渉しないよう、フォーカスが外れるまで待つ
const waitWhileWindowFocused = async windowId => {
  while (!shouldStop) {
    const focusedWindow = await browser.windows.getLastFocused().catch(() => null);
    if (!focusedWindow || !focusedWindow.focused || focusedWindow.id !== windowId) return;
    await sleep(FOCUS_RECHECK_MS);
  }
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

  let previousTabId = null;
  while (!shouldStop) {
    const tabs = await browser.tabs.query({ windowId: windowId }).catch(() => null);
    if (!tabs) break; //ウィンドウが閉じられた
    const nextTab = tabs.find(tab => !tab.active && !tab.discarded && isRedirectPlaceholder(tab));
    if (!nextTab) break;

    await waitWhileWindowFocused(windowId);
    if (shouldStop) break;

    // アクティブなタブはdiscardできないため、次のタブをアクティブにしてから前のタブをdiscardする
    await browser.tabs.update(nextTab.id, { active: true }).catch(() => {});
    if (previousTabId != null) browser.tabs.discard(previousTabId).catch(() => {});

    // onActivated経由のreplacePageはフォーカス中のウィンドウを対象とするため、明示的に呼ぶ
    replacePage(windowId);
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

  //windowIds未指定なら全ての通常ウィンドウを対象にする
  if (!windowIds) {
    const windows = await browser.windows.getAll().catch(() => []);
    windowIds = windows.filter(window => window.type === "normal").map(window => window.id);
  }
  log.info(logDir, "startPreloadSweep()", windowIds);

  remainingCount = 0;
  for (const windowId of windowIds) {
    const tabs = await browser.tabs.query({ windowId: windowId }).catch(() => []);
    remainingCount += tabs.filter(tab => !tab.active && isRedirectPlaceholder(tab)).length;
  }
  updateBadge();

  // ウィンドウごとに並行して、ウィンドウ内では1タブずつ順番に処理する
  await Promise.all(
    windowIds.map(windowId =>
      sweepWindow(windowId).catch(e => log.error(logDir, "sweepWindow()", e))
    )
  );

  remainingCount = 0;
  updateBadge();
  isSweeping = false;
  log.info(logDir, "=>startPreloadSweep() finished");
};

export const stopPreloadSweep = () => {
  log.info(logDir, "stopPreloadSweep()");
  shouldStop = true;
  // ループの終了を待たずに、停止状態を即座にUIへ反映する
  broadcastStatus();
};
