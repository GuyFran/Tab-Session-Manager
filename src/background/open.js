import browser from "webextension-polyfill";
import browserInfo from "browser-info";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { returnReplaceURL, replacePage } from "./replace.js";
import { updateTabGroups, isEnabledTabGroups } from "../common/tabGroups";
import { isTrackingSession, setLastFocusedWindowId, startTracking } from "./track.js";
import { createRestoreDebug } from "./restoreDebug.js";
import { getWindowsOrder } from "../common/editSessions.js";

const logDir = "background/open";


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
  try {
    for (const win of getWindowsOrder(session)) {
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

    // v7.4.41: 復元後の自動スウィープは廃止。スウィープはpopupの手動操作のみ
    // (全ウィンドウ並行 or ウィンドウ単位)で起動する
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

// どのタブの話かを特定する識別子。URLもタイトルも記録しない — ウィンドウ内の位置のみ
const tabRef = tab => ({ index: tab?.index });

const DISCARD_RETRY_DELAY_MS = 500;
const URL_COMMIT_TIMEOUT_MS = 3000;
const URL_COMMIT_POLL_MS = 50;

// tabs.create() resolves before the new tab's navigation has been registered.
// Discarding during that gap throws the pending navigation away and leaves a
// permanently blank tab (url ""), which cannot be recovered by activating it or
// by the preload sweep. Wait until the tab reports its URL before discarding.
// Measured in Chrome 152: the URL is normally present after ~50 ms.
const waitForUrlCommit = async (tabId, trace = null, ref = {}) => {
  const deadline = Date.now() + URL_COMMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.url && tab.url !== "about:blank") return true;
    await new Promise(resolve => setTimeout(resolve, URL_COMMIT_POLL_MS));
  }
  log.warn(logDir, "waitForUrlCommit() timed out", tabId);
  trace?.add("tab-url-commit-timeout", { tabId: tabId, timeoutMs: URL_COMMIT_TIMEOUT_MS, ...ref });
  return false;
};

