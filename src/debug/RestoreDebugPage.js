import React, { Component } from "react";
import browser from "webextension-polyfill";
import { initSettings, getSettings } from "src/settings/settings";

const formatTime = timestamp => (timestamp ? new Date(timestamp).toLocaleTimeString() : "—");

const SummaryItem = ({ label, value, warning = false }) => (
  <div className={`summaryItem ${warning ? "warning" : ""}`}>
    <span>{label}</span>
    <strong>{value ?? "—"}</strong>
  </div>
);

export default class RestoreDebugPage extends Component {
  state = { restoreDebug: null, copied: false, downloadError: "" };

  async componentDidMount() {
    await initSettings();
    document.body.classList.add(`${getSettings("theme")}-theme`);
    browser.runtime.onMessage.addListener(this.handleMessage);
    this.refresh();
    this.refreshTimer = setInterval(this.refresh, 1000);
  }

  componentWillUnmount() {
    browser.runtime.onMessage.removeListener(this.handleMessage);
    clearInterval(this.refreshTimer);
  }

  refresh = async () => {
    const restoreDebug = await browser.runtime
      .sendMessage({ message: "getRestoreDebug" })
      .catch(() => null);
    if (restoreDebug) this.setState({ restoreDebug });
  };

  handleMessage = request => {
    if (request.message === "restoreDebugUpdated" && request.restoreDebug)
      this.setState({ restoreDebug: request.restoreDebug });
  };

  copyLog = async () => {
    const { restoreDebug } = this.state;
    if (!restoreDebug) return;
    await navigator.clipboard.writeText(JSON.stringify(restoreDebug, null, 2));
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 2000);
  };

  downloadLog = async () => {
    const downloaded = await browser.runtime
      .sendMessage({ message: "downloadRestoreDebug" })
      .catch(() => false);
    this.setState({ downloadError: downloaded ? "" : "Download could not be created." });
  };

  render() {
    const { restoreDebug, copied, downloadError } = this.state;
    if (!restoreDebug)
      return <main className="restoreDebug waiting">Waiting for an incognito restore to start.</main>;

    const { summary, events } = restoreDebug;
    const visibleEvents = events.slice(-300);
    return (
      <main className="restoreDebug">
        <header>
          <div>
            <h1>Incognito restore debug</h1>
            <p>
              Live diagnostics only. URLs are never recorded. Started {formatTime(restoreDebug.startedAt)}.
            </p>
          </div>
          <div className={`phase ${restoreDebug.phase}`}>{restoreDebug.phase}</div>
        </header>

        <section className="identity">
          <span>Extension {restoreDebug.extensionVersion}</span>
          <span>ID {restoreDebug.extensionId}</span>
          <span>Requested: {restoreDebug.requestedProperty}</span>
          <span>Effective: {summary.effectiveProperty || "pending"}</span>
        </section>

        <section className="summary">
          <SummaryItem label="Saved tabs" value={summary.savedTabCount} />
          <SummaryItem label="Windows created" value={summary.createdWindowCount} />
          <SummaryItem label="Batch size" value={summary.configuredBatchSize} />
          <SummaryItem label="Batches" value={`${summary.finishedBatches}/${summary.totalBatches}`} />
          <SummaryItem label="Tabs created" value={`${summary.createdTabs}/${summary.totalTabs}`} />
          <SummaryItem label="Tab failures" value={summary.failedTabs} warning={summary.failedTabs > 0} />
          <SummaryItem label="Discarded" value={summary.discardedTabs} />
          <SummaryItem
            label="Discard errors"
            value={summary.discardErrors}
            warning={summary.discardErrors > 0}
          />
        </section>

        {summary.debugTabLimit && (
          <div className="restoreError">
            DEBUG TAB LIMIT ACTIVE — restoring at most {summary.debugTabLimit} tabs per session
            {summary.debugSkippedTabs > 0 &&
              ` (${summary.debugSkippedTabs} tab${summary.debugSkippedTabs === 1 ? "" : "s"} skipped)`}
            . This is
            a temporary testing cap in background/open.js, not a restore failure.
          </div>
        )}

        {summary.restoreError && <div className="restoreError">Restore error: {summary.restoreError}</div>}

        <section className="controls">
          <button onClick={this.copyLog}>{copied ? "Copied" : "Copy complete debug log"}</button>
          <button onClick={this.downloadLog}>Download log</button>
          <button onClick={() => window.close()}>Close</button>
          {downloadError && <span className="restoreError">{downloadError}</span>}
        </section>

        <section className="eventLog scrollbar">
          {visibleEvents.map((event, index) => (
            <pre key={`${event.at}-${index}`}>{JSON.stringify(event)}</pre>
          ))}
        </section>
        {events.length > visibleEvents.length && (
          <footer>Showing the latest {visibleEvents.length} of {events.length} live events.</footer>
        )}
      </main>
    );
  }
}
