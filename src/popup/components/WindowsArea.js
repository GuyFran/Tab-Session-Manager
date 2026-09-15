import React, { Component } from "react";
import browser from "webextension-polyfill";
import { getSettings, setSettings } from "src/settings/settings";
import "../styles/WindowsArea.scss";
import UpdateIcon from "../icons/update.svg";

// 開いているウィンドウの一覧と、ウィンドウ単位/全ウィンドウの手動スウィープ操作。
// スウィープの起動方法はここ(+ヘッダーのグローバルボタン)のみ — 自動スウィープは無い
export default class WindowsArea extends Component {
  state = { windows: [], currentWindowId: null, forceRefresh: false };

  componentDidMount() {
    this.setState({ forceRefresh: !!getSettings("ifForceRefreshThumbnailsOnSweep") });
    this.refresh();
    this.timer = setInterval(this.refresh, 3000);
  }

  componentWillUnmount() {
    clearInterval(this.timer);
  }

  // タブ数を数えるには populate:true で全タブを取る必要があるが、800タブ規模では
  // (incognito placeholder の data:URL が1本で数十〜数百KBあるため)1回で数十MBの
  // ダンプになる。3秒ごとにそれを繰り返すのは重すぎるので、全タブ取得は初回と
  // その後15秒に1回だけにし、通常の更新はウィンドウ一覧+アクティブタブ(各ウィンドウ
  // 1件)の軽い問い合わせで済ませる。タブ数は前回の値を引き継ぐ
  refresh = async () => {
    const now = Date.now();
    const heavy = !this.lastCountAt || now - this.lastCountAt > 15000;
    const [all, current, activeTabs] = await Promise.all([
      browser.windows.getAll(heavy ? { populate: true } : {}).catch(() => []),
      browser.windows.getCurrent().catch(() => null),
      heavy ? Promise.resolve([]) : browser.tabs.query({ active: true }).catch(() => [])
    ]);
    if (heavy) this.lastCountAt = now;
    const previousCounts = new Map(this.state.windows.map(w => [w.id, w.tabCount]));
    const windows = all
      .filter(w => w.type === "normal")
      .map(w => {
        const activeTab = heavy
          ? (w.tabs || []).find(t => t.active)
          : activeTabs.find(t => t.windowId === w.id);
        return {
          id: w.id,
          incognito: w.incognito,
          tabCount: heavy ? (w.tabs || []).length : previousCounts.get(w.id) ?? null,
          title: activeTab?.title || "Window"
        };
      });
    // タブ数が未取得の新しいウィンドウがあれば、次回は全タブを取り直す
    if (!heavy && windows.some(w => w.tabCount == null)) this.lastCountAt = 0;
    // 現在のウィンドウを先頭に固定する
    windows.sort(
      (a, b) => (b.id === current?.id ? 1 : 0) - (a.id === current?.id ? 1 : 0)
    );
    this.setState({ windows, currentWindowId: current?.id ?? null });
  };

  sweep = windowIds =>
    browser.runtime.sendMessage({ message: "startPreloadSweep", windowIds, manual: true });

  stop = windowId => browser.runtime.sendMessage({ message: "stopPreloadSweep", windowId });

  // 既定ではサムネイル済みのタブは読み込み直さない。ONにすると全タブを再読込・再キャプチャする
  toggleForceRefresh = e => {
    const forceRefresh = e.target.checked;
    this.setState({ forceRefresh });
    setSettings("ifForceRefreshThumbnailsOnSweep", forceRefresh);
  };

  openDebugPanel = () => browser.runtime.sendMessage({ message: "openRestoreDebugPanel" });

  render() {
    const sweepingIds = this.props.sweepStatus?.sweepingWindowIds || [];
    // 並行上限(preloadSweepMaxParallelWindows)待ちのウィンドウ。Stopは効く
    const queuedIds = this.props.sweepStatus?.queuedWindowIds || [];
    const remainingByWindow = this.props.sweepStatus?.remainingByWindow || {};
    const { windows, currentWindowId } = this.state;
    return (
      <div id="windowsArea">
        <div className="windowsHeader">
          <span className="heading">Open windows ({windows.length})</span>
          <button
            className="debugPanelButton"
            onClick={this.openDebugPanel}
            title="Open the restore/sweep debug panel (data kept for this browser session)"
          >
            🐞
          </button>
          <button
            className="sweepAllButton"
            onClick={() => this.sweep(windows.map(w => w.id))}
            title="Sweep every open window in parallel"
          >
            <UpdateIcon />
            Sweep all
          </button>
        </div>
        <label
          className="forceRefreshToggle"
          title="Off (default): sweeping skips tabs that already have a saved thumbnail — they are not reloaded. On: sweeping reloads every tab and re-captures a fresh thumbnail."
        >
          <input
            type="checkbox"
            checked={this.state.forceRefresh}
            onChange={this.toggleForceRefresh}
          />
          <span>Re-capture thumbnails on sweep</span>
        </label>
        {windows.map(w => {
          const isQueued = queuedIds.includes(w.id);
          const isSweeping = sweepingIds.includes(w.id) || isQueued;
          const remaining = remainingByWindow[w.id];
          return (
            <div
              className={`windowRow ${isSweeping ? "sweeping" : ""} ${isQueued ? "queued" : ""}`}
              key={w.id}
              title={w.title}
            >
              <span className="badge">{w.incognito ? "🕶" : "🪟"}</span>
              <span className="label">
                {w.id === currentWindowId ? "This window" : w.title}
                {w.tabCount == null ? "" : ` — ${w.tabCount} tab${w.tabCount === 1 ? "" : "s"}`}
              </span>
              {isQueued && <span className="queuedTag">queued</span>}
              {isSweeping && remaining > 0 && <span className="remaining">{remaining}</span>}
              <button
                className="rowAction"
                onClick={() => (isSweeping ? this.stop(w.id) : this.sweep([w.id]))}
              >
                {isSweeping ? "Stop" : "Sweep"}
              </button>
            </div>
          );
        })}
      </div>
    );
  }
}
