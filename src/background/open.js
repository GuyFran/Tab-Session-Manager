import browser from "webextension-polyfill";
import browserInfo from "browser-info";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { returnReplaceURL, replacePage } from "./replace.js";
import { updateTabGroups, isEnabledTabGroups } from "../common/tabGroups";
import { isTrackingSession, setLastFocusedWindowId, startTracking } from "./track.js";
import { startPreloadSweep } from "./preloadSweep.js";
import { createRestoreDebug } from "./restoreDebug.js";

const logDir = "background/open";

// ---------------------------------------------------------------------------
// TEMPORARY DEBUG AID — restore at most this many tabs per *window*, so a large
// session can be exercised quickly while the incognito restore routing is being
// diagnosed. Per-window rather than per-session so that a big leading normal
// window cannot starve a later private window of its share.
// Set to 0 to restore everything again. Remove once the investigation is done.
// ---------------------------------------------------------------------------
const DEBUG_RESTORE_TAB_LIMIT = 10;

export async function openSession(session, property = "openInNewWindow") {
  log.log(logDir, "openSession()", session, property);
  const hasIncognitoWindow = Object.values(session.windows).some(tabs =>
    Object.values(tabs).some(tab => tab.incognito)
  );
  // Prevent the debug window and the subsequently restored private window from
  // being picked up as a newly created tracked-session window.
  if (hasIncognitoWindow) await setLastFocusedWindowId(browser.windows.WINDOW_ID_NONE);
  const trace = hasIncognitoWindow ? createRestoreDebug(session, property) : null;
  // The popup's current window must never receive part of a mixed private
  // session. When any saved window is private, restore every saved window into
  // its own window instead.
  const restoreProperty = hasIncognitoWindow ? "openInNewWindow" : property;
  trace?.add("restore-routing", {
    requestedProperty: property,
    effectiveProperty: restoreProperty,
    containsPrivateWindow: hasIncognitoWindow
  });
  let isFirstWindowFlag = true;
  let restoredWindowIds = [];
  tabList = {};
  if (DEBUG_RESTORE_TAB_LIMIT > 0) {
    log.warn(
      logDir,
      `openSession() DEBUG_RESTORE_TAB_LIMIT active: ${DEBUG_RESTORE_TAB_LIMIT} tabs per window`
    );
    trace?.add("debug-tab-limit", { limit: DEBUG_RESTORE_TAB_LIMIT });
  }
  try {
    for (let win in session.windows) {
    const isIncognitoWindow = Object.values(session.windows[win]).some(tab => tab.incognito);
    trace?.add("saved-window", { windowId: win, incognito: isIncognitoWindow });
    const openInCurrentWindow = async () => {
      log.log(logDir, "openSession() openInCurrentWindow()");
      const currentWindow = await removeNowOpenTabs();
      restoredWindowIds.push(currentWindow.id);
      trace?.add("window-current", {
        savedWindowId: win,
        windowId: currentWindow.id,
        incognito: currentWindow.incognito
      });
      await createTabs(session, win, currentWindow, false, trace);
    };
    const openInNewWindow = async () => {
      log.log(logDir, "openSession() openInNewWindow()");
      let createData = {};

      const firstTab = session.windows[win][Object.keys(session.windows[win])[0]];
      createData.incognito = firstTab.incognito;

      const isSetPosition =
        getSettings("isRestoreWindowPosition") && session.windowsInfo != undefined;

      if (isSetPosition) {
        const info = session.windowsInfo[win];
        switch (info.state) {
          case "minimized":
            createData.state = info.state;
            break;
          case "normal":
            createData.height = info.height;
            createData.width = info.width;
          case "maximized": //最大化前のサイズを維持するためheightとwidthを含めない
            createData.left = info.left;
            createData.top = info.top;
            break;
        }
      }
      let currentWindow;
      // 開いたウィンドウがトラッキングセッションに追加されるのを防ぐ
      await setLastFocusedWindowId(browser.windows.WINDOW_ID_NONE);
      try {
        currentWindow = await browser.windows.create(createData);
      } catch (e) {
        /**
         * @see https://source.chromium.org/chromium/chromium/src/+/d51682b36adc22496f45a8111358a8bb30914534
         * @see https://github.com/sienori/Tab-Session-Manager/issues/1057
         * try to open a window in "safe" mode
         */
        currentWindow = await browser.windows.create({
          ...createData,
          width: 800,
          height: 600,
          top: 0,
          left: 0
        });
      }

      // windows.create() does not guarantee a populated tabs array. Fetch the
      // new window explicitly before selecting/removing its initial tab.
      currentWindow = await browser.windows.get(currentWindow.id, { populate: true });
      trace?.add("window-created", {
        savedWindowId: win,
        windowId: currentWindow.id,
        incognito: currentWindow.incognito,
        initialTabCount: currentWindow.tabs?.length || 0
      });

      if (isSetPosition && session.windowsInfo[win].state == "maximized") {
        browser.windows.update(currentWindow.id, { state: "maximized" });
      }

      restoredWindowIds.push(currentWindow.id);
      await createTabs(session, win, currentWindow, false, trace);
    };
    const addToCurrentWindow = async () => {
      log.log(logDir, "openSession() addToCurrentWindow()");
      const currentTabs = await browser.tabs.query({ currentWindow: true });
      const currentWinId = currentTabs[0].windowId;
      const currentWindow = await browser.windows.get(currentWinId, { populate: true });
      restoredWindowIds.push(currentWindow.id);
      trace?.add("window-add-current", {
        savedWindowId: win,
        windowId: currentWindow.id,
        incognito: currentWindow.incognito
      });
      await createTabs(session, win, currentWindow, true, trace);
    };

    if (isFirstWindowFlag) {
      isFirstWindowFlag = false;
      // Record the reason for the effective routing in the live trace. The
      // switch below uses restoreProperty for every saved window in the session.
      if (isIncognitoWindow && property !== "openInNewWindow") {
        trace?.add("private-window-forced-new", { savedWindowId: win, property: property });
      }
      switch (restoreProperty) {
        case "openInCurrentWindow":
          await openInCurrentWindow();
          break;
        case "openInNewWindow":
          await openInNewWindow();
          break;
        case "addToCurrentWindow":
          await addToCurrentWindow();
          break;
      }
    } else {
      // ウィンドウを並列に開くとタブ作成のバッチ制限が効かないため、順次開く
      await openInNewWindow();
    }
    }

    // 復元完了後、バックグラウンドで各タブを順次ロードしてサムネイルを取得し、サスペンドする
    if (getSettings("ifPreloadAfterRestore")) startPreloadSweep(restoredWindowIds);
    trace?.add("restore-finished", { restoredWindowIds: restoredWindowIds });
  } catch (e) {
    trace?.add("restore-error", { message: e?.message || String(e) });
    throw e;
  } finally {
    trace?.finish();
  }
}

