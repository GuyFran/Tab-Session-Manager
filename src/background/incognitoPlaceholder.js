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
  // URLの可読性のため<title>を先頭に置く(アドレスバーには
  // 「data:text/html;charset=utf-8,<title>ページ名 · hibernated</title>…」と表示される)。
  // CSSの色は#hex表記を使わない: 本文中の「#」はフラグメント区切りとして%23に
  // エスケープする必要があり、rgb()なら本文がそのまま読める
  const html =
    "<title>" +
    safeTitle +
    " · hibernated</title>" +
    icon +
    "<style>html,body{margin:0;height:100%;background:rgb(29,29,36);color:rgb(227,230,236);font:14px system-ui,sans-serif}" +
    ".w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;box-sizing:border-box}" +
    "img{width:min(94%,1400px);max-height:76%;object-fit:contain;border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55);cursor:pointer}" +
    "h2{margin:0;font-weight:500;max-width:88%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "button{font:15px system-ui,sans-serif;padding:10px 26px;border:0;border-radius:8px;background:rgb(13,148,136);color:rgb(255,255,255);cursor:pointer}" +
    "button:hover{background:rgb(15,118,110)}" +
    "p{margin:0;opacity:.5;font-size:12px}</style>" +
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
    "ipt>";

  // 最小限のエスケープ(%→%25を先に、#→%23)。encodeURIComponentで全体を
  // 潰すとアドレスバーが%だらけの巨大な文字列になる(ユーザ報告)。
  // data:URLのパス部でエンコード必須なのは実質この2文字だけで、残りは
  // そのまま読める形で保持される(実測 2026-08-29: 生成→tab.url読み戻し→
  // 描画→discard→フラグメント解析まで往復確認)
  const body = html.replace(/%/g, "%25").replace(/#/g, "%23");

  let fragment = MARKER + encodeURIComponent(url) + "&t=" + encodeURIComponent(title || "");
  // faviconはhttp(s)のもののみフラグメントで保持する(data URIは大きすぎる)
  if (favIconUrl && /^https?:/.test(favIconUrl) && favIconUrl.length <= MAX_FAVICON_URL_LENGTH) {
    fragment += "&f=" + encodeURIComponent(favIconUrl);
  }
  return PREFIX + ";charset=utf-8," + body + fragment;
};
