import { v4 as uuidv4 } from "uuid";
import log from "loglevel";

const logDir = "common/mergeSessions";

// Merge multiple full session objects into one new session.
// Window ids, tab ids and tab group ids are re-numbered so they never collide.
// When discardDuplicates is true, a tab whose URL already appeared earlier in the
// merge (source order = order of the sessions array) is skipped; windows that end
// up empty are dropped.
export const mergeSessions = (sessions, name, discardDuplicates = false) => {
  log.info(logDir, "mergeSessions()", sessions.map(s => s.id), name, discardDuplicates);

  const mergedSession = {
    windows: {},
    windowsNumber: 0,
    windowsInfo: {},
    tabsNumber: 0,
    name: name,
    date: Date.now(),
    lastEditedTime: Date.now(),
    tag: [],
    sessionStartTime: Math.min(...sessions.map(s => s.sessionStartTime || s.date)),
    id: uuidv4()
  };
  const mergedTabGroups = [];

  const seenUrls = new Set();
  let nextWindowId = 1;
  let nextTabId = 1;
  let nextGroupId = 1;

  for (const session of sessions) {
    const groupIdMap = {};

    for (const winId of Object.keys(session.windows)) {
      const newWinId = nextWindowId++;
      const newWindow = {};
      const tabIdMap = {};
      const tabs = Object.values(session.windows[winId]).sort((a, b) => a.index - b.index);

      let index = 0;
      for (const tab of tabs) {
        if (discardDuplicates) {
          const url = tab.url || tab.pendingUrl || "";
          if (seenUrls.has(url)) continue;
          seenUrls.add(url);
        }

        const newTab = { ...tab };
        const newTabId = nextTabId++;
        tabIdMap[tab.id] = newTabId;
        newTab.id = newTabId;
        newTab.windowId = newWinId;
        newTab.index = index++;

        if (newTab.openerTabId !== undefined) {
          if (tabIdMap[newTab.openerTabId] !== undefined)
            newTab.openerTabId = tabIdMap[newTab.openerTabId];
          else delete newTab.openerTabId;
        }

        if (newTab.groupId > 0) {
          if (!(newTab.groupId in groupIdMap)) {
            const srcGroup = (session.tabGroups || []).find(group => group.id === newTab.groupId);
            if (srcGroup) {
              const newGroupId = nextGroupId++;
              groupIdMap[newTab.groupId] = newGroupId;
              mergedTabGroups.push({ ...srcGroup, id: newGroupId, windowId: newWinId });
            } else {
              groupIdMap[newTab.groupId] = -1;
            }
          }
          newTab.groupId = groupIdMap[newTab.groupId];
        }

        newWindow[newTabId] = newTab;
      }

      const tabsCount = Object.keys(newWindow).length;
      if (tabsCount === 0) continue;

      mergedSession.windows[newWinId] = newWindow;
      mergedSession.windowsNumber++;
      mergedSession.tabsNumber += tabsCount;
      if (session.windowsInfo?.[winId])
        mergedSession.windowsInfo[newWinId] = { ...session.windowsInfo[winId], id: newWinId };
    }
  }

  // Drop groups no remaining tab references (their tabs were all duplicates)
  const referencedGroupIds = new Set(
    Object.values(mergedSession.windows)
      .flatMap(window => Object.values(window))
      .map(tab => tab.groupId)
      .filter(groupId => groupId > 0)
  );
  const tabGroups = mergedTabGroups.filter(group => referencedGroupIds.has(group.id));
  if (tabGroups.length > 0) mergedSession.tabGroups = tabGroups;

  log.info(logDir, "=>mergeSessions()", mergedSession);
  return mergedSession;
};
