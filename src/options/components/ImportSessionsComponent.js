import React, { Component } from "react";
import browser from "webextension-polyfill";
import moment from "moment";
import mozlz4a from "mozlz4a";
import { v4 as uuidv4 } from "uuid";
import OptionContainer from "./OptionContainer";

// Every failure path resolves { error: "<reason>" } instead of a silent undefined,
// so the options page can show WHY a read failed. Success resolves { sessions }.
const fileOpen = file => {
  const lowerName = file.name.toLowerCase();
  if (/(?:\.jsonlz4|\.baklz4)(-\d+)?$/.test(lowerName)) {
    // sessionstore.jsonlz4
    // previous.jsonlz4
    // recovery.baklz4
    // upgrade.jsonlz4-20211001010123
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onerror = () => resolve({ error: `FileReader failed: ${reader.error}` });
      reader.onload = async () => {
        try {
          let input = new Uint8Array(reader.result);
          let output;
          try {
            output = mozlz4a.decompress(input);
          } catch (e) {
            return resolve({ error: `mozlz4 decompression failed: ${e.message || e}` });
          }
          return resolve({ sessions: await convertMozLz4Sessionstore(output) });
        } catch (e) {
          return resolve({ error: `${e.message || e}` });
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onerror = () => resolve({ error: `FileReader failed: ${reader.error}` });
    reader.onload = () => {
      try {
        let text = reader.result;
        if (lowerName.endsWith(".json")) {
          // Ignore BOM
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

          let jsonFile;
          try {
            jsonFile = JSON.parse(text);
          } catch (e) {
            return resolve({ error: `JSON parse failed: ${e.message}` });
          }

          const tsmProblem = diagnoseTSM(jsonFile);
          if (tsmProblem === null) {
            return resolve({ sessions: parseSession(jsonFile) });
          }
          const sbProblem = diagnoseSessionBuddy(jsonFile);
          if (sbProblem === null) {
            return resolve({ sessions: convertSessionBuddy(jsonFile) });
          }
          const sb3Problem = diagnoseSessionBuddy3(jsonFile);
          if (sb3Problem === null) {
            return resolve({ sessions: convertSessionBuddy3(jsonFile) });
          }

          return resolve({
            error:
              `unrecognized JSON. As TSM export: ${tsmProblem}. ` +
              `As Session Buddy export: ${sbProblem}. ` +
              `As Session Buddy v3 export: ${sb3Problem}.`
          });
        }

        if (lowerName.endsWith(".session")) {
          return resolve({ sessions: convertSessionManager(text) });
        }

        return resolve({ error: "unsupported file extension (.json, .session, .jsonlz4, .baklz4)" });
      } catch (e) {
        return resolve({ error: `${e.message || e}` });
      }
    };
    reader.readAsText(file);
  });
};

const isJSON = arg => {
  arg = typeof arg === "function" ? arg() : arg;
  if (typeof arg !== "string") return false;
  try {
    arg = !JSON ? eval("(" + arg + ")") : JSON.parse(arg);
    return true;
  } catch (e) {
    return false;
  }
};

const isArray = o => {
  return Object.prototype.toString.call(o) === "[object Array]";
};

// Returns null if the file is a valid TSM export, otherwise a string explaining
// the first problem found (which session, which keys are missing).
const diagnoseTSM = file => {
  if (!isArray(file))
    return `top level is ${Object.prototype.toString.call(file).slice(8, -1)}, expected an array of sessions`;

  const correctKeys = ["windows", "tabsNumber", "name", "date", "tag", "sessionStartTime"];
  for (let i = 0; i < file.length; i++) {
    const session = file[i];
    if (session === null || typeof session !== "object")
      return `session #${i + 1} is ${session === null ? "null" : typeof session}, expected an object`;
    const sessionKeys = Object.keys(session);
    const missing = correctKeys.filter(key => !sessionKeys.includes(key));
    if (missing.length > 0)
      return `session #${i + 1}${session.name ? ` ("${session.name}")` : ""} is missing key(s): ${missing.join(", ")}`;
  }
  return null;
};

const parseSession = file => {
  for (const session of file) {
    //ver1.9.2以前のセッションのタグを配列に変更
    if (!Array.isArray(session.tag)) {
      session.tag = session.tag.split(" ");
    }
    //ver1.9.2以前のセッションにUUIDを追加 タグからauto, userを削除
    if (!session["id"]) {
      session["id"] = uuidv4();

      session.tag = session.tag.filter(element => {
        return !(element == "user" || element == "auto");
      });
    }
    //windowsNumberを追加
    if (session.windowsNumber === undefined) {
      session.windowsNumber = Object.keys(session.windows).length;
    }
    //ver4.0.0以前のdateをunix msに変更
    if (typeof session.date !== "number") {
      session.date = moment(session.date).valueOf();
    }
    //ver6.0.0以前のセッションにlastEditedTimeを追加
    if (session.lastEditedTime === undefined) {
      session.lastEditedTime = session.date;
    }
  }
  return file;
};

// Returns null if the file is a valid Session Buddy export, otherwise a string
// explaining the first problem found.
const diagnoseSessionBuddy = file => {
  const currentKeys = ["generated", "type", "windows"];
  const previousKeys = ["created", "generated", "gid", "id", "type", "windows"];
  const savedKeys = ["created", "generated", "gid", "id", "modified", "name", "type", "windows"];
  if (!file || typeof file !== "object" || !file.hasOwnProperty("sessions"))
    return "no 'sessions' property";
  if (!isArray(file.sessions)) return "'sessions' is not an array";

  const requiredKeysByType = { current: currentKeys, previous: previousKeys, saved: savedKeys };
  for (let i = 0; i < file.sessions.length; i++) {
    const session = file.sessions[i];
    const requiredKeys = requiredKeysByType[session?.type];
    if (!requiredKeys)
      return `session #${i + 1} has unknown type "${session?.type}" (expected current/previous/saved)`;
    const missing = requiredKeys.filter(key => !session.hasOwnProperty(key));
    if (missing.length > 0)
      return `session #${i + 1} (type "${session.type}") is missing key(s): ${missing.join(", ")}`;
  }
  return null;
};

const convertSessionBuddy = file => {
  let sessions = [];
  for (const SBSession of file.sessions) {
    let session = {
      windows: {},
      windowsNumber: 0,
      windowsInfo: {},
      tabsNumber: 0,
      name: SBSession?.name || "Unnamed Session",
      date: moment(SBSession?.created || new Date()).valueOf(),
      lastEditedTime: Date.now(),
      tag: [],
      sessionStartTime: moment(SBSession?.generated || new Date()).valueOf(),
      id: uuidv4()
    };

    for (const window of SBSession.windows) {
      session.windows[window.id] = {};
      for (const tab of window.tabs) {
        session.windows[window.id][tab.id] = tab;
        session.tabsNumber++;
      }
      session.windowsInfo[window.id] = window;
      delete session.windowsInfo[window.id].tabs;
      session.windowsNumber++;
    }

    sessions.push(session);
  }

  return sessions;
};

// Session Buddy v3 export: { collections: [ { title, folders: [ { links: [ {url, title, favIconUrl} ], ...windowGeometry } ] } ] }
// Returns null if the file matches, otherwise a string explaining the first problem found.
const diagnoseSessionBuddy3 = file => {
  if (!file || typeof file !== "object" || !file.hasOwnProperty("collections"))
    return "no 'collections' property";
  if (!isArray(file.collections)) return "'collections' is not an array";
  for (let i = 0; i < file.collections.length; i++) {
    const collection = file.collections[i];
    if (!isArray(collection?.folders)) return `collection #${i + 1} has no 'folders' array`;
    for (let j = 0; j < collection.folders.length; j++) {
      if (!isArray(collection.folders[j]?.links))
        return `collection #${i + 1} folder #${j + 1} has no 'links' array`;
    }
  }
  return null;
};

const convertSessionBuddy3 = file => {
  const sessions = [];
  for (const collection of file.collections) {
    // Collection titles look like "Sep 1, 2026  •  5:19 PM" — try to recover the date,
    // fall back to now if the title is edited or localized
    const titleAsDate = Date.parse(
      String(collection.title || "")
        .replace(/[•   ]/g, " ")
        .replace(/\s+/g, " ")
    );
    const date = isNaN(titleAsDate) ? Date.now() : titleAsDate;

    const session = {
      windows: {},
      windowsNumber: 0,
      windowsInfo: {},
      tabsNumber: 0,
      name: collection.title || "Session Buddy collection",
      date: date,
      lastEditedTime: Date.now(),
      tag: [],
      sessionStartTime: date,
      id: uuidv4()
    };

    let windowId = 1;
    for (const folder of collection.folders) {
      session.windows[windowId] = {};
      let index = 0;
      for (const link of folder.links) {
        // open.js decides the incognito state of the restored window from its
        // tabs' incognito flag, not from windowsInfo — stamp it on every tab
        session.windows[windowId][index] = {
          id: index,
          index: index,
          windowId: windowId,
          url: link.url,
          title: link.title || link.url,
          favIconUrl: link.favIconUrl,
          active: !!link.active,
          pinned: !!link.pinned,
          incognito: !!folder.incognito
        };
        index++;
      }
      const { links, ...windowInfo } = folder;
      session.windowsInfo[windowId] = { ...windowInfo, id: windowId };
      session.tabsNumber += index;
      session.windowsNumber++;
      windowId++;
    }

    sessions.push(session);
  }

  return sessions;
};

const convertSessionManager = file => {
  let session = {};
  const line = file.split(/\r\n|\r|\n/);
  if (line.length < 5)
    throw new Error(
      `.session file has only ${line.length} line(s), expected at least 5 (Session Manager format)`
    );

  session.windows = {};
  session.windowsNumber = 0;
  session.tabsNumber = 0;
  session.name = line[1].slice(5);
  session.date = moment(parseInt(line[2].slice(10))).valueOf();
  session.lastEditedTime = Date.now();
  session.tag = [];
  session.sessionStartTime = parseInt(line[2].slice(10));
  session.id = uuidv4();

  if (!isJSON(line[4]))
    throw new Error(".session file line 5 is not valid JSON (Session Manager format)");

  const sessionData = JSON.parse(line[4]);

  for (const win in sessionData.windows) {
    session.windows[win] = {};
    let index = 0;
    for (const tab of sessionData.windows[win].tabs) {
      const entryIndex = tab.index - 1;
      session.windows[win][index] = {
        id: index,
        index: index,
        windowId: parseInt(win),
        lastAccessed: tab.lastAccessed,
        url: tab.entries[entryIndex].url,
        title: tab.entries[entryIndex].title,
        favIconUrl: tab.image
      };
      index++;
    }
    session.tabsNumber += index;
  }
  session.windowsNumber = Object.keys(session.windows).length;
  return [session];
};

const convertMozLz4Sessionstore = async file => {
  let mozSession;
  try {
    mozSession = JSON.parse(new TextDecoder().decode(file));
  } catch (e) {
    throw new Error(`decompressed lz4 payload is not valid JSON: ${e.message}`);
  }
  if (!(mozSession?.version?.[0] === "sessionrestore" && mozSession.version[1] === 1)) {
    throw new Error(
      `unsupported sessionstore version: ${JSON.stringify(mozSession?.version)} (expected ["sessionrestore", 1])`
    );
  }

  let session = {};
  session.windows = {};
  session.windowsNumber = 0;
  session.tabsNumber = 0;
  session.name = "sessionstore backup " + moment(mozSession.session.lastUpdate).toLocaleString();
  session.date = mozSession.session.lastUpdate;
  session.lastEditedTime = Date.now();
  session.tag = [];
  session.sessionStartTime = mozSession.session.startTime;
  session.id = uuidv4();

  for (const win in mozSession.windows) {
    session.windows[win] = {};
    let index = 0;
    for (const tab of mozSession.windows[win].tabs) {
      const entryIndex = tab.index - 1;
      if (tab.entries[entryIndex]) {
        session.windows[win][index] = {
          id: index,
          index: index,
          windowId: parseInt(win, 10),
          lastAccessed: tab.lastAccessed,
          url: tab.entries[entryIndex].url,
          title: tab.entries[entryIndex].title,
          favIconUrl: tab.image,
          discarded: true
        };
      } else {
        // User typed value into URL bar but page was not loaded
        session.windows[win][index] = {
          id: index,
          index: index,
          windowId: parseInt(win, 10),
          lastAccessed: tab.lastAccessed,
          url: "about:blank#" + tab.userTypedValue,
          title: "New Tab",
          favIconUrl: tab.image,
          discarded: true
        };
      }
      index++;
    }
    session.tabsNumber += index;
  }
  session.windowsNumber = Object.keys(session.windows).length;
  return [session];
};

const getSessionsState = (sessions, error) => {
  const sessionLabel = browser.i18n.getMessage("sessionLabel").toLowerCase();
  const sessionsLabel = browser.i18n.getMessage("sessionsLabel").toLowerCase();
  let sessionsState;
  if (sessions == undefined) {
    sessionsState = browser.i18n.getMessage("readFailedMessage");
    if (error) sessionsState += ` — ${error}`;
  } else if (sessions.length <= 1) sessionsState = `${sessions.length} ${sessionLabel}`;
  else sessionsState = `${sessions.length} ${sessionsLabel}`;
  return sessionsState;
};

const IMPORT_LOG_KEY = "importDebugLog";
const IMPORT_LOG_MAX = 300;

const formatLogTime = ms => {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

export default class ImportSessionsComponent extends Component {
  constructor() {
    super();
    this.state = {
      importedFiles: [],
      importedSessions: [],
      importLog: [],
      copyState: ""
    };
  }

  async componentDidMount() {
    try {
      const stored = await browser.storage.local.get(IMPORT_LOG_KEY);
      if (Array.isArray(stored?.[IMPORT_LOG_KEY])) {
        this.setState({ importLog: stored[IMPORT_LOG_KEY] });
      }
    } catch (e) {}
  }

  appendLog(level, text) {
    const entry = { time: Date.now(), level, text };
    if (level === "error") console.error(`[TSM import] ${text}`);
    else console.log(`[TSM import] ${text}`);
    this.setState(
      prev => ({ importLog: prev.importLog.concat(entry).slice(-IMPORT_LOG_MAX) }),
      () => {
        browser.storage.local.set({ [IMPORT_LOG_KEY]: this.state.importLog }).catch(() => {});
      }
    );
  }

  logText() {
    return this.state.importLog
      .map(e => `${formatLogTime(e.time)} ${e.level === "error" ? "ERROR" : "info "} ${e.text}`)
      .join("\n");
  }

  async copyLog() {
    const text = this.logText();
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copyState: "✔ copied" });
    } catch (e) {
      // clipboard API can be refused without focus; fall back to execCommand
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        this.setState({ copyState: "✔ copied" });
      } catch (e2) {
        this.setState({ copyState: `copy failed: ${e2.message || e2}` });
      }
    }
    setTimeout(() => this.setState({ copyState: "" }), 2500);
  }

  clearLog() {
    this.setState({ importLog: [] });
    browser.storage.local.remove(IMPORT_LOG_KEY).catch(() => {});
  }

  async readSessions(e) {
    const files = e.target.files;
    if (files == undefined) return;

    for (const file of files) {
      this.appendLog("info", `reading "${file.name}" (${file.size.toLocaleString()} bytes)`);
      const startedAt = Date.now();
      const result = (await fileOpen(file)) || {};
      const sessions = result.sessions;
      const elapsed = Date.now() - startedAt;
      if (result.error) {
        this.appendLog("error", `"${file.name}" read FAILED after ${elapsed} ms: ${result.error}`);
      } else {
        const tabs = (sessions || []).reduce((sum, s) => sum + (s?.tabsNumber || 0), 0);
        this.appendLog(
          "info",
          `"${file.name}" read OK in ${elapsed} ms: ${sessions.length} session(s), ${tabs} tab(s)`
        );
      }

      const importedFiles = this.state.importedFiles.concat({
        name: file.name,
        state: getSessionsState(sessions, result.error)
      });
      let importedSessions;
      if (sessions === undefined) importedSessions = this.state.importedSessions;
      else importedSessions = this.state.importedSessions.concat(sessions);

      this.setState({
        importedFiles: importedFiles,
        importedSessions: importedSessions
      });
    }
    // allow re-selecting the same file after a failure
    e.target.value = "";
  }

  async importSessions() {
    if (!this.state.importedSessions.length) return;

    const sendImportMessage = async sessions => {
      if (sessions.length == 0) return;
      try {
        await browser.runtime.sendMessage({
          message: "import",
          importSessions: sessions
        });
        this.appendLog("info", `sent ${sessions.length} session(s) to background for saving`);
      } catch (e) {
        //セッションが巨大だとsendMessageに失敗する
        //その場合は2分割して送信する
        if (sessions.length <= 1) {
          this.appendLog(
            "error",
            `import of session "${sessions[0]?.name}" FAILED (cannot split further): ${e.message || e}`
          );
          return;
        }
        this.appendLog(
          "error",
          `sendMessage failed for ${sessions.length} session(s) (${e.message || e}) — splitting in half and retrying`
        );
        const midIndex = Math.floor(sessions.length / 2);
        await sendImportMessage(sessions.slice(0, midIndex));
        await sendImportMessage(sessions.slice(midIndex, sessions.length + 1));
      }
    };

    this.appendLog("info", `importing ${this.state.importedSessions.length} session(s)…`);
    await sendImportMessage(this.state.importedSessions);
    this.appendLog("info", "import finished");

    alert(browser.i18n.getMessage("importMessage"));
    this.clearSessions();
  }

  clearSessions() {
    this.setState({
      importedFiles: [],
      importedSessions: []
    });
  }

  render() {
    const buttons = (
      <div className="optionElement buttonsContainer">
        <div className="optionForm">
          <input
            type="button"
            value={browser.i18n.getMessage("importSaveButtonLabel")}
            onClick={this.importSessions.bind(this)}
          />
        </div>
        <div className="optionForm">
          <input
            type="button"
            value={browser.i18n.getMessage("cancelLabel")}
            onClick={this.clearSessions.bind(this)}
          />
        </div>
      </div>
    );

    const log = this.state.importLog;
    const importLogPanel = (
      <div style={{ margin: "10px 0 0 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <p style={{ fontWeight: "bold", margin: 0 }}>Import log</p>
          <input type="button" value="Copy logs" onClick={this.copyLog.bind(this)} />
          <input type="button" value="Clear" onClick={this.clearLog.bind(this)} />
          {this.state.copyState && <span className="caption">{this.state.copyState}</span>}
        </div>
        {log.length === 0 ? (
          <p className="caption">No import activity recorded yet.</p>
        ) : (
          <pre
            style={{
              maxHeight: "260px",
              overflow: "auto",
              background: "rgba(128, 128, 128, 0.08)",
              border: "1px solid rgba(128, 128, 128, 0.35)",
              borderRadius: "4px",
              padding: "8px",
              margin: "6px 0 0 0",
              fontSize: "11px",
              lineHeight: "1.5",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "text"
            }}
          >
            {log.map((entry, index) => (
              <div key={index} style={entry.level === "error" ? { color: "#d32f2f" } : null}>
                {formatLogTime(entry.time)} {entry.level === "error" ? "ERROR" : "info "}{" "}
                {entry.text}
              </div>
            ))}
          </pre>
        )}
      </div>
    );

    return (
      <div>
        <OptionContainer
          id="import"
          title="importLabel"
          captions={["importCaptionLabel", "importCaptionLabel2"]}
          extraCaption={
            <p className="caption">
              - Tab Session Manager (.json)
              <br />
              - Session Buddy (.json, v3 collections included)
              <br />
              - Session Manager (.session)
              <br />
              - Firefox Session Store Backup (.jsonlz4 .baklz4)
              <br />
              <a
                href="https://github.com/sienori/Tab-Session-Manager/wiki/Q&A:-How-to-import-sessions-from-other-extensions"
                target="_blank"
              >
                {browser.i18n.getMessage("importCaptionLabel3")}{" "}
              </a>
            </p>
          }
          type="file"
          value="importButtonLabel"
          accept=".json, .session, .jsonlz4, .baklz4"
          multiple={true}
          onChange={this.readSessions.bind(this)}
        >
          <ul className="childElements">
            {this.state.importedFiles.map((file, index) => (
              <OptionContainer
                key={index}
                title={file.name}
                captions={[file.state]}
                useRawTitle={true}
                useRawCaptions={true}
                type="none"
              />
            ))}
            {this.state.importedFiles.length > 0 ? buttons : ""}
          </ul>
        </OptionContainer>
        {importLogPanel}
      </div>
    );
  }
}
