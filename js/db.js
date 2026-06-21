/* =====================================================================
 * db.js  —  IndexedDB ローカルストレージ層
 *  - tiles : オフライン地図タイル画像（Blob）           key = "z/x/y"
 *  - memos : 現場メモ（緯度経度・時刻・本文）            key = autoIncrement
 *  サーバー通信は一切行わない。すべて端末内に完結する。
 * ===================================================================== */
const DB = (() => {
  const NAME = 'satoyama-db';
  const VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tiles')) {
          db.createObjectStore('tiles'); // key を明示指定（"z/x/y"）
        }
        if (!db.objectStoreNames.contains('memos')) {
          const s = db.createObjectStore('memos', { keyPath: 'id', autoIncrement: true });
          s.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  /* ---------- タイル ---------- */
  async function putTile(key, blob) {
    const store = await tx('tiles', 'readwrite');
    return new Promise((res, rej) => {
      const r = store.put(blob, key);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    });
  }
  async function getTile(key) {
    const store = await tx('tiles', 'readonly');
    return new Promise((res, rej) => {
      const r = store.get(key);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  }
  async function hasTile(key) {
    const store = await tx('tiles', 'readonly');
    return new Promise((res, rej) => {
      const r = store.getKey(key);
      r.onsuccess = () => res(r.result !== undefined); r.onerror = () => rej(r.error);
    });
  }
  async function countTiles() {
    const store = await tx('tiles', 'readonly');
    return new Promise((res, rej) => {
      const r = store.count();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function clearTiles() {
    const store = await tx('tiles', 'readwrite');
    return new Promise((res, rej) => {
      const r = store.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    });
  }

  /* ---------- メモ ---------- */
  async function addMemo(memo) {
    const store = await tx('memos', 'readwrite');
    return new Promise((res, rej) => {
      const r = store.add(memo);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function allMemos() {
    const store = await tx('memos', 'readonly');
    return new Promise((res, rej) => {
      const r = store.getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => b.createdAt - a.createdAt));
      r.onerror = () => rej(r.error);
    });
  }
  async function deleteMemo(id) {
    const store = await tx('memos', 'readwrite');
    return new Promise((res, rej) => {
      const r = store.delete(id);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    });
  }

  /* ---------- 使用容量の推定 ---------- */
  async function estimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch (_) {}
    }
    return { usage: 0, quota: 0 };
  }

  return {
    putTile, getTile, hasTile, countTiles, clearTiles,
    addMemo, allMemos, deleteMemo, estimate,
  };
})();