const isEnabledOpenerTabId =
  (browserInfo().name == "Firefox" && browserInfo().version >= 57) ||
  (browserInfo().name == "Chrome" && browserInfo().version >= 18);
const isEnabledDiscarded = browserInfo().name == "Firefox" && browserInfo().version >= 63;
const isEnabledOpenInReaderMode = browserInfo().name == "Firefox" && browserInfo().version >= 58;
const isEnabledWindowTitle = browserInfo().name == "Firefox";

// Chromeのincognitoウィンドウでは拡張機能ページ(placeholder)を開けないため、遅延読み込みが効かない
const isEnabledPlaceholder = currentWindow =>
  !(browserInfo().name === "Chrome" && currentWindow.incognito);

const DISCARD_RETRY_DELAY_MS = 500;

// placeholderの代わりに生成直後のタブをdiscardして、読み込みを止める
// 生成直後は破棄できないことがあるため、失敗したら一度だけ再試行する
const discardAfterCreate = async (tabId, trace = null) => {
  const tryDiscard = async () => {
    try {
      // Chrome resolves discard() with the updated tab. Querying the tab again
      // can fail for an incognito tab even when discard itself succeeded.
      const discardedTab = await browser.tabs.discard(tabId);
      const discarded = Boolean(discardedTab?.discarded);
      trace?.add("tab-discard-result", { tabId: tabId, discarded: discarded });
      return discarded;
    } catch (e) {
      trace?.add("tab-discard-error", { tabId: tabId, message: e?.message || String(e) });
      return false;
    }
  };

  if (await tryDiscard()) return;
  trace?.add("tab-discard-retry", { tabId: tabId, delayMs: DISCARD_RETRY_DELAY_MS });
  await new Promise(resolve => setTimeout(resolve, DISCARD_RETRY_DELAY_MS));
  if (await tryDiscard()) return;
  log.warn(logDir, "discardAfterCreate() failed", tabId);
  trace?.add("tab-discard-failed", { tabId: tabId });
};

