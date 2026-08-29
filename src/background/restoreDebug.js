import browser from "webextension-polyfill";

const MAX_EVENTS = 2000;
const DEBUG_PAGE_PATH = "debug/index.html";

let activeRestoreDebug = null;
let debugWindowId = null;
let pendingBroadcast = null;

const makeSnapshot = () => {
  if (!activeRestoreDebug) return null;
  return {
    id: activeRestoreDebug.id,
    phase: activeRestoreDebug.phase,
    startedAt: activeRestoreDebug.startedAt,
    extensionVersion: activeRestoreDebug.extensionVersion,
    extensionId: activeRestoreDebug.extensionId,
    requestedProperty: activeRestoreDebug.requestedProperty,
    summary: { ...activeRestoreDebug.summary },
    events: activeRestoreDebug.events
  };
};

const broadcast = () => {
  if (pendingBroadcast) return;
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    browser.runtime
      .sendMessage({ message: "restoreDebugUpdated", restoreDebug: makeSnapshot() })
      .catch(() => {});
  }, 75);
};

// どのイベントにもURLを載せない方針の防波堤。詳細値にURLらしき文字列が
// 紛れ込んでも記録前に潰す
const sanitizeDetails = details => {
  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] =
      typeof value === "string"
        ? value.replace(/(?:https?|file|ftp|chrome-extension|chrome|about|data):[^\s"']*/gi, "<url>")
        : value;
  }
  return sanitized;
};

const makeDefaultSummary = (windows = [], totalTabs = 0) => ({
  savedWindows: windows,
  savedTabCount: totalTabs,
  totalTabs: 0,
  createdWindowCount: 0,
  configuredBatchSize: null,
  totalBatches: 0,
  currentBatch: 0,
  finishedBatches: 0,
  createdTabs: 0,
  finishedTabs: 0,
  failedTabs: 0,
  discardedTabs: 0,
  discardSkippedTabs: 0,
  discardErrors: 0,
  blankTabs: 0,
  urlCommitTimeouts: 0,
  debugTabLimit: null,
  debugSkippedTabs: 0,
  restoreError: null,
  thumbStored: 0,
  thumbFailed: 0,
  thumbSkipped: 0,
  sweepDeferred: 0,
  lastThumbError: null
});

const updateSummary = event => {
  if (!activeRestoreDebug) return;
  const summary = activeRestoreDebug.summary;
  switch (event.event) {
    case "thumb-stored":
      summary.thumbStored = (summary.thumbStored || 0) + 1;
      break;
    case "thumb-failed":
      summary.thumbFailed = (summary.thumbFailed || 0) + 1;
      summary.lastThumbError = event.error || "unknown";
      break;
    case "thumb-skip":
      summary.thumbSkipped = (summary.thumbSkipped || 0) + 1;
      break;
    case "sweep-window-deferred":
      summary.sweepDeferred = (summary.sweepDeferred || 0) + 1;
      break;
    case "restore-routing":
      activeRestoreDebug.phase = "restoring";
      summary.effectiveProperty = event.effectiveProperty;
      break;
    case "debug-tab-limit":
      summary.debugTabLimit = event.limit;
      break;
    case "debug-tab-limit-applied":
      summary.debugSkippedTabs += event.skipped;
      break;
    case "window-created":
      summary.createdWindowCount++;
      break;
    case "tab-batching":
      summary.totalTabs += event.tabCount;
      summary.configuredBatchSize = event.effectiveBatchSize;
      summary.totalBatches += Math.ceil(event.tabCount / event.effectiveBatchSize);
      break;
    case "tab-created":
    case "tab-created-fallback":
      summary.createdTabs++;
      break;
    case "tab-create-finished":
      summary.finishedTabs++;
      break;
    case "tab-create-error":
      summary.failedTabs++;
      break;
    case "tab-discard-result":
      if (event.discarded) summary.discardedTabs++;
      else summary.discardSkippedTabs++;
      // A discarded tab with no URL is permanently blank — the tab cannot be
      // recovered by activating it or by the preload sweep.
      if (event.discarded && event.hasUrl === false) summary.blankTabs++;
      break;
    case "tab-url-commit-timeout":
      summary.urlCommitTimeouts++;
      break;
    case "tab-discard-error":
    case "tab-discard-failed":
      summary.discardErrors++;
      break;
    case "batch-wait-start":
      summary.currentBatch = event.batch;
      break;
    case "batch-wait-finished":
      summary.finishedBatches++;
      break;
    case "restore-finished":
      activeRestoreDebug.phase = "finished";
      break;
    case "restore-error":
      activeRestoreDebug.phase = "error";
      summary.restoreError = event.message;
      break;
  }
};

