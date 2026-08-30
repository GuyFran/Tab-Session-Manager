import browser from "webextension-polyfill";
import log from "loglevel";
import {
  setAutoSave,
  handleTabUpdated,
  handleTabRemoved,
  autoSaveWhenWindowClose,
  autoSaveWhenExitBrowser,
  setUpdateTempTimer,
  openLastSession,
  autoSaveWhenOpenInCurrentWindow,
  autoSaveRegular
} from "./autoSave";
import Sessions from "./sessions";
import { replacePage } from "./replace";
import importSessions from "./import";
import { backupSessions, resetLastBackupTime } from "./backup";
import {
  loadCurrentSession,
  saveCurrentSession,
  saveSession,
  removeSession,
  deleteAllSessions,
  updateSession,
  renameSession,
  setSessionStartTime
} from "./save";
import getSessions from "./getSessions";
import { openSession } from "./open";
import { addTag, removeTag, applyDeviceName } from "./tag";
import { initSettings, handleSettingsChange, getSettings } from "src/settings/settings";
import exportSessions, { handleDownloadsChanged } from "./export";
import onInstalledListener from "./onInstalledListener";
import onUpdateAvailableListener from "./onUpdateAvailableListener";
import { onCommandListener } from "./keyboardShortcuts";
import { openStartupSessions } from "./startup";
import { signInGoogle, signOutGoogle } from "./cloudAuth";
import { syncCloud, syncCloudAuto, getSyncStatus } from "./cloudSync";
import { updateLogLevel, overWriteLogLevel } from "../common/log";
import { getsearchInfo } from "./search";
import { recordChange, undo, redo, updateUndoStatus } from "./undo";
import { compressAllSessions } from "./compressAllSessions";
import { startTracking, endTrackingByWindowDelete, updateTrackingStatus } from "./track";
import { handleThumbnailTabUpdated, handleThumbnailTabActivated } from "./thumbnails";
import {
  startPreloadSweep,
  stopPreloadSweep,
  getPreloadSweepStatus,
  getSweepingWindowId,
  handleWindowFocusForDeferredSweep
} from "./preloadSweep";
import { getRestoreDebug, downloadRestoreDebug, clearRestoreDebug } from "./restoreDebug";

const logDir = "background/background";

let IsInit = false;
export const init = async () => {
  if (IsInit) return;
  await initSettings();
  overWriteLogLevel();
  updateLogLevel();
  log.info(logDir, "init()");
  await Sessions.init();
  IsInit = true;
};

const onStartupListener = async () => {
  await init();
  log.info(logDir, "onStartupListener()");
  await setSessionStartTime();
  await autoSaveWhenExitBrowser();
  const startupBehavior = getSettings("startupBehavior");
  if (startupBehavior === "previousSession") openLastSession();
  else if (startupBehavior === "startupSession") openStartupSessions();
  setAutoSave();
  syncCloudAuto();
  browser.alarms.create("backupSessions", { delayInMinutes: 0.5 });
};

const onMessageListener = async (request, sender, sendResponse) => {
  await init();
  log.info(logDir, "onMessageListener()", request);
  switch (request.message) {
    case "save": {
      const afterSession = await saveSession(request.session);
      recordChange(null, afterSession);
      return afterSession;
    }
    case "saveCurrentSession": {
      const name = request.name;
      const property = request.property;
      const afterSession = await saveCurrentSession(name, [], property);
      recordChange(null, afterSession);
      return afterSession;
    }
    case "open":
      if (request.property === "openInCurrentWindow") await autoSaveWhenOpenInCurrentWindow();
      return await openSession(request.session, request.property);
    case "remove": {
      const beforeSession = await getSessions(request.id);
      await removeSession(request.id, request.isSendResponce);
      recordChange(beforeSession, null);
      break;
    }
    case "rename": {
      const beforeSession = await getSessions(request.id);
      const afterSession = await renameSession(request.id, request.name);
      recordChange(beforeSession, afterSession);
      break;
    }
    case "update": {
      const beforeSession = await getSessions(request.session.id);
      await updateSession(request.session, request.isSendResponce);
      recordChange(beforeSession, request.session);
      break;
    }
    case "import":
      importSessions(request.importSessions);
      break;
    case "exportSessions":
      exportSessions(request.id);
      break;
    case "deleteAllSessions":
      deleteAllSessions();
      break;
    case "getSessions": {
      const sessions = await getSessions(request.id, request.needKeys);
      return sessions;
    }
    case "addTag": {
      const beforeSession = await getSessions(request.id);
      const afterSession = await addTag(request.id, request.tag);
      recordChange(beforeSession, afterSession);
      break;
    }
    case "removeTag": {
      const beforeSession = await getSessions(request.id);
      const afterSession = await removeTag(request.id, request.tag);
      recordChange(beforeSession, afterSession);
      break;
    }
    case "getInitState":
      return IsInit;
    case "getCurrentSession": {
      const currentSession = await loadCurrentSession("", [], request.property).catch(() => {});
      return currentSession;
    }
    case "signInGoogle":
      return await signInGoogle();
    case "signOutGoogle":
      return await signOutGoogle();
    case "syncCloud":
      return await syncCloud();
    case "getSyncStatus":
      return getSyncStatus();
    case "applyDeviceName":
      return await applyDeviceName();
    case "getsearchInfo":
      return await getsearchInfo();
    case "requestAllSessions": {
      const sendResponse = (sessions, isEnd) =>
        browser.runtime
          .sendMessage({
            message: "responseAllSessions",
            sessions: sessions,
            isEnd: isEnd,
            port: request.port
          })
          .catch(() => {});
      return Sessions.getAllWithStream(sendResponse, request.needKeys, request.count);
    }
    case "undo":
      return undo();
    case "redo":
      return redo();
    case "updateUndoStatus":
      return updateUndoStatus();
    case "compressAllSessions": {
      const sendResponse = status =>
        browser.runtime
          .sendMessage({
            message: "updateCompressStatus",
            status: status,
            port: request.port
          })
          .catch(() => {});
      return compressAllSessions(sendResponse);
    }
    case "updateTrackingStatus":
      return updateTrackingStatus();
    case "startTracking":
      return startTracking(request.sessionId, request.originalWindowId, request.openedWindowId);
    case "endTrackingByWindowDelete":
      return endTrackingByWindowDelete(request.sessionId, request.originalWindowId);
    case "startPreloadSweep":
      return startPreloadSweep(request.windowIds, { manual: !!request.manual });
    case "stopPreloadSweep":
      return stopPreloadSweep();
    case "getPreloadSweepStatus":
      return getPreloadSweepStatus();
    case "getRestoreDebug":
      return getRestoreDebug();
    case "downloadRestoreDebug":
      return downloadRestoreDebug();
    case "clearRestoreDebug":
      return clearRestoreDebug();
  }
};

