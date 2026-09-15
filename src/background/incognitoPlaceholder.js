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
// 本文に埋め込むdata:形式のfaviconの上限(16〜32pxのPNGは1〜4KB程度)
const MAX_FAVICON_DATA_URL_LENGTH = 4096;

// Chromeは各タブのナビゲーションをセッションファイルに1件あたり最大約63KB
// (コマンド長がuint16、そこから1024を引いた値)で書き出し、収まらないURLは空文字で
// 保存する(sessions/core/session_service_commands.cc: CreateUpdateTabNavigationCommand
// → SerializedNavigationEntry::WriteToPickle → WriteStringToPickle)。上限を超えた
// placeholderはChrome再起動後(「前回開いていたページを開く」・最近閉じたタブ)に
// 空白タブとして戻ってくる(PH-01)。URL全体を60KB未満に抑える
export const MAX_PLACEHOLDER_URL_BYTES = 60 * 1000;
// URLに埋め込むサムネイル(JPEGバイト)の上限。base64で4/3倍(48,000文字)になり、
// 残りの約12KBをHTML本体・タイトル×2・実URL・faviconに充てる。thumbnails.jsは
// この上限に収まるようにキャプチャを圧縮する
export const MAX_PLACEHOLDER_THUMBNAIL_BYTES = 36 * 1000;
// タイトルは本文とフラグメントの2箇所に入る。非ASCII文字はChromeの正規化で
// 1バイトあたり3文字(%XX)に膨らむため、長さを抑える
const MAX_TITLE_LENGTH = 200;
const SHORT_TITLE_LENGTH = 60;

const escapeHtml = value =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const truncate = (value, maxLength) =>
  value.length > maxLength ? value.slice(0, maxLength - 1) + "…" : value;

// GURLはdata:URLのパスとフラグメント中の非ASCII文字(と制御文字)をUTF-8の%XXに
// 正規化する(url/url_canon_pathurl.cc: 0x20未満・0x80以上をエスケープ)。Chromeの
// セッションファイルに書かれ、tab.urlとして返るのもその正規化後のspecなので、
// サイズはその長さで数える: ASCIIは1文字、非ASCIIはUTF-8バイト数×3
export const specByteLength = str => {
  let length = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2 * 3;
    else if (code < 0x10000) length += 3 * 3;
    else {
      length += 4 * 3;
      i++; // サロゲートペア
    }
  }
  return length;
};

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

const assemble = ({ url, title, favIconUrl, thumbDataUrl }) => {
  const safeTitle = escapeHtml(title);
  const img = thumbDataUrl ? '<img src="' + thumbDataUrl + '" alt="">' : "";
  const icon =
    favIconUrl &&
    favIconUrl.startsWith("data:image/") &&
    favIconUrl.length <= MAX_FAVICON_DATA_URL_LENGTH
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
    // サムネイルはビューポートほぼ全面(下部の細いバーを除く)に表示する。
    // 画像なしの場合はバーだけが中央に来る(justify-content:center)
    "<style>html,body{margin:0;height:100%;background:rgb(29,29,36);color:rgb(227,230,236);font:14px system-ui,sans-serif}" +
    ".w{height:100%;display:flex;flex-direction:column;justify-content:center}" +
    "img{flex:1 1 auto;min-height:0;width:100%;object-fit:contain;cursor:pointer;background:rgb(22,22,28)}" +
    ".b{display:flex;align-items:center;gap:14px;padding:10px 16px}" +
    "h2{flex:1;margin:0;font-weight:500;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "button{font:15px system-ui,sans-serif;padding:9px 24px;border:0;border-radius:8px;background:rgb(13,148,136);color:rgb(255,255,255);cursor:pointer;white-space:nowrap}" +
    "button:hover{background:rgb(15,118,110)}" +
    "p{margin:0;opacity:.5;font-size:12px;white-space:nowrap}</style>" +
    '<body><div class="w">' +
    img +
    '<div class="b"><h2>' +
    safeTitle +
    "</h2><p>Hibernated — click the image to load</p><button>Open page</button></div></div>" +
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

  let fragment = MARKER + encodeURIComponent(url) + "&t=" + encodeURIComponent(title);
  // faviconはhttp(s)のもののみフラグメントで保持する(data URIは大きすぎる)
  if (favIconUrl && /^https?:/.test(favIconUrl) && favIconUrl.length <= MAX_FAVICON_URL_LENGTH) {
    fragment += "&f=" + encodeURIComponent(favIconUrl);
  }
  return PREFIX + ";charset=utf-8," + body + fragment;
};

// URL全体がMAX_PLACEHOLDER_URL_BYTESに収まるまで、影響の小さい順に要素を落とす:
// favicon → サムネイル → タイトルの短縮。実URLとタイトルは復元に必須なので最後まで残す。
// 戻り値: { url, bytes, fits, thumbnailDropped, faviconDropped, titleShortened }
export const buildIncognitoPlaceholder = ({ url, title, favIconUrl = "", thumbDataUrl = "" }) => {
  const fullTitle = truncate(String(title || url || ""), MAX_TITLE_LENGTH);
  const thumb = thumbDataUrl && thumbDataUrl.startsWith("data:image/") ? thumbDataUrl : "";
  const attempts = [
    { title: fullTitle, thumbDataUrl: thumb, favIconUrl },
    { title: fullTitle, thumbDataUrl: thumb, favIconUrl: "" },
    { title: fullTitle, thumbDataUrl: "", favIconUrl: "" },
    { title: truncate(fullTitle, SHORT_TITLE_LENGTH), thumbDataUrl: "", favIconUrl: "" }
  ];
  let result = null;
  for (const attempt of attempts) {
    const placeholderUrl = assemble({ url, ...attempt });
    const bytes = specByteLength(placeholderUrl);
    result = {
      url: placeholderUrl,
      bytes,
      fits: bytes <= MAX_PLACEHOLDER_URL_BYTES,
      thumbnailDropped: !!thumb && !attempt.thumbDataUrl,
      faviconDropped: !!favIconUrl && !attempt.favIconUrl,
      titleShortened: attempt.title !== fullTitle
    };
    if (result.fits) break;
  }
  return result;
};

export const buildIncognitoPlaceholderUrl = params => buildIncognitoPlaceholder(params).url;
