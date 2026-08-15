import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";

const logDir = "background/thumbnails";

const DB_NAME = "thumbnails";
const STORE_NAME = "thumbnails";
const MAX_THUMBNAILS = 3000;
const PRUNE_CHUNK = 100;
const CAPTURE_WIDTH = 500;
const MIN_CAPTURE_INTERVAL_MS = 10 * 1000;
const CAPTURE_DELAY_MS = 500;

let DB;
const openDB = () => {
  if (DB) return Promise.resolve(DB);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "url" });
      store.createIndex("date", "date");
    };
    request.onsuccess = () => {
      DB = request.result;
      resolve(DB);
    };
    request.onerror = e => {
      log.error(logDir, "openDB()", e);
      reject(e);
    };
  });
};

const putThumbnail = async (url, blob) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put({ url: url, blob: blob, date: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror = e => reject(e);
  });
};

// 上限を超えたら古いサムネイルから削除する
const pruneThumbnails = async () => {
  const db = await openDB();
  const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    let overCount = countRequest.result - MAX_THUMBNAILS;
    if (overCount <= 0) return;
    overCount += PRUNE_CHUNK;
    const cursorRequest = store.index("date").openCursor(null, "next");
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || overCount <= 0) return;
      cursor.delete();
      overCount--;
      cursor.continue();
    };
  };
};

const isCapturableUrl = url => /^https?:\/\//.test(url || "");

// captureVisibleTabはjpegのdataUrlを返すので、保存前に縮小してBlob化する
const downscale = async dataUrl => {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, CAPTURE_WIDTH / bitmap.width);
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale))
  );
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
};

// ServiceWorker再起動でリセットされるが、スロットリング用途なので問題ない
let lastCaptureTimes = {};

export const captureActiveTab = async windowId => {
  try {
    if (!getSettings("ifCaptureThumbnails")) return;
    const [tab] = await browser.tabs.query({ active: true, windowId: windowId });
    if (!tab || !isCapturableUrl(tab.url) || tab.status !== "complete") return;
    // プライベートウィンドウのページは、プライベートウィンドウを保存する設定が有効な場合のみ保存する
    if (tab.incognito && !getSettings("ifSavePrivateWindow")) return;

    const lastCaptureTime = lastCaptureTimes[tab.url] || 0;
    if (Date.now() - lastCaptureTime < MIN_CAPTURE_INTERVAL_MS) return;
    lastCaptureTimes[tab.url] = Date.now();

    // 保護されたページ等ではエラーになるのでcatchで無視する
    const dataUrl = await browser.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 70
    });
    const thumbnail = await downscale(dataUrl);
    await putThumbnail(tab.url, thumbnail);
    log.log(logDir, "captureActiveTab()", tab.url, thumbnail.size);
    pruneThumbnails();
  } catch (e) {
    log.log(logDir, "captureActiveTab() skipped", e?.message);
  }
};

export const handleThumbnailTabUpdated = (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  // 描画完了を待ってからキャプチャする
  setTimeout(() => captureActiveTab(tab.windowId), CAPTURE_DELAY_MS);
};

export const handleThumbnailTabActivated = activeInfo => {
  setTimeout(() => captureActiveTab(activeInfo.windowId), CAPTURE_DELAY_MS);
};
