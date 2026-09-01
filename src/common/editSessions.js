import browser from "webextension-polyfill";
import _ from "lodash";
import clone from "clone";
import log from "loglevel";

const logDir = "common/editSessions";

// windowsOrder はユーザーが並べ替えた場合のみ存在する。無ければ
// Object.keys(session.windows) の順(数値キー昇順)がそのまま表示/復元順
export const getWindowsOrder = session => {
  const ids = Object.keys(session.windows);
  const saved = Array.isArray(session.windowsOrder)
    ? session.windowsOrder.map(String).filter(id => ids.includes(id))
    : [];
  for (const id of ids) {
    if (!saved.includes(id)) saved.push(id);
  }
  return saved;
};

export const moveWindow = (session, winId, offset) => {
  log.info(logDir, "moveWindow()", winId, offset);
  const order = getWindowsOrder(session);
  const from = order.indexOf(String(winId));
  const to = from + offset;
  if (from === -1 || to < 0 || to >= order.length) return null;

  session = clone(session);
  order.splice(to, 0, ...order.splice(from, 1));
  session.windowsOrder = order;
  return session;
};

export const deleteWindow = (session, winId) => {
  log.info(logDir, "deleteWindow()", session, winId);
  session = clone(session);
  session.windowsNumber--;
  session.tabsNumber -= Object.keys(session.windows[winId]).length;
  if (session.tabsNumber <= 0) return Promise.reject();

  delete session.windows[winId];
  if (session.windowsInfo !== undefined) delete session.windowsInfo[winId];
  if (Array.isArray(session.windowsOrder))
    session.windowsOrder = session.windowsOrder.filter(id => String(id) !== String(winId));

  return session;
};

export const deleteTab = (session, winId, tabId) => {
  log.info(logDir, "deleteTab()", session, winId, tabId);
  session = clone(session);
  session.tabsNumber--;
  if (session.tabsNumber <= 0) return Promise.reject();
  const deletedTabIndex = session.windows[winId][tabId].index;

  delete session.windows[winId][tabId];
  if (session.windowsInfo !== undefined) delete session.windowsInfo[winId][tabId];

  if (Object.keys(session.windows[winId]).length === 0) {
    return deleteWindow(session, winId);
  }

  const window = session.windows[winId];
  for (const tab in window) {
    //openerTabIdを削除
    if (window[tab].openerTabId != undefined) {
      if (window[tab].openerTabId == tabId) delete window[tab].openerTabId;
    }
    //indexを変更
    if (window[tab].index > deletedTabIndex) window[tab].index--;
  }

  return session;
};
