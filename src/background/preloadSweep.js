import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { returnReplaceParameter } from "./replace";
import { captureActiveTab, getThumbnailDataUrl } from "./thumbnails";
import { showBadge, hideBadge } from "./setBadge";
import { addSweepDebugEvent } from "./restoreDebug";
import {
  buildIncognitoPlaceholderUrl,
  isIncognitoPlaceholderUrl
} from "./incognitoPlaceholder";

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

// フォーカス直後はChromeの描画がまだ追いつかず、一発判定だと focused なのに
// "invisible" が返ることがある(実測: 延期→再開→即再延期のデッドロック)。
// 描画が立ち上がるまで少し粘って判定する
const RENDERABLE_WAIT_MS = 8 * 1000;
const RENDERABLE_POLL_MS = 700;
const waitForRenderable = async windowId => {
  const deadline = Date.now() + RENDERABLE_WAIT_MS;
  while (!shouldStop) {
    if (await isWindowRenderable(windowId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(RENDERABLE_POLL_MS);
  }
  return false;
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

const DEFERRED_RETRY_MS = 3000;

const deferSweepWindow = async windowId => {
  log.info(logDir, "deferSweepWindow(): window not rendered, will sweep on focus", windowId);
  addSweepDebugEvent("sweep-window-deferred", { windowId });
  try {
    const ids = await getDeferredWindowIds();
    if (!ids.includes(windowId)) ids.push(windowId);
    await browser.storage.session.set({ [DEFERRED_KEY]: ids });
  } catch (e) {}
  // 既にフォーカスされているウィンドウを延期すると、onFocusChangedは二度と発火せず
  // 再開の契機が失われる(実測デッドロック)。フォーカス中ならタイマーで自前再試行する
  const window = await browser.windows.get(windowId).catch(() => null);
  if (window?.focused) {
    setTimeout(() => {
      handleWindowFocusForDeferredSweep(windowId).catch(() => {});
    }, DEFERRED_RETRY_MS);
  }
};

// background.jsのwindows.onFocusChangedから呼ばれる。延期していたウィンドウが
// フォーカスされた(=描画された)タイミングでスウィープを再開する
export const handleWindowFocusForDeferredSweep = async windowId => {
  if (windowId == null || windowId === browser.windows.WINDOW_ID_NONE) return;
  const ids = await getDeferredWindowIds();
  if (!ids.includes(windowId)) return;
  // スウィープ中は触らない。フォーカスイベントはもう来ないかもしれないので、
  // タイマーで自前再試行する
  if (isSweeping) {
    setTimeout(() => {
      handleWindowFocusForDeferredSweep(windowId).catch(() => {});
    }, DEFERRED_RETRY_MS);
    return;
  }
  try {
    await browser.storage.session.set({ [DEFERRED_KEY]: ids.filter(id => id !== windowId) });
  } catch (e) {}
  log.info(logDir, "handleWindowFocusForDeferredSweep(): resuming deferred sweep", windowId);
  addSweepDebugEvent("sweep-deferred-resume", { windowId });
  startPreloadSweep([windowId]);
};

// placeholderを開けないウィンドウ(Chromeのincognito)では、復元時にdiscard済みで生成されるため、
// incognitoのdiscard済みタブも同じようにスウィープ対象とする
// 通常ウィンドウのdiscard済みタブはユーザやブラウザが破棄したものなので、対象にしない
// スウィープ済みのdata:URLプレースホルダは完成形なので再処理しない(しないと無限再処理)
const isSweepTarget = tab =>
  isRedirectPlaceholder(tab) ||
  (tab.incognito && tab.discarded && !isIncognitoPlaceholderUrl(tab.url));

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
    addSweepDebugEvent("sweep-window-skip", { windowId, reason: "ifCaptureThumbnails-off" });
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

// incognitoタブを実URLのままdiscardすると、次のアクティブ化で即座に実ページが
// 再読込されてサムネイルの出番が無い(ユーザ報告)。キャプチャ済みサムネイルを
// 埋め込んだdata:URLプレースホルダに差し替えてからdiscardする。
// tabs.update()はdata:URLを黙って無視するため「新規作成→旧タブ削除」で差し替える
const swapToPlaceholderAndDiscard = async (tabId, processedTabIds, completedTabIds) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  // 読み込みが完了しなかったタブ(隠れたウィンドウでの空振り等)をplaceholderに
  // してしまうと、サムネイル無しのまま以後のスウィープ対象から外れて固定される。
  // 完了タブだけ差し替え、未完了タブは素のdiscardに留めて再スウィープに委ねる
  const completed = completedTabIds?.has(tabId);
  if (!completed || !tab.incognito || isIncognitoPlaceholderUrl(tab.url) || !/^https?:/.test(tab.url || "")) {
    await discardProcessedTab(tabId, processedTabIds);
    return;
  }
  addSweepDebugEvent("sweep-step", { step: "swap-start", tabId });
  const thumbDataUrl = await getThumbnailDataUrl(tab.url);
  addSweepDebugEvent("sweep-step", { step: "swap-thumb-read", tabId });
  const placeholderUrl = buildIncognitoPlaceholderUrl({
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    thumbDataUrl: thumbDataUrl
  });
  const placeholderTab = await browser.tabs
    .create({ windowId: tab.windowId, index: tab.index, url: placeholderUrl, active: false })
    .catch(e => {
      log.warn(logDir, "swapToPlaceholderAndDiscard() create failed", e?.message || String(e));
      return null;
    });
  if (!placeholderTab) {
    await discardProcessedTab(tabId, processedTabIds);
    return;
  }
  processedTabIds.add(placeholderTab.id);
  // 新規作成タブは元タブのタブグループから外れて生まれるため、明示的に戻す
  // (tabs.group()は"tabs"権限のみで使える。Firefoxには存在しないのでガード)
  if (tab.groupId != null && tab.groupId > -1 && browser.tabs.group) {
    await browser.tabs
      .group({ tabIds: [placeholderTab.id], groupId: tab.groupId })
      .catch(e => log.warn(logDir, "swapToPlaceholderAndDiscard() regroup failed", e?.message));
  }
  await browser.tabs.remove(tabId).catch(() => {});
  addSweepDebugEvent("sweep-step", { step: "swap-removed", tabId });
  // data:ページのURL確定を待ってからdiscardする
  await sleep(300);
  await discardProcessedTab(placeholderTab.id, processedTabIds);
  addSweepDebugEvent("sweep-tab-swapped", {
    oldTabId: tabId,
    placeholderTabId: placeholderTab.id,
    hasThumbnail: !!thumbDataUrl
  });
};

const sweepWindow = async (windowId, { skipFocusWait = false } = {}) => {
  const originalActiveTab = (
    await browser.tabs.query({ windowId: windowId, active: true }).catch(() => [])
  )[0];

  currentSweepWindowId = windowId;

  // 処理済みのタブは再度スウィープ対象の状態に戻るため、明示的に記録して二度処理しない
  const processedTabIds = new Set();
  // 読み込みが完了した(=placeholderへ差し替えてよい)タブ
  const completedTabIds = new Set();
  // 手動起動時はユーザが今すぐの実行を求めているので、フォーカス待ちをしない
  const focusState = { skipWait: skipFocusWait };
  let previousTabId = null;
  // 万一idの追跡が破れても暴走しないよう、反復回数に上限を設ける
  const initialTabCount = (await browser.tabs.query({ windowId: windowId }).catch(() => []))
    .length;
  const maxIterations = initialTabCount * 2 + 20;
  let iterationCount = 0;
  while (!shouldStop) {
    if (++iterationCount > maxIterations) {
      log.warn(logDir, "sweepWindow() iteration cap reached", windowId, maxIterations);
      addSweepDebugEvent("sweep-iteration-cap", { windowId, maxIterations });
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
    const renderable = await waitForRenderable(windowId);
    addSweepDebugEvent("sweep-renderable-check", { windowId, tabId: nextTab.id, renderable });

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
      const bgLoaded = await waitForLoad(nextTab.id);
      addSweepDebugEvent("sweep-tab-bg-processed", { tabId: nextTab.id, status: bgLoaded?.status || "gone" });
      await discardProcessedTab(nextTab.id, processedTabIds);
      if (remainingCount > 0) remainingCount--;
      updateBadge();
      continue;
    }

    // アクティブなタブはdiscardできないため、次のタブをアクティブにしてから前のタブを処理する
    await browser.tabs.update(nextTab.id, { active: true }).catch(() => {});
    if (previousTabId != null) await swapToPlaceholderAndDiscard(previousTabId, processedTabIds, completedTabIds);

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
    addSweepDebugEvent("sweep-step", { step: "wait-load-start", tabId: nextTab.id });
    const loadedTab = await waitForLoad(nextTab.id);
    addSweepDebugEvent("sweep-tab-loaded", { tabId: nextTab.id, status: loadedTab?.status || "gone", discarded: loadedTab?.discarded });
    if (loadedTab && loadedTab.status === "complete") {
      completedTabIds.add(nextTab.id);
      await sleep(RENDER_DELAY_MS);
      addSweepDebugEvent("sweep-step", { step: "capture-start", tabId: nextTab.id });
      // フォーカス直後の最初のタブはステータスの揺り戻しで1回目のキャプチャが
      // 落ちやすく、スウィープはこの後タブをplaceholderに差し替えてしまうため
      // 二度と撮れない。保存を確認できるまで数回粘る
      for (let attempt = 0; attempt < 3; attempt++) {
        await captureActiveTab(windowId, { fromSweep: true });
        const stored = !!(loadedTab.url && (await getThumbnailDataUrl(loadedTab.url)));
        addSweepDebugEvent("sweep-step", { step: "capture-retry", tabId: nextTab.id, attempt, stored });
        if (stored) break;
        if (shouldStop) break;
        await sleep(700);
      }
      addSweepDebugEvent("sweep-step", { step: "capture-done", tabId: nextTab.id });
    } else {
      addSweepDebugEvent("sweep-step", { step: "capture-skipped", tabId: nextTab.id, status: loadedTab?.status || "gone", discarded: loadedTab?.discarded });
    }
    previousTabId = nextTab.id;
    if (remainingCount > 0) remainingCount--;
    updateBadge();
  }

  // 元のアクティブタブに戻し、最後に処理したタブを処理する
  if (originalActiveTab) {
    await browser.tabs.update(originalActiveTab.id, { active: true }).catch(() => {});
  }
  if (previousTabId != null && previousTabId !== originalActiveTab?.id) {
    await swapToPlaceholderAndDiscard(previousTabId, processedTabIds, completedTabIds).catch(() => {});
  }
  currentSweepWindowId = null;
};

export const startPreloadSweep = async (windowIds, { manual = false } = {}) => {
  if (isSweeping) return;
  if (!getSettings("ifLazyLoading")) return;
  // 手動起動されたウィンドウは延期リストから外す(自動再開との二重実行を防ぐ)
  if (manual && Array.isArray(windowIds)) {
    try {
      const ids = await getDeferredWindowIds();
      await browser.storage.session.set({
        [DEFERRED_KEY]: ids.filter(id => !windowIds.includes(id))
      });
    } catch (e) {}
  }
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
    addSweepDebugEvent("sweep-start", { windowIds: String(windowIds), manual });

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
      addSweepDebugEvent("sweep-window-start", { windowId });
      await sweepWindow(windowId, { skipFocusWait: manual }).catch(e => {
        log.error(logDir, "sweepWindow()", e);
        addSweepDebugEvent("sweep-window-error", { windowId, error: e?.message || String(e) });
      });
      addSweepDebugEvent("sweep-window-finished", { windowId });
    }
    log.info(logDir, "=>startPreloadSweep() finished");
    addSweepDebugEvent("sweep-finished", {});
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
