import browser from "webextension-polyfill";

const MAX_ENTRIES = 2000;

const timestampForFileName = () => new Date().toISOString().replace(/[:.]/g, "-");

export const createRestoreTrace = (session, property) => {
  const entries = [];
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

  return {
    add,
    download: async () => {
      add("restore-trace-complete");
      const url = `data:text/plain;charset=utf-8,${encodeURIComponent(entries.join("\n"))}`;
      try {
        await browser.downloads.download({
          url: url,
          filename: `TabSessionManager/restore-trace-${timestampForFileName()}.log`,
          conflictAction: "uniquify",
          saveAs: false
        });
      } catch (e) {}
    }
  };
};
