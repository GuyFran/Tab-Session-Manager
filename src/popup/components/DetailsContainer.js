import React, { Component } from "react";
import browser from "webextension-polyfill";
import browserInfo from "browser-info";
import openUrl from "../actions/openUrl";
import { sendOpenMessage } from "../actions/controlSessions";
import PlusIcon from "../icons/plus.svg";
import CollapseIcon from "../icons/collapse.svg";
import EditIcon from "../icons/edit.svg";
import WindowMenuItems from "./WindowMenuItems";
import TriangleIcon from "../icons/triangle.svg";
import WindowIcon from "../icons/window.svg";
import { getWindowsOrder } from "../../common/editSessions.js";
import WindowIncognitoChromeIcon from "../icons/window_incognito_chrome.svg";
import WindowIncognitoFirefoxIcon from "../icons/window_incognito_firefox.svg";

import "../styles/DetailsContainer.scss";
import Highlighter from "react-highlight-words";

const FavIcon = props => (
  <img
    className="favIcon"
    src={props.favIconUrl || "/icons/favicon.png"}
    onError={e => {
      const target = e.target;
      setTimeout(() => (target.src = "/icons/favicon.png"), 0);
    }}
  />
);

const RemoveButton = props => (
  <button
    className="removeButton"
    onClick={props.handleClick}
    title={browser.i18n.getMessage("remove")}
  >
    <PlusIcon />
  </button>
);

const MoveButton = props => (
  <button
    className={`moveButton ${props.direction === -1 ? "moveUp" : "moveDown"}`}
    onClick={props.handleClick}
    disabled={props.disabled}
    title={browser.i18n.getMessage(
      props.direction === -1 ? "moveWindowUpLabel" : "moveWindowDownLabel"
    )}
  >
    <TriangleIcon />
  </button>
);

const EditButton = props => (
  <button
    className="editButton"
    onClick={props.handleClick}
    title={browser.i18n.getMessage("editWindowLabel")}
  >
    <EditIcon />
  </button>
);

const TabContainer = props => {
  const { tab, windowId, allTabsNumber, searchWords, handleRemoveTab } = props;
  const handleRemoveClick = () => {
    handleRemoveTab(windowId, tab.id);
  };

  const handleOpenClick = e => {
    if (e.button === 0) openUrl(tab.url, tab.title, true);
    else if (e.button === 1) openUrl(tab.url, tab.title, false);
  };

  return (
    <div className="tabContainer">
      <button className="tabButton" onMouseUp={handleOpenClick} title={`${tab.title}\n${tab.url}`}>
        <FavIcon favIconUrl={tab.favIconUrl} />
        <span className="tabTitle">
          <Highlighter
            searchWords={searchWords}
            textToHighlight={tab.title || ""}
            autoEscape={true}
          />
        </span>
      </button>
      <div className="buttonsContainer">
        {allTabsNumber > 1 && <RemoveButton handleClick={handleRemoveClick} />}
      </div>
    </div>
  );
};

class WindowContainer extends Component {
  constructor(props) {
    super(props);
    this.state = { isCollapsed: false };
  }

  getTabsNumberText = () => {
    const tabLabel = browser.i18n.getMessage("tabLabel");
    const tabsLabel = browser.i18n.getMessage("tabsLabel");
    const tabsNumber = Object.keys(this.props.tabs).length;
    const tabsNumberText = `${tabsNumber} ${tabsNumber > 1 ? tabsLabel : tabLabel}`;
    return tabsNumberText;
  };

  handleRemoveClick = () => {
    const { windowId, handleRemoveWindow } = this.props;
    handleRemoveWindow(windowId);
  };

  handleMoveClick = offset => {
    const { windowId, handleMoveWindow } = this.props;
    handleMoveWindow(windowId, offset);
  };

  handleOpenClick = () => {
    const { sessionId, windowId } = this.props;
    sendOpenMessage(sessionId, "openInNewWindow", windowId);
  };

