/* 営農日報 Service Worker
 * ねらい: ①ホーム画面アプリとして成立させる ②画面の枠（HTML/CSS/JS/アイコン）を
 * キャッシュし、圏外や起動直後でも画面を素早く表示する。
 * 日報データそのものは常にサーバー(API)から取るため、ここではキャッシュしない。 */

const CACHE = "nippo-shell-v4";
const SHELL = [
  "./",
  "./index.html",
  "./help.html",
  "./tokens.css",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // APIは常にネットワーク（データは最新をサーバーから取得）
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // 画面の枠は「ネットワーク優先」: オンラインなら常に最新版を表示し、
  // 取得できたものを控えておく。圏外のときだけ控えから表示する。
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then((hit) => hit || caches.match("./index.html"))
    )
  );
});
