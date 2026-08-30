import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { returnReplaceParameter } from "./replace";
import { captureActiveTab, getThumbnailDataUrl, captureVisibleTabWithTimeout } from "./thumbnails";
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

// ウィンドウ単位の並行スウィープ。windowId → { stop, remaining }
// キャプチャは共通のキュー(thumbnails.js、600ms間隔)を通るため、並行しても
// Chromeのキャプチャ割当(2回/秒)は超えない
const activeSweeps = new Map();

export const isPreloadSweeping = () => activeSweeps.size > 0;
// background.jsのhandleReplace抑制はスウィープ中のウィンドウ由来のイベントに限定する
// (全ウィンドウを抑制すると、ユーザが他ウィンドウでクリックしたplaceholderが
// スウィープ終了まで一切遷移しなくなる)
export const getSweepingWindowIds = () =>
  [...activeSweeps.entries()].filter(([, run]) => !run.stop).map(([id]) => id);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const totalRemaining = () =>
  [...activeSweeps.values()].reduce((sum, run) => sum + (run.remaining || 0), 0);

export const getPreloadSweepStatus = () => ({
  isSweeping: getSweepingWindowIds().length > 0,
  remainingCount: totalRemaining(),
  sweepingWindowIds: getSweepingWindowIds(),
  remainingByWindow: Object.fromEntries(
    [...activeSweeps.entries()].map(([id, run]) => [id, run.remaining || 0])
  )
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
    const remaining = totalRemaining();
    if (remaining > 0) showBadge(String(remaining), "#0d9488");
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
    await captureVisibleTabWithTimeout(windowId, { format: "jpeg", quality: 10 });
    return true;
  } catch (e) {
    // "view is invisible"とタイムアウト(描画フレーム無し)は非描画扱い。それ以外(保護ページ等)は描画されているとみなす
    return !/invisible|timed out/i.test(String(e?.message || e));
  }
};

