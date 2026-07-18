/* =====================================================================
 * sw.js  —  Service Worker（アプリ本体のオフラインキャッシュ）
 *  ・アプリシェル（HTML/CSS/JS/ライブラリ/アイコン）を precache
 *  ・地図タイルは IndexedDB 側で管理するため、ここではキャッシュしない
 * ===================================================================== */
const CACHE = 'satoyama-shell-v3';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/tilelayer.js',
  './js/app.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/images/marker-shadow.png',
  './vendor/images/layers.png',
  './manifest.webmanifest',
  './version.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './data/parcels/index.json',
  // 個別の地番ファイル(data/parcels/*.geojson)は数が多いため事前キャッシュせず、
  // 一度オンラインで表示した範囲のものを fetch ハンドラが自動キャッシュする。
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // 一部ファイル（地番データ等）が無くてもインストールを失敗させない
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // 地図タイルは SW でキャッシュしない（IndexedDB が担当）。ネットへ素通し。
  if (url.hostname.includes('cyberjapandata.gsi.go.jp')) return;

  if (url.origin !== self.location.origin) return;

  // 地番データ（data/parcels/*.geojson）: キャッシュ優先。
  // 一度オンラインで表示した範囲を自動キャッシュし、以後はオフラインでも即返す。
  if (/\/data\/parcels\/.+\.geojson$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
      )
    );
    return;
  }

  // アプリシェル（app.js / index.html / index.json 等）:
  // stale-while-revalidate。キャッシュを即返しつつ裏でネット取得して更新する。
  // → cache-first による「更新しても古いコードが配信され続ける」固定化を解消。
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(e.request).then((hit) => {
        const fetching = fetch(e.request).then((res) => {
          c.put(e.request, res.clone()).catch(() => {});
          return res;
        }).catch(() => hit || caches.match('./index.html'));
        // キャッシュがあれば即返し、fetching は裏で走らせて次回に反映。
        // キャッシュが無ければネット取得を待つ。
        return hit || fetching;
      })
    )
  );
});