  handleEditClick = e => {
    const { sessionId, windowId } = this.props;
    const rect = e.target.getBoundingClientRect();
    const { x, y } = { x: e.pageX || rect.x, y: e.pageY || rect.y };
    this.props.openMenu(x, y, <WindowMenuItems sessionId={sessionId} windowId={windowId} />);
    e.preventDefault();
  };

  toggleCollapsed = () => {
    const isCollapsed = !this.state.isCollapsed;
    this.setState({ isCollapsed: isCollapsed });
  };

  render() {
    const {
      windowTitle,
      windowId,
      tabs,
      windowsNumber,
      allTabsNumber,
      searchWords,
      handleRemoveTab
    } = this.props;
    const sortedTabs = Object.values(tabs).sort((a, b) => a.index - b.index);
    const isIncognito = Object.values(tabs)[0].incognito;

    return (
      <div className={`windowContainer ${this.state.isCollapsed ? "isCollapsed" : ""}`}>
        <div className="windowInfo" onContextMenu={this.handleEditClick}>
          <div className="leftWrapper">
            <button className="collapseButton" onClick={this.toggleCollapsed}>
              <CollapseIcon />
            </button>
            <div className="windowIcon">
              {isIncognito ? (
                browserInfo().name === "Chrome" ? (
                  <WindowIncognitoChromeIcon />
                ) : (
                  <WindowIncognitoFirefoxIcon />
                )
              ) : (
                <WindowIcon />
              )}
            </div>
            <button
              className="windowTitle"
              onClick={this.handleOpenClick}
              title={browser.i18n.getMessage("openInNewWindowLabel")}
            >
              {windowTitle ||
                Object.values(tabs).find(tab => tab.active)?.title ||
                browser.i18n.getMessage("windowLabel")}
            </button>
            <span className="tabsNumber">{this.getTabsNumberText()}</span>
          </div>
          <div className="buttonsContainer">
            {windowsNumber > 1 && (
              <MoveButton
                direction={-1}
                disabled={this.props.orderIndex === 0}
                handleClick={() => this.handleMoveClick(-1)}
              />
            )}
            {windowsNumber > 1 && (
              <MoveButton
                direction={1}
                disabled={this.props.orderIndex === windowsNumber - 1}
                handleClick={() => this.handleMoveClick(1)}
              />
            )}
            <EditButton handleClick={this.handleEditClick} />
            {windowsNumber > 1 && <RemoveButton handleClick={this.handleRemoveClick} />}
          </div>
        </div>
        <div className="tabs">
          {Object.values(sortedTabs).map(tab => (
            <TabContainer
              tab={tab}
              windowId={windowId}
              allTabsNumber={allTabsNumber}
              searchWords={searchWords}
              handleRemoveTab={handleRemoveTab}
              key={tab.id}
            />
          ))}
        </div>
      </div>
    );
  }
}

export default props => {
  const { session, searchWords, removeWindow, removeTab, moveWindow, openMenu } = props;

  if (!session.windows) return null;

  const handleRemoveWindow = windowId => {
    removeWindow(session, windowId);
  };

  const handleRemoveTab = (windowId, tabId) => {
    removeTab(session, windowId, tabId);
  };

  const handleMoveWindow = (windowId, offset) => {
    moveWindow(session, windowId, offset);
  };

  return (
    <div className="detailsContainer scrollbar">
      {getWindowsOrder(session).map((windowId, orderIndex) => (
        <WindowContainer
          tabs={session.windows[windowId]}
          windowTitle={session?.windowsInfo?.[windowId]?.title}
          windowId={windowId}
          orderIndex={orderIndex}
          sessionId={session.id}
          windowsNumber={session.windowsNumber}
          allTabsNumber={session.tabsNumber}
          searchWords={searchWords}
          handleRemoveWindow={handleRemoveWindow}
          handleRemoveTab={handleRemoveTab}
          handleMoveWindow={handleMoveWindow}
          openMenu={openMenu}
          key={`${session.id}${windowId}`}
        />
      ))}
    </div>
  );
};
