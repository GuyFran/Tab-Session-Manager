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
// 現在スウィープ中のウィンドウ。background.jsのhandleReplace抑制はこのウィンドウ由来の
// イベントに限定する(全ウィンドウを抑制すると、ユーザが他ウィンドウでクリックした
// placeholderがスウィープ終了まで一切遷移しなくなる)
let currentSweepWindowId = null;

export const isPreloadSweeping = () => isSweeping;
export const getSweepingWindowId = () => (isSweeping && !shouldStop ? currentSweepWindowId : null);

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

// 隠れている(他ウィンドウに覆われている・最小化された)ウィンドウはChromeが描画しないため、
// captureVisibleTab()は "view is invisible" で失敗し、discard済みタブのアクティブ化も
// 実際の再読込を起こさない(実測: bg-probe 2026-08-28)。キャプチャを1回試して判定する
const isWindowRenderable = async windowId => {
  try {
    await browser.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 10 });
    return true;
  } catch (e) {
    // "view is invisible"以外(保護ページ等)は描画されているとみなす
    return !/invisible/i.test(String(e?.message || e));
  }
};

// 隠れたウィンドウでキャプチャできなかったスウィープを、ウィンドウがフォーカスを得たときに
// 再実行するための記録。MV3のSWは30秒で死ぬため、storage.session(ブラウザ再起動で消える)に置く
const DEFERRED_KEY = "deferredSweepWindowIds";

const getDeferredWindowIds = async () => {
  try {
    const stored = await browser.storage.session.get(DEFERRED_KEY);
    return Array.isArray(stored[DEFERRED_KEY]) ? stored[DEFERRED_KEY] : [];
  } catch (e) {
    return [];
  }
};

const deferSweepWindow = async windowId => {
  log.info(logDir, "deferSweepWindow(): window not rendered, will sweep on focus", windowId);
  try {
    const ids = await getDeferredWindowIds();
    if (!ids.includes(windowId)) ids.push(windowId);
    await browser.storage.session.set({ [DEFERRED_KEY]: ids });
  } catch (e) {}
};

// background.jsのwindows.onFocusChangedから呼ばれる。延期していたウィンドウが
// フォーカスされた(=描画された)タイミングでスウィープを再開する
export const handleWindowFocusForDeferredSweep = async windowId => {
  if (windowId == null || windowId === browser.windows.WINDOW_ID_NONE) return;
  const ids = await getDeferredWindowIds();
  if (!ids.includes(windowId)) return;
  // スウィープ中は触らない。次のフォーカスで再試行される
  if (isSweeping) return;
  try {
    await browser.storage.session.set({ [DEFERRED_KEY]: ids.filter(id => id !== windowId) });
  } catch (e) {}
  log.info(logDir, "handleWindowFocusForDeferredSweep(): resuming deferred sweep", windowId);
  startPreloadSweep([windowId]);
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
  // (v7.4.22)。サムネイルキャプチャ自体が無効ならスウィープは無意味。
  // ifSavePrivateWindowは受動キャプチャ(閲覧中)のゲートであり、復元後スウィープには不要:
  // ユーザが復元した以上、サムネイルを撮る意味がある
  if (!getSettings("ifCaptureThumbnails")) {
    log.info(logDir, "shouldSweepWindow() skipping incognito window (thumbnails off)", windowId);
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

// discardはタブに新しいidを割り当てるため、戻り値のidも処理済みとして記録する。
// 記録しないと(incognito && discarded)のタブが新idで再びスウィープ対象になり、
// 先頭2タブが永久に再読込・再discardを繰り返してループが終わらない
const discardProcessedTab = async (tabId, processedTabIds) => {
  const discardedTab = await browser.tabs.discard(tabId).catch(() => null);
  if (discardedTab?.id != null) processedTabIds.add(discardedTab.id);
};

const sweepWindow = async windowId => {
  const originalActiveTab = (
    await browser.tabs.query({ windowId: windowId, active: true }).catch(() => [])
  )[0];

  currentSweepWindowId = windowId;

  // 処理済みのタブは再度スウィープ対象の状態に戻るため、明示的に記録して二度処理しない
  const processedTabIds = new Set();
  const focusState = { skipWait: false };
  let previousTabId = null;
  // 万一idの追跡が破れても暴走しないよう、反復回数に上限を設ける
  const initialTabCount = (await browser.tabs.query({ windowId: windowId }).catch(() => []))
    .length;
  const maxIterations = initialTabCount * 2 + 20;
  let iterationCount = 0;
  while (!shouldStop) {
    if (++iterationCount > maxIterations) {
      log.warn(logDir, "sweepWindow() iteration cap reached", windowId, maxIterations);
      break;
    }
    const tabs = await browser.tabs.query({ windowId: windowId }).catch(() => null);
    if (!tabs) break; //ウィンドウが閉じられた
    const nextTab = tabs.find(
      tab => !tab.active && !processedTabIds.has(tab.id) && isSweepTarget(tab)
    );
    if (!nextTab) break;
    processedTabIds.add(nextTab.id);

    await waitWhileWindowFocused(windowId, focusState);
    if (shouldStop) break;

    // 隠れたウィンドウではキャプチャ不能かつ、discard済みタブのアクティブ化は
    // 再読込を起こさず30秒タイムアウトを空費するだけ(実測)。描画状態で分岐する
    const renderable = await isWindowRenderable(windowId);

    if (!renderable && !isRedirectPlaceholder(nextTab)) {
      // incognitoのdiscard済みタブ: 隠れたままでは読み込みもキャプチャもできない。
      // ウィンドウを延期リストに入れ、フォーカスされたときに再スウィープする
      await deferSweepWindow(windowId);
      processedTabIds.delete(nextTab.id);
      break;
    }

    if (!renderable) {
      // 隠れたウィンドウのplaceholder: アクティブ化せずにバックグラウンドで実URLへ
      // 遷移させる(隠れたウィンドウでもupdate({url})は正常に読み込む)。
      // サムネイルは撮れないので撮らず、読み込み完了後すぐdiscardする
      const parameter = returnReplaceParameter(nextTab.url);
      if (parameter.isReplaced && parameter.url) {
        await browser.tabs
          .update(nextTab.id, { url: parameter.url })
          .catch(e => log.warn(logDir, "sweepWindow() bg navigate FAILED", e?.message || String(e)));
      }
      await waitForLoad(nextTab.id);
      await discardProcessedTab(nextTab.id, processedTabIds);
      if (remainingCount > 0) remainingCount--;
      updateBadge();
      continue;
    }

    // アクティブなタブはdiscardできないため、次のタブをアクティブにしてから前のタブをdiscardする
    await browser.tabs.update(nextTab.id, { active: true }).catch(() => {});
    if (previousTabId != null) await discardProcessedTab(previousTabId, processedTabIds);

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
      await captureActiveTab(windowId, { fromSweep: true });
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
  currentSweepWindowId = null;
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
    currentSweepWindowId = null;
    updateBadge();
  }
};

export const stopPreloadSweep = () => {
  log.info(logDir, "stopPreloadSweep()");
  shouldStop = true;
  // ループの終了を待たずに、停止状態を即座にUIへ反映する
  broadcastStatus();
};
