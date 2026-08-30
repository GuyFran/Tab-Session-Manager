import React, { Component } from "react";
import browser from "webextension-polyfill";
import "../styles/OptionsArea.scss";
import SearchBar from "./SearchBar";
import { generateTagLabel } from "../actions/generateTagLabel";
import SearchIcon from "../icons/search.svg";
import UpdateIcon from "../icons/update.svg";

const alphabeticallySort = (a, b) => {
  if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
  else if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
};

const countAllTags = sessions => {
  let count = {
    all: 0,
    user: 0,
    auto: 0,
    regular: 0,
    winClose: 0,
    browserExit: 0,
    tags: []
  };

  let tagsCount = {};
  for (const session of sessions) {
    const tags = session.tag;
    count.all++;

    if (tags.includes("temp")) {
      count.all--;
      continue;
    } else if (tags.includes("regular")) {
      count.auto++;
      count.regular++;
    } else if (tags.includes("winClose")) {
      count.auto++;
      count.winClose++;
    } else if (tags.includes("browserExit")) {
      count.auto++;
      count.browserExit++;
    } else {
      count.user++;
    }

    for (const tag of tags) {
      if (tag == "regular" || tag == "winClose" || tag == "browserExit" || tag == "") continue;
      tagsCount[tag] = tagsCount[tag] || 0;
      tagsCount[tag]++;
    }
  }

  for (const tag in tagsCount) {
    count.tags.push({
      name: tag,
      count: tagsCount[tag]
    });
  }
  count.tags.sort(alphabeticallySort);

  return count;
};

const isHitFilter = (filterValue, tagsCount) => {
  switch (filterValue) {
    case "_displayAll":
      return true;
    case "_auto":
      return tagsCount.auto > 0;
    case "_user":
      return tagsCount.user > 0;
    case "winClose":
    case "browserExit":
    case "regular":
      return tagsCount[filterValue] > 0;
    default:
      const tag = tagsCount.tags.find(e => e.name === filterValue);
      return tag !== undefined;
  }
};

const isShowAutoOption = tagsCount => {
  const autoSaveCounts = [tagsCount.winClose, tagsCount.browserExit, tagsCount.regular];
  const existsMultiItems = autoSaveCounts.filter(count => count > 0).length >= 2;
  return existsMultiItems;
};

export default class OptionsArea extends Component {
  state = { showSweepMenu: false, openWindows: [], currentWindowId: null };

  handleFilterChange = e => {
    const filterValue = e.target.value;
    this.props.changeFilter(filterValue);
  };

  handleSortChange = e => {
    const sortValue = e.target.value;
    this.props.changeSort(sortValue);
  };

  // スウィープメニューを開く。開くたびに現在のウィンドウ一覧を取り直す
  toggleSweepMenu = async () => {
    if (this.state.showSweepMenu) {
      this.setState({ showSweepMenu: false });
      return;
    }
    const [windows, currentWindow] = await Promise.all([
      browser.windows.getAll({ populate: true }).catch(() => []),
      browser.windows.getCurrent().catch(() => null)
    ]);
    const openWindows = windows
      .filter(w => w.type === "normal")
      .map(w => ({
        id: w.id,
        incognito: w.incognito,
        tabCount: (w.tabs || []).length,
        title: (w.tabs || []).find(t => t.active)?.title || ""
      }));
    this.setState({
      showSweepMenu: true,
      openWindows,
      currentWindowId: currentWindow?.id ?? null
    });
  };

  sweepWindows = windowIds => {
    browser.runtime.sendMessage({
      message: "startPreloadSweep",
      windowIds,
      manual: true
    });
    this.setState({ showSweepMenu: false });
  };

  stopWindow = windowId => {
    browser.runtime.sendMessage({ message: "stopPreloadSweep", windowId });
  };

  componentDidUpdate() {
    const tagsCount = countAllTags(this.props.sessions);
    if (!isHitFilter(this.props.filterValue, tagsCount)) this.props.changeFilter("_displayAll");
  }

