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

  refresh = async () => {
    const [all, current] = await Promise.all([
      browser.windows.getAll({ populate: true }).catch(() => []),
      browser.windows.getCurrent().catch(() => null)
    ]);
    const windows = all
      .filter(w => w.type === "normal")
      .map(w => ({
        id: w.id,
        incognito: w.incognito,
        tabCount: (w.tabs || []).length,
        title: (w.tabs || []).find(t => t.active)?.title || "Window"
      }));
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
          const isSweeping = sweepingIds.includes(w.id);
          const remaining = remainingByWindow[w.id];
          return (
            <div className={`windowRow ${isSweeping ? "sweeping" : ""}`} key={w.id} title={w.title}>
              <span className="badge">{w.incognito ? "🕶" : "🪟"}</span>
              <span className="label">
                {w.id === currentWindowId ? "This window" : w.title}
                {` — ${w.tabCount} tab${w.tabCount === 1 ? "" : "s"}`}
              </span>
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