// tabs.onActivatedはactiveInfo({tabId, windowId})、windows.onFocusChangedはwindowIdを渡す
const handleReplace = async info => {
  await init();
  const eventWindowId = typeof info === "number" ? info : info?.windowId;
  if (eventWindowId === browser.windows.WINDOW_ID_NONE) return;
  // スウィープ対象のウィンドウではタブのアクティブ化と実URLへの遷移をpreloadSweepが行う。
  // ここでもreplacePage()を呼ぶと同じタブに対して二重に遷移を仕掛けることになり、
  // 遷移が確定せずplaceholderのまま残る。ただし抑制はそのウィンドウ由来のイベントに
  // 限定する — 全体を抑制すると、スウィープ中にユーザが他ウィンドウでアクティブにした
  // placeholderが遷移しないまま取り残される
  const sweepingWindowId = getSweepingWindowId();
  if (sweepingWindowId != null && eventWindowId === sweepingWindowId) return;
  // 遷移先はイベントが起きたウィンドウを明示する。既定のWINDOW_ID_CURRENT(最後に
  // フォーカスされたウィンドウ)は、スウィープ中や複数ウィンドウ操作中はイベント元と
  // 食い違うことがあり、抑制の判定と遷移の対象がずれてしまう
  if (eventWindowId != null) replacePage(eventWindowId);
  else replacePage();
};

const onChangeStorageListener = async (changes, areaName) => {
  await init();
  handleSettingsChange(changes, areaName);
  setAutoSave(changes, areaName);
  updateLogLevel();
  resetLastBackupTime(changes);
};

// サムネイルのキャプチャはgetSettingsに依存するため、initの完了を待つ
const onThumbnailTabUpdatedListener = async (tabId, changeInfo, tab) => {
  await init();
  handleThumbnailTabUpdated(tabId, changeInfo, tab);
};

const onThumbnailTabActivatedListener = async activeInfo => {
  await init();
  handleThumbnailTabActivated(activeInfo);
};

const onAlarmListener = async alarmInfo => {
  await init();
  log.info(logDir, "onAlarmListener()", alarmInfo);
  switch (alarmInfo.name) {
    case "autoSaveRegular":
      return autoSaveRegular();
    case "backupSessions":
      return backupSessions();
  }
};

browser.runtime.onStartup.addListener(onStartupListener);
browser.runtime.onInstalled.addListener(onInstalledListener);
browser.runtime.onUpdateAvailable.addListener(onUpdateAvailableListener);
browser.runtime.onMessage.addListener(onMessageListener);
browser.commands.onCommand.addListener(onCommandListener);
browser.tabs.onActivated.addListener(handleReplace);
browser.windows.onFocusChanged.addListener(handleReplace);
// 隠れていてキャプチャできず延期したウィンドウを、フォーカスされたときに再スウィープする
browser.windows.onFocusChanged.addListener(handleWindowFocusForDeferredSweep);
browser.tabs.onUpdated.addListener(handleTabUpdated);
browser.tabs.onUpdated.addListener(onThumbnailTabUpdatedListener);
browser.tabs.onActivated.addListener(onThumbnailTabActivatedListener);
browser.tabs.onRemoved.addListener(handleTabRemoved);
browser.tabs.onCreated.addListener(setUpdateTempTimer);
browser.tabs.onMoved.addListener(setUpdateTempTimer);
browser.windows.onCreated.addListener(setUpdateTempTimer);
browser.windows.onRemoved.addListener(autoSaveWhenWindowClose);
browser.downloads.onChanged.addListener(handleDownloadsChanged);
browser.storage.local.onChanged.addListener(onChangeStorageListener);
browser.alarms.onAlarm.addListener(onAlarmListener);
