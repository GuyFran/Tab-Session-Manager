import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";
import { addSweepDebugEvent } from "./restoreDebug";

const logDir = "background/thumbnails";

const DB_NAME = "thumbnails";
const STORE_NAME = "thumbnails";
const MAX_THUMBNAILS = 3000;
const PRUNE_CHUNK = 100;
// v7.4.32: 500→920、v7.4.34: 920→1600。placeholderでビューポートほぼ全面に
// 表示するため、大画面でもぼやけない幅で保存する
const CAPTURE_WIDTH = 1600;
const MIN_CAPTURE_INTERVAL_MS = 10 * 1000;
const CAPTURE_DELAY_MS = 500;

// 同じDBはreplacedページ(placeholder)からも開かれる。復元直後は多数のplaceholderが
// 同時に開くため、こちらのonupgradeneededが走らないままDBだけが作られ、
// objectStoreが存在しない接続を掴んでしまうことがある。その接続をキャッシュすると
// 以降のputが必ず "object stores was not found" で失敗し続けるので、
// storeの有無を確認し、無ければversionを上げて作り直す
const ensureStore = db => {
  if (db.objectStoreNames.contains(STORE_NAME)) return;
  const store = db.createObjectStore(STORE_NAME, { keyPath: "url" });
  store.createIndex("date", "date");
};

// versionアップグレードは他の接続(placeholderページ等)が全て閉じるまでblockedになり得る。
// 永久に待つとawait先(captureActiveTab経由のスウィープ)が固まるため、上限を設けて
// rejectする。呼び出し側は失敗を握り潰してサムネイル無しで続行する
const OPEN_DB_TIMEOUT_MS = 10 * 1000;

const adoptDB = db => {
  // 将来のversionアップグレードをこの接続がblockしないようにする
  db.onversionchange = () => {
    db.close();
    if (DB === db) DB = null;
  };
  DB = db;
  return db;
};

let DB;
const openDB = () => {
  if (DB && DB.objectStoreNames.contains(STORE_NAME)) return Promise.resolve(DB);
  DB = null;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`openDB() timed out after ${OPEN_DB_TIMEOUT_MS}ms (upgrade blocked?)`));
    }, OPEN_DB_TIMEOUT_MS);
    const settle = (fn, value) => {
      clearTimeout(timeout);
      fn(value);
    };
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => ensureStore(request.result);
    request.onsuccess = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        return settle(resolve, adoptDB(db));
      }
      // storeが無いDBが既に存在する: versionを上げて明示的に作成する
      log.warn(logDir, "openDB() store missing, upgrading", db.version);
      const nextVersion = db.version + 1;
      db.close();
      const upgrade = indexedDB.open(DB_NAME, nextVersion);
      upgrade.onupgradeneeded = () => ensureStore(upgrade.result);
      upgrade.onsuccess = () => settle(resolve, adoptDB(upgrade.result));
      upgrade.onerror = e => {
        log.error(logDir, "openDB() upgrade", e);
        settle(reject, e);
      };
      upgrade.onblocked = () => log.warn(logDir, "openDB() upgrade blocked");
    };
    request.onerror = e => {
      log.error(logDir, "openDB()", e);
      settle(reject, e);
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

// キャプチャの成否と理由の軽量トレース(直近200件)。デバッグ時にSWコンソールで
// globalThis.__thumbLog を見る。URLは一切載せない(tabId・理由・サイズのみ)。
// 同じ内容をデバッグパネル(restoreDebug)にも流す
const traceCapture = (entry, debugEvent, debugDetails) => {
  try {
    const buf = (globalThis.__thumbLog = globalThis.__thumbLog || []);
    buf.push(`${new Date().toISOString().slice(11, 23)} ${entry}`);
    if (buf.length > 200) buf.shift();
  } catch (e) {}
  if (debugEvent) addSweepDebugEvent(debugEvent, debugDetails);
};

// ChromeはcaptureVisibleTab()を「2回/秒」に制限している
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)。スウィープはキャッシュ済みページを
// 600ms間隔程度で処理し、さらに受動パス(onActivated/onUpdated)が同じタブに重複発火
// するため、無対策では割当を超えた瞬間のタブのサムネイルだけが欠落する(実測)。
// 全キャプチャを直列キューに通し、呼び出し間隔を空けて割当超過を構造的に防ぐ
const CAPTURE_SPACING_MS = 600;
// captureVisibleTab()は失敗をrejectで返すとは限らず、描画フレームの無い
// ウィンドウ(discardされたタブがアクティブ等)では永久に未解決のまま残ることがある
// (実測)。キューは直列なので、1回のハングが全ウィンドウの以後のキャプチャを
// 巻き込んで固める。必ずタイムアウトを付ける
const CAPTURE_CALL_TIMEOUT_MS = 5000;
export const captureVisibleTabWithTimeout = (windowId, options) =>
  Promise.race([
    browser.tabs.captureVisibleTab(windowId, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("captureVisibleTab timed out")), CAPTURE_CALL_TIMEOUT_MS)
    )
  ]);