//ウィンドウとタブを閉じてcurrentWindowを返す
async function removeNowOpenTabs() {
  log.log(logDir, "removeNowOpenTabs()");
  const currentTabs = await browser.tabs.query({ currentWindow: true });
  const currentWinId = currentTabs[0].windowId;
  const allWindows = await browser.windows.getAll({ populate: true });
  for (const window of allWindows) {
    if (window.id === currentWinId) {
      //アクティブウィンドウのタブを閉じる
      for (const tab of window.tabs) {
        if (tab.index != 0) browser.tabs.remove(tab.id);
      }
    } else {
      //非アクティブウィンドウを閉じる
      await browser.windows.remove(window.id);
    }
  }
  return await browser.windows.get(currentWinId, { populate: true });
}

const createTabGroups = async (windowId, tabs, tabGroupsInfo) => {
  let groups = {};
  for (let tab of tabs) {
    if (!(tab.groupId > 0)) continue;

    if (!groups[tab.groupId])
      groups[tab.groupId] = {
        originalGroupId: tab.groupId,
        tabIds: []
      };
    groups[tab.groupId].tabIds.push(tabList[tab.id]);
  }

  for (let group of Object.values(groups)) {
    browser.tabs.group(
      {
        createProperties: { windowId: windowId },
        tabIds: group.tabIds
      },
      groupId => {
        const groupInfo = tabGroupsInfo.find(info => info.id === group.originalGroupId);
        if (!groupInfo) return;
        if (getSettings("saveTabGroupsV2")) updateTabGroups(groupId, groupInfo);
      }
    );
  }
};

const setWindowTitle = (session, windowId, currentWindow) => {
  const windowTitle = session?.windowsInfo?.[windowId]?.title || "";
  const activeTabTitle = Object.values(session.windows[windowId]).find(
    window => window.active
  )?.title;
  const reg = new RegExp("(?<title>.+)" + activeTabTitle, "u");
  const title = windowTitle.match(reg)?.groups?.title;

  if (title) {
    let count = 0;
    // タブがloading中だとtitlePrefaceのセットに失敗するため読み込めるまで繰り返す
    const interval = setInterval(async () => {
      browser.windows.update(currentWindow.id, { titlePreface: title });
      const tabInfo = await browser.tabs.query({ windowId: currentWindow.id, active: true });
      count++;
      if (tabInfo[0].status == "complete" || count > 20) clearInterval(interval);
    }, 1000);
  }
};

