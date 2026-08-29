// Chromeのincognito("incognito": "spanning")では拡張機能ページを表示できない
// (実測 2026-08-29: chrome-extension://のURLへ遷移させるとエラーページが描画される)。
// そのためincognitoタブのプレースホルダは自己完結のdata:URLページで代替する。
// - サムネイルはJPEGのdata URIとしてページ本体に埋め込む
// - 実URL・タイトル・faviconはフラグメント(#tsm=...)に保持し、セッション保存時に
//   タブのURLから読み戻して復元する(フラグメントはdiscardを跨いで保持される: 実測)
// - ページ内スクリプトが表示された瞬間に実URLへ遷移する(通常ウィンドウの
//   placeholderのlazy-loading挙動と同じ)
// 注意: tabs.update()はdata:URLへの遷移を黙って無視するが、tabs.create()は受け付ける
// (実測 2026-08-29)。差し替えは「新規作成→旧タブ削除」で行うこと。

const PREFIX = "data:text/html";
const MARKER = "#tsm=";
const MAX_FAVICON_URL_LENGTH = 2048;

const escapeHtml = value =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const isIncognitoPlaceholderUrl = url =>
  typeof url === "string" && url.startsWith(PREFIX) && url.includes(MARKER);

// data:プレースホルダのURLから実URL・タイトル・faviconを読み戻す
export const returnIncognitoPlaceholderParameter = url => {
  if (!isIncognitoPlaceholderUrl(url)) return { isIncognitoPlaceholder: false };
  const fragment = url.slice(url.indexOf(MARKER) + 1);
  const parameter = {};
  for (const pair of fragment.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    try {
      parameter[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    } catch (e) {}
  }
  return {
    isIncognitoPlaceholder: true,
    url: parameter.tsm || "",
    title: parameter.t || "",
    favIconUrl: parameter.f || ""
  };
};

export const buildIncognitoPlaceholderUrl = ({ url, title, favIconUrl = "", thumbDataUrl = "" }) => {
  const safeTitle = escapeHtml(title || url);
  const img =
    thumbDataUrl && thumbDataUrl.startsWith("data:image/")
      ? '<img src="' + thumbDataUrl + '" alt="">'
      : "";
  const icon =
    favIconUrl && favIconUrl.startsWith("data:image/")
      ? '<link rel="icon" href="' + favIconUrl + '">'
      : "";
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    safeTitle +
    "</title>" +
    icon +
    "<style>html,body{margin:0;height:100%;background:#1d1d24;color:#e3e6ec;font:14px system-ui,sans-serif}" +
    ".w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;box-sizing:border-box}" +
    "img{width:min(94%,1400px);max-height:76%;object-fit:contain;border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55);cursor:pointer}" +
    "h2{margin:0;font-weight:500;max-width:88%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "button{font:15px system-ui,sans-serif;padding:10px 26px;border:0;border-radius:8px;background:#0d9488;color:#fff;cursor:pointer}" +
    "button:hover{background:#0f766e}" +
    "p{margin:0;opacity:.5;font-size:12px}</style></head>" +
    '<body><div class="w">' +
    img +
    "<h2>" +
    safeTitle +
    "</h2><button>Open page</button><p>Hibernated — click the button or the image to load</p></div>" +
    // 自動では遷移しない(ユーザ要望)。ボタンかサムネイルのクリック、またはEnterで
    // 実URLへ遷移する
    "<scr" +
    "ipt>(function(){var go=function(){var m=location.hash.match(/tsm=([^&]+)/);if(m)location.replace(decodeURIComponent(m[1]))};" +
    'document.querySelector("button").addEventListener("click",go);' +
    'var i=document.querySelector("img");if(i)i.addEventListener("click",go);' +
    'document.addEventListener("keydown",function(e){if(e.key==="Enter")go()})})();</scr' +
    "ipt></body></html>";

  let fragment = MARKER + encodeURIComponent(url) + "&t=" + encodeURIComponent(title || "");
  // faviconはhttp(s)のもののみフラグメントで保持する(data URIは大きすぎる)
  if (favIconUrl && /^https?:/.test(favIconUrl) && favIconUrl.length <= MAX_FAVICON_URL_LENGTH) {
    fragment += "&f=" + encodeURIComponent(favIconUrl);
  }
  return PREFIX + ";charset=utf-8," + encodeURIComponent(html) + fragment;
};
