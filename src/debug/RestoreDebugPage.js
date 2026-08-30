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

  clearLog = async () => {
    await browser.runtime.sendMessage({ message: "clearRestoreDebug" }).catch(() => {});
    this.setState({ restoreDebug: null, copied: false, downloadError: "" });
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
          <SummaryItem
            label="Blank (URL lost)"
            value={summary.blankTabs}
            warning={summary.blankTabs > 0}
          />
          <SummaryItem label="Thumbs stored" value={summary.thumbStored} />
          <SummaryItem
            label="Thumb failures"
            value={summary.thumbFailed}
            warning={summary.thumbFailed > 0}
          />
          <SummaryItem label="Thumb skipped (benign)" value={summary.thumbSkipped} />
          <SummaryItem
            label="Sweeps deferred"
            value={summary.sweepDeferred}
            warning={summary.sweepDeferred > 0}
          />
          <SummaryItem
            label="Tab groups created"
            value={
              summary.tabGroupsRestored == null && !summary.tabGroupsCreated
                ? "—"
                : `${summary.tabGroupsCreated || 0}${
                    summary.tabGroupsRestored > 0 ? `/${summary.tabGroupsRestored}` : ""
                  } (${summary.groupedTabsCreated || 0} tabs)`
            }
            warning={summary.tabGroupErrors > 0}
          />
          <SummaryItem
            label="Groups kept on hibernate"
            value={summary.groupsPreserved}
            warning={summary.groupErrors > 0}
          />
          {(summary.tabGroupErrors > 0 || summary.groupErrors > 0) && (
            <SummaryItem
              label="Group errors"
              value={(summary.tabGroupErrors || 0) + (summary.groupErrors || 0)}
              warning
            />
          )}
        </section>

        {summary.lastGroupError && (
          <div className="restoreError">Last tab-group failure: {summary.lastGroupError}</div>
        )}

        {Object.keys(summary.sweepWindowSkips || {}).length > 0 && (
          <div className="skipExplainer">
            Windows skipped by the sweep:{" "}
            {Object.entries(summary.sweepWindowSkips)
              .map(([reason, count]) => `${reason} ×${count}`)
              .join(", ")}
            . "ifCaptureThumbnails-off" = thumbnail capture is disabled in Settings, so sweeping an
            incognito window would gain nothing.
          </div>
        )}

        {summary.thumbSkipped > 0 && (
          <div className="skipExplainer">
            Skipped captures are normal, not lost thumbnails:{" "}
            {Object.entries(summary.thumbSkipReasons || {})
              .map(([reason, count]) => `${reason} ×${count}`)
              .join(", ") || "—"}
            . "rate-limit" = duplicate attempt for a URL already captured moments ago (the sweep
            and two passive listeners fire for the same tab — only one must succeed); "pre-check"
            = tab not finished loading or not an http(s) page at that instant; "private-gate" =
            passive capture of an incognito tab while "save private windows" is off.
          </div>
        )}

        {summary.lastThumbError && (
          <div className="restoreError">
            Last thumbnail failure: {summary.lastThumbError}
          </div>
        )}

        {summary.sweepDeferred > 0 && (
          <div className="restoreError">
            The restored window was not visible, so thumbnails could not be captured
            (Chrome refuses to render hidden windows). The sweep will resume automatically
            the next time that window is focused — bring it to the front and keep it visible.
          </div>
        )}

        {summary.blankTabs > 0 && (
          <div className="restoreError">
            {summary.blankTabs} tab{summary.blankTabs === 1 ? "" : "s"} were discarded before their
            URL was registered and are now permanently blank — activating them or running the sweep
            cannot recover them.
          </div>
        )}

        {summary.debugTabLimit && (
          <div className="restoreError">
            DEBUG TAB LIMIT ACTIVE — restoring at most {summary.debugTabLimit} tabs per window
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
          <button onClick={this.clearLog}>Clear</button>
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