//現在のウィンドウにタブを生成
async function createTabs(session, win, currentWindow, isAddtoCurrentWindow = false, trace = null) {
  log.log(logDir, "createTabs()", session, win, currentWindow, isAddtoCurrentWindow);
  let sortedTabs = [];

  for (let tab in session.windows[win]) {
    sortedTabs.push(session.windows[win][tab]);
  }

  sortedTabs.sort((a, b) => {
    return a.index - b.index;
  });

  // TEMPORARY DEBUG AID: cap each window at DEBUG_RESTORE_TAB_LIMIT tabs.
  // Applied after sorting so the tabs kept are the first ones by tab index.
  if (DEBUG_RESTORE_TAB_LIMIT > 0 && sortedTabs.length > DEBUG_RESTORE_TAB_LIMIT) {
    const requested = sortedTabs.length;
    sortedTabs = sortedTabs.slice(0, DEBUG_RESTORE_TAB_LIMIT);
    log.warn(
      logDir,
      `createTabs() DEBUG_RESTORE_TAB_LIMIT: restoring ${sortedTabs.length}/${requested} tabs of window ${win}`
    );
    trace?.add("debug-tab-limit-applied", {
      windowId: currentWindow.id,
      savedWindowId: win,
      requested: requested,
      restored: sortedTabs.length,
      skipped: requested - sortedTabs.length
    });
  }

  const firstTabId = currentWindow.tabs[0].id;
  if (currentWindow.tabs[0].pinned) {
    sortedTabs.forEach(tab => tab.index++);
  }
  // 大量のタブを一度に作成するとブラウザがフリーズするため、まとめて作成する数を制限する
  // placeholderを開けないウィンドウのタブは生成直後に一瞬読み込まれるため、別枠で上限を設ける
  const batchSizeSetting = isEnabledPlaceholder(currentWindow)
    ? getSettings("tabCreateBatchSize")
    : getSettings("incognitoTabCreateBatchSize");
  const defaultBatchSize = isEnabledPlaceholder(currentWindow) ? 20 : 5;
  const TAB_CREATE_BATCH_SIZE = Math.max(1, Number(batchSizeSetting) || defaultBatchSize);
  trace?.add("tab-batching", {
    windowId: currentWindow.id,
    incognito: currentWindow.incognito,
    lazyLoading: getSettings("ifLazyLoading"),
    configuredBatchSize: batchSizeSetting,
    effectiveBatchSize: TAB_CREATE_BATCH_SIZE,
    tabCount: sortedTabs.length
  });
  let openedTabs = [];
  let tabNumber = 0;
  let batchNumber = 1;
  const waitForBatch = async isFinalBatch => {
    if (openedTabs.length === 0) return;
    const batchSize = openedTabs.length;
    trace?.add("batch-wait-start", {
      windowId: currentWindow.id,
      batch: batchNumber,
      size: batchSize,
      final: isFinalBatch
    });
    await Promise.all(openedTabs);
    trace?.add("batch-wait-finished", {
      windowId: currentWindow.id,
      batch: batchNumber,
      size: batchSize,
      final: isFinalBatch
    });
    openedTabs = [];
    batchNumber++;
  };
  for (let tab of sortedTabs) {
    trace?.add("tab-create-start", {
      windowId: currentWindow.id,
      savedTabId: tab.id,
      active: tab.active,
      batch: batchNumber
    });
    const openedTab = openTab(tab, currentWindow, isAddtoCurrentWindow, trace)
      .then(() => {
        tabNumber++;
        trace?.add("tab-create-finished", { windowId: currentWindow.id, savedTabId: tab.id });
        if (tabNumber == 1 && !isAddtoCurrentWindow) browser.tabs.remove(firstTabId);
        if (tabNumber == sortedTabs.length) replacePage(currentWindow.id);
      })
      .catch(e => {
        trace?.add("tab-create-error", {
          windowId: currentWindow.id,
          savedTabId: tab.id,
          message: e?.message || String(e)
        });
      });
    openedTabs.push(openedTab);
    if (getSettings("ifSupportTst")) await openedTab;
    if (openedTabs.length === TAB_CREATE_BATCH_SIZE) await waitForBatch(false);
  }

  // Await the final partial batch before opening another saved window or
  // starting the sweep; otherwise those tabs can all remain in flight.
  await waitForBatch(true);

  if (isEnabledTabGroups && getSettings("saveTabGroupsV2")) {
    createTabGroups(currentWindow.id, sortedTabs, session.tabGroups || []);
  }

  if (isEnabledWindowTitle) {
    setWindowTitle(session, win, currentWindow);
  }

  if (isTrackingSession(session.tag)) {
    startTracking(session.id, win, currentWindow.id);
  }
}