const openDebugPanel = async add => {
  if (debugWindowId !== null) {
    const existingWindow = await browser.windows.get(debugWindowId).catch(() => null);
    if (existingWindow) {
      add("debug-panel-reused", { windowId: debugWindowId });
      return;
    }
  }

  const debugWindow = await browser.windows.create({
    url: browser.runtime.getURL(DEBUG_PAGE_PATH),
    type: "popup",
    width: 860,
    height: 760,
    focused: false
  });
  debugWindowId = debugWindow.id;
  add("debug-panel-opened", { windowId: debugWindow.id });
};

browser.windows.onRemoved.addListener(windowId => {
  if (windowId === debugWindowId) debugWindowId = null;
});

const appendEvent = (eventName, details = {}) => {
  if (!activeRestoreDebug || activeRestoreDebug.events.length >= MAX_EVENTS) return;
  const event = {
    at: new Date().toISOString(),
    event: eventName,
    ...details
  };
  activeRestoreDebug.events.push(event);
  updateSummary(event);
  broadcast();
};

// スウィープや延期再開はSW再起動後(復元セッションのデバッグがメモリから消えた後)にも
// 走る。デバッグセッションが無ければスウィープ専用のものを遅延生成する。
// 新しいウィンドウは開かない — 開いたままのデバッグパネルが1秒ポーリングで拾う
const ensureDebugSession = () => {
  if (activeRestoreDebug) return;
  const manifest = browser.runtime.getManifest();
  activeRestoreDebug = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    phase: "sweep",
    startedAt: new Date().toISOString(),
    extensionVersion: manifest.version,
    extensionId: browser.runtime.id,
    requestedProperty: "(post-restore sweep)",
    summary: makeDefaultSummary(),
    events: []
  };
};

// スウィープ/サムネイル側からデバッグパネルへイベントを送る入口。URLは記録しない
export const addSweepDebugEvent = (eventName, details = {}) => {
  ensureDebugSession();
  appendEvent(eventName, sanitizeDetails(details));
};

export const createRestoreDebug = (session, property) => {
  const manifest = browser.runtime.getManifest();
  const windows = Object.values(session.windows).map(tabs => {
    const tabList = Object.values(tabs);
    return {
      incognito: tabList.some(tab => tab.incognito),
      tabCount: tabList.length
    };
  });
  const totalTabs = windows.reduce((total, window) => total + window.tabCount, 0);

  activeRestoreDebug = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    phase: "starting",
    startedAt: new Date().toISOString(),
    extensionVersion: manifest.version,
    extensionId: browser.runtime.id,
    requestedProperty: property,
    summary: makeDefaultSummary(windows, totalTabs),
    events: []
  };

  const add = appendEvent;

  add("restore-start", {
    extensionVersion: manifest.version,
    extensionId: browser.runtime.id,
    property: property,
    windows: windows
  });
  openDebugPanel(add).catch(error => {
    add("debug-panel-error", { message: error?.message || String(error) });
  });

  return {
    add,
    finish: () => {
      if (activeRestoreDebug?.phase === "starting") activeRestoreDebug.phase = "finished";
      broadcast();
    }
  };
};

export const getRestoreDebug = () => makeSnapshot();

export const downloadRestoreDebug = async () => {
  const restoreDebug = makeSnapshot();
  if (!restoreDebug) return false;
  const lines = [
    JSON.stringify({
      restoreDebug: {
        ...restoreDebug,
        events: undefined
      }
    }),
    ...restoreDebug.events.map(event => JSON.stringify(event))
  ];
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(lines.join("\n"))}`;
  await browser.downloads.download({
    url: url,
    filename: `TabSessionManager/restore-debug-${restoreDebug.startedAt.replace(/[:.]/g, "-")}.log`,
    conflictAction: "uniquify",
    saveAs: false
  });
  return true;
};
