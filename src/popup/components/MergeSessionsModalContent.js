import React, { Component } from "react";
import browser from "webextension-polyfill";
import moment from "moment";
import { getSettings } from "src/settings/settings";
import { getSessions, mergeSessionsById } from "../actions/controlSessions";
import generateWindowsInfo from "../actions/generateWindowsInfo";
import "../styles/TextInputModalContent.scss";
import "../styles/MergeSessionsModalContent.scss";

export default class MergeSessionsModalContent extends Component {
  constructor(props) {
    super(props);
    this.state = {
      sessions: [],
      checkedIds: [props.session.id],
      discardDuplicates: true,
      name: props.session.name || "",
      isMerging: false
    };
  }

  fetchSessions = async () => {
    const keys = ["id", "name", "date", "tag", "tabsNumber", "windowsNumber"];
    const sessions = (await getSessions(null, keys)) || [];
    const candidates = sessions
      .filter(session => !session.tag.includes("temp"))
      .sort((a, b) => b.date - a.date);
    this.setState({ sessions: candidates });
  };

  componentDidMount() {
    this.fetchSessions();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.session.id !== this.props.session.id) {
      this.setState({
        checkedIds: [this.props.session.id],
        name: this.props.session.name || "",
        isMerging: false
      });
      this.fetchSessions();
    }
  }

  toggleSession = id => {
    const { checkedIds } = this.state;
    if (checkedIds.includes(id))
      this.setState({ checkedIds: checkedIds.filter(checkedId => checkedId !== id) });
    else this.setState({ checkedIds: checkedIds.concat(id) });
  };

  handleSubmit = async e => {
    e.preventDefault();
    const { checkedIds, name, discardDuplicates, sessions } = this.state;
    if (checkedIds.length < 2 || this.state.isMerging) return;
    this.setState({ isMerging: true });

    // Merge in displayed (newest first) order
    const orderedIds = sessions.map(session => session.id).filter(id => checkedIds.includes(id));
    const mergedName = name.trim() || browser.i18n.getMessage("mergedSessionLabel");
    const mergedSession = await mergeSessionsById(orderedIds, mergedName, discardDuplicates);

    this.props.closeModal();
    if (this.props.openNotification) {
      this.props.openNotification(
        mergedSession
          ? {
              message: browser.i18n.getMessage("sessionsMergedLabel"),
              type: "success",
              duration: 3000
            }
          : {
              message: browser.i18n.getMessage("failedMergeSessionsLabel"),
              type: "error"
            }
      );
    }
  };

  render() {
    const { closeModal } = this.props;
    const { sessions, checkedIds, discardDuplicates, name, isMerging } = this.state;
    const dateFormat = getSettings("dateFormat");

    return (
      <div className="textInputModalContent mergeSessionsModalContent">
        <form onSubmit={this.handleSubmit}>
          <input
            type="text"
            value={name}
            spellCheck={false}
            placeholder={browser.i18n.getMessage("mergedSessionLabel")}
            onChange={e => this.setState({ name: e.target.value })}
          />
          <div className="sessionsSelector scrollbar">
            {sessions.map(session => (
              <label className="sessionRow" key={session.id}>
                <input
                  type="checkbox"
                  checked={checkedIds.includes(session.id)}
                  onChange={() => this.toggleSession(session.id)}
                />
                <span className="sessionName">
                  {session.name.trim() === "" ? "_" : session.name}
                </span>
                <span className="sessionInfo">
                  {generateWindowsInfo(session.windowsNumber, session.tabsNumber)}
                  {" - "}
                  {moment(session.date).format(dateFormat)}
                </span>
              </label>
            ))}
          </div>
          <label className="discardDuplicates">
            <input
              type="checkbox"
              checked={discardDuplicates}
              onChange={e => this.setState({ discardDuplicates: e.target.checked })}
            />
            <span>{browser.i18n.getMessage("discardDuplicateTabsLabel")}</span>
          </label>
          <div className="buttons">
            <button type="button" onClick={closeModal}>
              {browser.i18n.getMessage("cancelLabel")}
            </button>
            <button type="submit" className="saveButton" disabled={checkedIds.length < 2 || isMerging}>
              {browser.i18n.getMessage("mergeSessionsButtonLabel")}
            </button>
          </div>
        </form>
      </div>
    );
  }
}
