import browser from "webextension-polyfill";
import "./replaced.scss";

const sanitaize = {
  encode: str => {
    str = str || "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },
  decode: str => {
    str = str || "";
    return str
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
};

let parameter = returnReplaceParameter(location.href);

document.title = parameter.title;
document.getElementsByClassName("title")[0].innerText = parameter.title;
document.getElementsByClassName("replacedUrl")[0].value = parameter.url;
if (parameter.favIconUrl === "" || parameter.favIconUrl === "undefined") {
  parameter.favIconUrl = "../icons/nofavicon.png";
}
document.head.insertAdjacentHTML(
  "beforeend",
  `<link rel="shortcut icon" href="${sanitaize.encode(parameter.favIconUrl)}">`
);
const theme = ["light", "dark", "system"].includes(parameter.theme)
  ? parameter.theme
  : "light";
document.body.classList.add(theme + "-theme");

const copy = () => {
  const url = document.querySelector(".replacedUrl");
  url.select();
  document.execCommand("Copy");
  document.querySelector(".copyButton").innerText = browser.i18n.getMessage("copiedLabel");
};

document.querySelector(".copyButton").onclick = copy;
document.querySelector(".copyButton").innerText = browser.i18n.getMessage("copyUrlLabel");

if (parameter.state == "open_faild") {
  document.getElementsByClassName("replacedPageMessage")[0].innerText =
    browser.i18n.getMessage("replacedPageMessage");
}

// backgroundが保存したページのサムネイルがあれば表示する
// 拡張機能ページはbackgroundと同一オリジンなので、同じIndexedDBを直接参照できる
const showThumbnail = () => {
  if (!/^https?:\/\//.test(parameter.url || "")) return;
  const request = indexedDB.open("thumbnails", 1);
  request.onupgradeneeded = () => {
    // backgroundのthumbnails.jsとスキーマを一致させる
    // 復元直後は多数のplaceholderが同時に開くため、二重作成を防ぐ
    if (request.result.objectStoreNames.contains("thumbnails")) return;
    const store = request.result.createObjectStore("thumbnails", { keyPath: "url" });
    store.createIndex("date", "date");
  };
  request.onsuccess = () => {
    try {
      // storeが未作成のことがある。読み取り専用なので、無ければ何も表示しない
      if (!request.result.objectStoreNames.contains("thumbnails")) return;
      const getRequest = request.result
        .transaction("thumbnails")
        .objectStore("thumbnails")
        .get(parameter.url);
      getRequest.onsuccess = () => {
        if (!getRequest.result?.blob) return;
        const img = document.querySelector(".thumbnail");
        img.src = URL.createObjectURL(getRequest.result.blob);
        img.classList.add("visible");
      };
    } catch (e) {}
  };
};
showThumbnail();

function returnReplaceParameter(url) {
  let parameter = {};
  let paras = url.split("?")[1].split("&");
  for (let p of paras) {
    parameter[p.split("=")[0]] = decodeURIComponent(p.split("=")[1]);
  }
  return parameter;
}
