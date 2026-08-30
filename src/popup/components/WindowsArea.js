import React, { Component } from "react";
import browser from "webextension-polyfill";
import "../styles/WindowsArea.scss";
import UpdateIcon from "../icons/update.svg";

// 開いているウィンドウの一覧と、ウィンドウ単位/全ウィンドウの手動スウィープ操作。
// スウィープの起動方法はここ(+ヘッダーのグローバルボタン)のみ — 自動スウィープは無い
export default class WindowsArea extends Component {
  state = { windows: [], currentWindowId: null };

  componentDidMount() {
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

  render() {
    const sweepingIds = this.props.sweepStatus?.sweepingWindowIds || [];
    const remainingByWindow = this.props.sweepStatus?.remainingByWindow || {};
    const { windows, currentWindowId } = this.state;
    return (
      <div id="windowsArea">
        <div className="windowsHeader">
          <span className="heading">Open windows ({windows.length})</span>
          <button
            className="sweepAllButton"
            onClick={() => this.sweep(windows.map(w => w.id))}
            title="Sweep every open window in parallel"
          >
            <UpdateIcon />
            Sweep all
          </button>
        </div>
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
