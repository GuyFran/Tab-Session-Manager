import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";

const logDir = "background/notify";

// 復元とスウィープの完了をOSの通知で知らせる(ユーザ要望: 完了が見えるように)。
// popupは閉じているのが普通で、service workerにはUIが無いため notifications API を使う。
// 設定 ifNotifyOnRestoreAndSweep(既定オン)でまとめてオン/オフ。
// 保存済み設定に新キーが無い(旧版から更新した)場合は undefined になるので、
// 明示的に false のときだけ抑止する
const isEnabled = () => getSettings("ifNotifyOnRestoreAndSweep") !== false;

const notify = async (id, title, message) => {
  if (!isEnabled()) return;
  try {
    await browser.notifications.create(`tsm-${id}-${Date.now()}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon.png"),
      title: title,
      message: message
    });
  } catch (e) {
    log.warn(logDir, "notify() failed", e?.message || String(e));
  }
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const seconds = ms => {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 90) return `${total} s`;
  return `${Math.floor(total / 60)} min ${total % 60} s`;
};
const withName = (name, text) => (name ? `"${name}" — ${text}` : text);

export const notifyRestoreFinished = ({ name, windows, tabs, elapsedMs }) =>
  notify(
    "restore-finished",
    "Session restored",
    withName(name, `${plural(windows, "window")}, ${plural(tabs, "tab")} in ${seconds(elapsedMs)}.`)
  );

export const notifyRestoreFailed = ({ name, error }) =>
  notify("restore-failed", "Session restore failed", withName(name, String(error || "unknown error")));

export const notifySweepFinished = ({
  windows,
  processed,
  captured,
  cachedSkips,
  stopped,
  elapsedMs
}) =>
  notify(
    "sweep-finished",
    stopped ? "Sweep stopped" : "Sweep finished",
    `${plural(processed, "tab")} across ${plural(windows, "window")} in ${seconds(elapsedMs)} — ` +
      `${plural(captured, "new thumbnail")}, ${cachedSkips} already cached.`
  );

export const notifySweepNothingToDo = ({ windows }) =>
  notify(
    "sweep-nothing",
    "Nothing to sweep",
    `${plural(windows, "window")} checked — no unloaded tabs to preload (or thumbnail capture is off for private windows).`
  );