// フォーカス直後はChromeの描画がまだ追いつかず、一発判定だと focused なのに
// "invisible" が返ることがある(実測: 延期→再開→即再延期のデッドロック)。
// 描画が立ち上がるまで少し粘って判定する
const RENDERABLE_WAIT_MS = 8 * 1000;
const RENDERABLE_POLL_MS = 700;
const waitForRenderable = async (windowId, run) => {
  const deadline = Date.now() + RENDERABLE_WAIT_MS;
  while (!run.stop) {
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
  // このウィンドウが既にスウィープ中なら触らない(他ウィンドウのスウィープとは並行できる)。
  // フォーカスイベントはもう来ないかもしれないので、タイマーで自前再試行する
  if (activeSweeps.has(windowId)) {
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
const waitWhileWindowFocused = async (windowId, focusState, run) => {
  // 一度待機上限に達したウィンドウでは、以降のタブで再び待たない
  // (毎タブ待つと、タブ数に比例して待ち時間が積み上がる)
  if (focusState.skipWait) return;
  const deadline = Date.now() + FOCUS_WAIT_MAX_MS;
  while (!run.stop && Date.now() < deadline) {
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
const waitForLoad = async (tabId, run) => {
  const startTime = Date.now();
  while (!run.stop && Date.now() - startTime < LOAD_TIMEOUT_MS) {
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
    const regrouped = await browser.tabs
      .group({ tabIds: [placeholderTab.id], groupId: tab.groupId })
      .then(() => true)
      .catch(e => {
        log.warn(logDir, "swapToPlaceholderAndDiscard() regroup failed", e?.message);
        addSweepDebugEvent("sweep-tab-regrouped", {
          tabId: placeholderTab.id,
          groupId: tab.groupId,
          ok: false,
          error: e?.message || String(e)
        });
        return false;
      });
    if (regrouped) {
      addSweepDebugEvent("sweep-tab-regrouped", { tabId: placeholderTab.id, groupId: tab.groupId, ok: true });
    }
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

const sweepWindow = async (windowId, run, { skipFocusWait = false } = {}) => {
  const originalActiveTab = (
    await browser.tabs.query({ windowId: windowId, active: true }).catch(() => [])
  )[0];

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
  while (!run.stop) {
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

    await waitWhileWindowFocused(windowId, focusState, run);
    if (run.stop) break;

    // 隠れたウィンドウではキャプチャ不能かつ、discard済みタブのアクティブ化は
    // 再読込を起こさず30秒タイムアウトを空費するだけ(実測)。描画状態で分岐する
    const renderable = await waitForRenderable(windowId, run);
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
      const bgLoaded = await waitForLoad(nextTab.id, run);
      addSweepDebugEvent("sweep-tab-bg-processed", { tabId: nextTab.id, status: bgLoaded?.status || "gone" });
      await discardProcessedTab(nextTab.id, processedTabIds);
      if (run.remaining > 0) run.remaining--;
      updateBadge();
      continue;
    }

    // アクティブなタブはdiscardできないため、次のタブをアクティブにしてから前のタブを処理する
    await browser.tabs.update(nextTab.id, { active: true }).catch(() => {});
    // アクティブ化によるdiscardタブの自動再読込はフォーカスされたウィンドウでしか
    // 起きない(実測: 可視でも非フォーカスのウィンドウでは30秒待っても unloaded のまま)。
    // 並行スウィープでは同時にフォーカスできるのは1ウィンドウだけなので、明示的に
    // reloadして読み込みを強制する(tabs.reload()はフォーカスに関係なく機能する)
    if (nextTab.discarded) await browser.tabs.reload(nextTab.id).catch(() => {});
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
    const loadedTab = await waitForLoad(nextTab.id, run);
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
        if (run.stop) break;
        await sleep(700);
      }
      addSweepDebugEvent("sweep-step", { step: "capture-done", tabId: nextTab.id });
    } else {
      addSweepDebugEvent("sweep-step", { step: "capture-skipped", tabId: nextTab.id, status: loadedTab?.status || "gone", discarded: loadedTab?.discarded });
    }
    previousTabId = nextTab.id;
    if (run.remaining > 0) run.remaining--;
    updateBadge();
  }

  // 元のアクティブタブに戻し、最後に処理したタブを処理する
  if (originalActiveTab) {
    await browser.tabs.update(originalActiveTab.id, { active: true }).catch(() => {});
  }
  if (previousTabId != null && previousTabId !== originalActiveTab?.id) {
    await swapToPlaceholderAndDiscard(previousTabId, processedTabIds, completedTabIds).catch(() => {});
  }
};

export const startPreloadSweep = async (windowIds, { manual = false } = {}) => {
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

  //windowIds未指定なら全ての通常ウィンドウを対象にする
  // incognitoウィンドウは、拡張機能がincognitoで許可されている場合のみ取得できる
  if (!windowIds) {
    const windows = await browser.windows.getAll().catch(() => []);
    windowIds = windows.filter(window => window.type === "normal").map(window => window.id);
  }
  // 既にスウィープ中のウィンドウは二重に走らせない
  windowIds = windowIds.filter(id => !activeSweeps.has(id));
  if (windowIds.length === 0) return;
  log.info(logDir, "startPreloadSweep()", windowIds);
  addSweepDebugEvent("sweep-start", { windowIds: String(windowIds), manual });

  const runs = [];
  for (const windowId of windowIds) {
    if (!(await shouldSweepWindow(windowId))) continue;
    if (activeSweeps.has(windowId)) continue;
    const tabs = await browser.tabs.query({ windowId: windowId }).catch(() => []);
    const run = {
      stop: false,
      remaining: tabs.filter(tab => !tab.active && isSweepTarget(tab)).length
    };
    activeSweeps.set(windowId, run);
    runs.push({ windowId, run });
  }
  updateBadge();

  // ウィンドウごとに並行実行する。キャプチャは共通キューで直列化されるので
  // 割当超過にはならず、読み込み待ちが重なる分だけ全体が速くなる
  await Promise.all(
    runs.map(async ({ windowId, run }) => {
      addSweepDebugEvent("sweep-window-start", { windowId });
      try {
        await sweepWindow(windowId, run, { skipFocusWait: manual });
      } catch (e) {
        log.error(logDir, "sweepWindow()", e);
        addSweepDebugEvent("sweep-window-error", { windowId, error: e?.message || String(e) });
      } finally {
        activeSweeps.delete(windowId);
        addSweepDebugEvent("sweep-window-finished", { windowId });
        updateBadge();
      }
    })
  );
  log.info(logDir, "=>startPreloadSweep() finished", windowIds);
  addSweepDebugEvent("sweep-finished", { windowIds: String(windowIds) });
};

// windowId指定でそのウィンドウのスウィープだけ停止、未指定なら全停止
export const stopPreloadSweep = windowId => {
  log.info(logDir, "stopPreloadSweep()", windowId);
  if (windowId != null) {
    const run = activeSweeps.get(windowId);
    if (run) run.stop = true;
  } else {
    for (const run of activeSweeps.values()) run.stop = true;
  }
  // ループの終了を待たずに、停止状態を即座にUIへ反映する
  broadcastStatus();
};