  render() {
    const tagsCount = countAllTags(this.props.sessions);
    return (
      <div id="optionsArea">
        <div className="line">
          <div className="selectWrap filter">
            <select
              onChange={this.handleFilterChange}
              value={this.props.filterValue}
              title={browser.i18n.getMessage("categoryFilterLabel")}
            >
              <option value="_displayAll">
                {browser.i18n.getMessage("displayAllLabel")} [{tagsCount.all}]
              </option>
              {isShowAutoOption(tagsCount) && (
                <option value="_auto">
                  {browser.i18n.getMessage("displayAutoLabel")} [{tagsCount.auto}]
                </option>
              )}
              {tagsCount.winClose > 0 && (
                <option value="winClose">
                  {browser.i18n.getMessage("winCloseSessionName")} [{tagsCount.winClose}]
                </option>
              )}
              {tagsCount.browserExit > 0 && (
                <option value="browserExit">
                  {browser.i18n.getMessage("browserExitSessionName")} [{tagsCount.browserExit}]
                </option>
              )}
              {tagsCount.regular > 0 && (
                <option value="regular">
                  {browser.i18n.getMessage("regularSaveSessionName")} [{tagsCount.regular}]
                </option>
              )}
              {tagsCount.user > 0 && (
                <option value="_user">
                  {browser.i18n.getMessage("displayUserLabel")} [{tagsCount.user}]
                </option>
              )}
              {tagsCount.tags.map((tag, index) => (
                <option value={tag.name} key={index}>
                  {generateTagLabel(tag.name)} [{tag.count}]
                </option>
              ))}
            </select>
          </div>
          <div className="selectWrap sort">
            <select
              onChange={this.handleSortChange}
              value={this.props.sortValue}
              title={browser.i18n.getMessage("sortLabel")}
            >
              <option value="newest">{browser.i18n.getMessage("newestLabel")}</option>
              <option value="oldest">{browser.i18n.getMessage("oldestLabel")}</option>
              <option value="aToZ">{browser.i18n.getMessage("aToZLabel")}</option>
              <option value="zToA">{browser.i18n.getMessage("zToALabel")}</option>
              <option value="tabsDes">{browser.i18n.getMessage("tabsDesLabel")}</option>
              <option value="tabsAsc">{browser.i18n.getMessage("tabsAscLabel")}</option>
            </select>
          </div>
          <button
            className={`lineSweepButton ${this.props.sweepStatus?.isSweeping ? "sweeping" : ""}`}
            onClick={this.toggleSweepMenu}
            title={browser.i18n.getMessage("startPreloadSweepLabel")}
          >
            <UpdateIcon />
            {this.props.sweepStatus?.isSweeping && this.props.sweepStatus.remainingCount > 0 && (
              <span className="count">{this.props.sweepStatus.remainingCount}</span>
            )}
          </button>
          {this.state.showSweepMenu && (
            <>
              <div className="sweepMenuOverlay" onClick={() => this.setState({ showSweepMenu: false })} />
              <div className="sweepMenu">
                <button
                  className="sweepMenuRow all"
                  onClick={() => this.sweepWindows(this.state.openWindows.map(w => w.id))}
                >
                  <UpdateIcon />
                  <span className="label">Sweep all windows ({this.state.openWindows.length})</span>
                </button>
                {this.state.openWindows.map(w => {
                  const isSweeping = (this.props.sweepStatus?.sweepingWindowIds || []).includes(w.id);
                  return (
                    <button
                      key={w.id}
                      className={`sweepMenuRow ${isSweeping ? "sweeping" : ""}`}
                      onClick={() => (isSweeping ? this.stopWindow(w.id) : this.sweepWindows([w.id]))}
                      title={w.title}
                    >
                      <span className="badge">{w.incognito ? "🕶" : "🪟"}</span>
                      <span className="label">
                        {w.id === this.state.currentWindowId ? "This window" : w.title || "Window"}
                        {` — ${w.tabCount} tab${w.tabCount === 1 ? "" : "s"}`}
                      </span>
                      <span className="action">{isSweeping ? "Stop" : "Sweep"}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <button
            className="searchButton"
            onClick={() => this.props.toggleSearchBar()}
            title={browser.i18n.getMessage("search")}
            ref={this.props.optionsAreaRef}
          >
            <SearchIcon />
          </button>
        </div>
        {this.props.isShowSearchBar && (
          <SearchBar
            toggleSearchBar={this.props.toggleSearchBar}
            changeSearchWord={this.props.changeSearchWord}
            searchBarRef={this.props.searchBarRef}
            sessionsAreaRef={this.props.sessionsAreaRef}
          />
        )}
      </div>
    );
  }
}