let tabList = {};
//実際にタブを開く
function openTab(tab, currentWindow, isOpenToLastIndex = false, trace = null) {
  log.log(logDir, "openTab()", tab, currentWindow, isOpenToLastIndex);
  return new Promise(async function (resolve, reject) {
    let createOption = {
      active: tab.active,
      index: tab.index,
      pinned: tab.pinned,
      url: tab.url,
      windowId: currentWindow.id
    };

    //cookieStoreId
    if (browserInfo().name == "Firefox") {
      createOption.cookieStoreId = tab.cookieStoreId;

      //現在のウィンドウと開かれるタブのプライベート情報に不整合があるときはウィンドウに従う
      if (currentWindow.incognito) delete createOption.cookieStoreId;
      if (!currentWindow.incognito && tab.cookieStoreId == "firefox-private")
        delete createOption.cookieStoreId;
    }

    //タブをindexの最後に開く
    if (isOpenToLastIndex) {
      createOption.index += currentWindow.tabs.length;
    }

    //Tree Style Tab
    let openDelay = 0;
    if (getSettings("ifSupportTst") && isEnabledOpenerTabId) {
      createOption.openerTabId = tabList[tab.openerTabId];
      openDelay = getSettings("tstDelay");
    }

    //Lazy loading
    let shouldDiscardAfterCreate = false;
    if (getSettings("ifLazyLoading")) {
      if (getSettings("isUseDiscarded") && isEnabledDiscarded) {
        if (!createOption.active && !createOption.pinned) {
          createOption.discarded = true;
          createOption.title = tab.title;
        }
      } else if (isEnabledPlaceholder(currentWindow)) {
        createOption.url = returnReplaceURL("redirect", tab.title, tab.url, tab.favIconUrl);
      } else if (!createOption.active) {
        // placeholderを開けないウィンドウでは、生成直後にdiscardして遅延読み込み相当の動作にする
        shouldDiscardAfterCreate = true;
      }
    }

    //Reader mode
    if (tab.url.startsWith("about:reader?url=")) {
      if (getSettings("ifLazyLoading")) {
        createOption.url = returnReplaceURL("redirect", tab.title, tab.url, tab.favIconUrl);
      } else {
        if (isEnabledOpenInReaderMode) createOption.openInReaderMode = true;
        createOption.url = decodeURIComponent(tab.url.slice(17));
      }
    }

    //about:newtabを置き換え
    if (tab.url == "about:newtab") {
      createOption.url = null;
    }

    const tryOpen = async () => {
      log.log(logDir, "openTab() tryOpen()");
      try {
        const newTab = await browser.tabs.create(createOption);
        trace?.add("tab-created", { windowId: currentWindow.id, tabId: newTab.id });
        tabList[tab.id] = newTab.id;
        // discardを待ってからresolveする。待たないとバッチの区切りが効かず、
        // discardが走る前に次のバッチが作られて大量のタブが同時に読み込まれる
        if (shouldDiscardAfterCreate) await discardAfterCreate(newTab.id, trace);
        resolve();
      } catch (e) {
        log.warn(logDir, "openTab() tryOpen() replace", e);
        const isRemovedContainer = e.message.startsWith("No cookie store exists with ID");
        if (isRemovedContainer) delete createOption.cookieStoreId;
        // placeholderを開けないウィンドウでは代替ページを出せないので、元のURLのまま再試行する
        else if (isEnabledPlaceholder(currentWindow))
          createOption.url = returnReplaceURL("open_faild", tab.title, tab.url, tab.favIconUrl);
        let fallbackError;
        const newTab = await browser.tabs.create(createOption).catch(e => {
          fallbackError = e;
          log.error(logDir, "openTab() tryOpen() create", e);
        });
        if (!newTab) return reject(fallbackError); //タブを開けなかった場合はreject
        trace?.add("tab-created-fallback", { windowId: currentWindow.id, tabId: newTab.id });
        tabList[tab.id] = newTab.id;
        if (shouldDiscardAfterCreate) await discardAfterCreate(newTab.id, trace);
        resolve();
      }
    };

    //Tree Style Tabに対応ならdelay
    if (getSettings("ifSupportTst") && isEnabledOpenerTabId) setTimeout(tryOpen, openDelay);
    else tryOpen();
  });
}