// placeholderの代わりに生成直後のタブをdiscardして、読み込みを止める
// 生成直後は破棄できないことがあるため、失敗したら一度だけ再試行する
// Returns the discarded tab's id, which Chrome changes on discard, or null.
//
// URL保護(空白タブ対策): 大きなセッションや重い環境ではナビゲーション登録が
// URL_COMMIT_TIMEOUT_MSを超えることがあり、そのままdiscardすると恒久的に
// url="" のタブになる(ユーザ報告)。3段構えで守る:
//   1. URLが確定しなければ意図したURLへ明示的に再ナビゲートして待ち直す
//   2. それでも確定しなければdiscardを諦める(読み込みは続くが、後の手動
//      スウィープが休止させる。空白で固定されるよりずっと良い)
//   3. discard後にURLが消えていたら(hasUrl=false)、discard済みタブへ
//      tabs.update({url})で復旧させ、確定を待ってからもう一度discardする
const discardAfterCreate = async (tabId, intendedUrl = null, trace = null, ref = {}) => {
  let committed = await waitForUrlCommit(tabId, trace, ref);
  if (!committed && intendedUrl) {
    trace?.add("tab-url-renavigate", { tabId: tabId, ...ref });
    await browser.tabs.update(tabId, { url: intendedUrl }).catch(() => {});
    committed = await waitForUrlCommit(tabId, trace, ref);
  }
  if (!committed) {
    log.warn(logDir, "discardAfterCreate() url never committed, skipping discard", tabId);
    trace?.add("tab-discard-skipped-no-url", { tabId: tabId, ...ref });
    return null;
  }

  const tryDiscard = async id => {
    try {
      // Chrome resolves discard() with the updated tab. Querying the tab again
      // can fail for an incognito tab even when discard itself succeeded, and
      // the discarded tab is given a NEW id, so the old one no longer resolves.
      const discardedTab = await browser.tabs.discard(id);
      const discarded = Boolean(discardedTab?.discarded);
      // Never record the URL itself — only whether one survived the discard.
      trace?.add("tab-discard-result", {
        tabId: id,
        discardedTabId: discardedTab?.id,
        discarded: discarded,
        hasUrl: Boolean(discardedTab?.url)
      });
      return discarded ? discardedTab : null;
    } catch (e) {
      trace?.add("tab-discard-error", { tabId: id, message: e?.message || String(e), ...ref });
      return null;
    }
  };

  // discard成功でもURLが失われていたら復旧を試みる
  const repairIfBlank = async discardedTab => {
    if (!discardedTab || discardedTab.url || !intendedUrl) return discardedTab;
    const repairId = discardedTab.id ?? tabId;
    log.warn(logDir, "discardAfterCreate() blank after discard, repairing", repairId);
    trace?.add("tab-blank-repair", { tabId: repairId, ...ref });
    await browser.tabs.update(repairId, { url: intendedUrl }).catch(() => {});
    const recommitted = await waitForUrlCommit(repairId, trace, ref);
    if (!recommitted) return discardedTab;
    const rediscarded = await tryDiscard(repairId);
    return rediscarded || discardedTab;
  };

  const first = await repairIfBlank(await tryDiscard(tabId));
  if (first) return first.id ?? null;
  trace?.add("tab-discard-retry", { tabId: tabId, delayMs: DISCARD_RETRY_DELAY_MS });
  await new Promise(resolve => setTimeout(resolve, DISCARD_RETRY_DELAY_MS));
  const second = await repairIfBlank(await tryDiscard(tabId));
  if (second) return second.id ?? null;
  log.warn(logDir, "discardAfterCreate() failed", tabId);
  trace?.add("tab-discard-failed", { tabId: tabId, ...ref });
  return null;
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

const createTabGroups = async (windowId, tabs, tabGroupsInfo, trace = null) => {
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
    try {
      const groupId = await browser.tabs.group({
        createProperties: { windowId: windowId },
        tabIds: group.tabIds
      });
      trace?.add("tab-group-created", { groupId: groupId, tabCount: group.tabIds.length });
      const groupInfo = tabGroupsInfo.find(info => info.id === group.originalGroupId);
      if (groupInfo && getSettings("saveTabGroupsV2")) updateTabGroups(groupId, groupInfo);
    } catch (e) {
      trace?.add("tab-group-error", {
        tabCount: group.tabIds.length,
        error: e?.message || String(e)
      });
      log.warn(logDir, "createTabGroups() group failed", e?.message);
    }
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

  // 保存データ自体にURLの無いタブ(過去の不具合や読み込み中保存で汚染されたセッション)を
  // 検出して知らせる。復元では修復できない — about:blankのまま開くしかない
  const savedBlankCount = sortedTabs.filter(
    tab => !tab.url || tab.url === "about:blank"
  ).length;
  if (savedBlankCount > 0) {
    trace?.add("saved-blank-urls", { savedWindowId: win, count: savedBlankCount });
    for (const blankTab of sortedTabs.filter(tab => !tab.url || tab.url === "about:blank")) {
      trace?.add("saved-blank-url", { savedWindowId: win, ...tabRef(blankTab) });
    }
    log.warn(logDir, "createTabs() saved session contains blank URLs", win, savedBlankCount);
  }

  sortedTabs.sort((a, b) => {
    return a.index - b.index;
  });


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
      batch: batchNumber,
      ...tabRef(tab)
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
          message: e?.message || String(e),
          ...tabRef(tab)
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
    const groupedTabCount = sortedTabs.filter(tab => tab.groupId > 0).length;
    trace?.add("tab-groups-restore", {
      windowId: currentWindow.id,
      groupCount: (session.tabGroups || []).length,
      groupedTabCount
    });
    createTabGroups(currentWindow.id, sortedTabs, session.tabGroups || [], trace);
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
        if (shouldDiscardAfterCreate) {
          // discard() gives the tab a new id; keep tabList pointing at the live tab.
          const discardedId = await discardAfterCreate(newTab.id, tab.url, trace, tabRef(tab));
          if (discardedId != null) tabList[tab.id] = discardedId;
        }
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
        if (shouldDiscardAfterCreate) {
          const discardedId = await discardAfterCreate(newTab.id, tab.url, trace, tabRef(tab));
          if (discardedId != null) tabList[tab.id] = discardedId;
        }
        resolve();
      }
    };

    //Tree Style Tabに対応ならdelay
    if (getSettings("ifSupportTst") && isEnabledOpenerTabId) setTimeout(tryOpen, openDelay);
    else tryOpen();
  });
}