let captureQueue = Promise.resolve();
let lastCaptureCallAt = 0;
const enqueueCapture = task => {
  const run = captureQueue.then(async () => {
    const wait = lastCaptureCallAt + CAPTURE_SPACING_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    return await task();
  });
  // 失敗してもキューを止めない
  captureQueue = run.catch(() => {});
  return run;
};

export const captureActiveTab = async (windowId, { fromSweep = false } = {}) => {
  let capturedTab = null;
  try {
    if (!getSettings("ifCaptureThumbnails")) return;
    const [tab] = await browser.tabs.query({ active: true, windowId: windowId });
    capturedTab = tab;
    if (!tab || !isCapturableUrl(tab.url) || tab.status !== "complete") {
      traceCapture(`skip pre-check w=${windowId} tab=${tab?.id} sweep=${fromSweep} status=${tab?.status}`, "thumb-skip", { reason: "pre-check", windowId, tabId: tab?.id, status: tab?.status, fromSweep });
      return;
    }
    // 受動キャプチャ: プライベート保存設定がオフならスキップ
    // スウィープ経由: 復元済みタブなのでifSavePrivateWindowに関係なくキャプチャする
    if (tab.incognito && !fromSweep && !getSettings("ifSavePrivateWindow")) {
      traceCapture(`skip private-gate tab=${tab.id}`, "thumb-skip", {
        reason: "private-gate-ifSavePrivateWindow-off",
        tabId: tab.id,
        fromSweep
      });
      return;
    }

    if (Date.now() - (lastCaptureTimes[tab.url] || 0) < MIN_CAPTURE_INTERVAL_MS) {
      traceCapture(`skip rate-limit tab=${tab.id}`, "thumb-skip", { reason: "rate-limit", tabId: tab.id, fromSweep });
      return;
    }

    await enqueueCapture(async () => {
      // キュー待機中に重複呼び出し(スウィープ+受動パス)が先に保存していたら降りる
      if (Date.now() - (lastCaptureTimes[tab.url] || 0) < MIN_CAPTURE_INTERVAL_MS) {
        traceCapture(`skip rate-limit(queued) tab=${tab.id}`, "thumb-skip", { reason: "rate-limit-queued", tabId: tab.id, fromSweep });
        return;
      }
      lastCaptureCallAt = Date.now();
      // 保護されたページ等ではエラーになるのでcatchで無視する
      const dataUrl = await captureVisibleTabWithTimeout(windowId, {
        format: "jpeg",
        quality: 70
      });
      const thumbnail = await downscale(dataUrl);
      await putThumbnail(tab.url, thumbnail);
      // 成功時のみレート制限を記録する。失敗(フォーカス遷移中の一時的な
      // "view is invisible"等)の前に記録すると、直後の正当な再試行まで10秒間
      // ブロックされ、そのタブのサムネイルだけ欠落する
      lastCaptureTimes[tab.url] = Date.now();
      traceCapture(`stored tab=${tab.id} bytes=${thumbnail.size} sweep=${fromSweep}`, "thumb-stored", { tabId: tab.id, bytes: thumbnail.size, fromSweep });
      log.log(logDir, "captureActiveTab()", tab.url, thumbnail.size);
      pruneThumbnails();
    });
  } catch (e) {
    traceCapture(`FAILED w=${windowId} sweep=${fromSweep} err=${e?.message}`, "thumb-failed", {
      windowId,
      fromSweep,
      error: e?.message || String(e),
      index: capturedTab?.index
    });
    log.log(logDir, "captureActiveTab() skipped", e?.message);
  }
};

// 保存済みサムネイルをdata URIで返す(無ければ空文字)。incognitoのdata:URL
// プレースホルダに埋め込むために使う
export const getThumbnailDataUrl = async url => {
  try {
    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(url);
      request.onsuccess = () => resolve(request.result);
      request.onerror = e => reject(e);
    });
    if (!record || !record.blob) return "";
    const buffer = new Uint8Array(await record.blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 8192) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    }
    return "data:image/jpeg;base64," + btoa(binary);
  } catch (e) {
    return "";
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
