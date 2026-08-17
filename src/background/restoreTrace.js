import browser from "webextension-polyfill";

const MAX_ENTRIES = 2000;

const timestampForFileName = () => new Date().toISOString().replace(/[:.]/g, "-");

export const createRestoreTrace = (session, property) => {
  const entries = [];
  const traceTimestamp = timestampForFileName();
  let snapshotNumber = 0;
  const add = (event, details = {}) => {
    if (entries.length >= MAX_ENTRIES) return;
    entries.push(
      JSON.stringify({
        at: new Date().toISOString(),
        event: event,
        ...details
      })
    );
  };

  const windowSummary = Object.values(session.windows).map(tabs => {
    const tabList = Object.values(tabs);
    return {
      incognito: tabList.some(tab => tab.incognito),
      tabCount: tabList.length
    };
  });
  add("restore-start", {
    extensionVersion: browser.runtime.getManifest().version,
    extensionId: browser.runtime.id,
    property: property,
    windows: windowSummary
  });

  const snapshot = async label => {
    snapshotNumber++;
    const url = `data:text/plain;charset=utf-8,${encodeURIComponent(entries.join("\n"))}`;
    try {
      await browser.downloads.download({
        url: url,
        filename: `TabSessionManager/restore-trace-${traceTimestamp}-${snapshotNumber}-${label}.log`,
        conflictAction: "uniquify",
        saveAs: false
      });
    } catch (e) {}
  };

  return {
    add,
    snapshot,
    download: async () => {
      add("restore-trace-complete");
      await snapshot("final");
    }
  };
};
