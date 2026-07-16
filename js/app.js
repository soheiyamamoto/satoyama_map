/* =====================================================================
 * app.js  —  里山調査用オフライン地図 メインロジック
 * ===================================================================== */
(() => {
  'use strict';

  // ---- 設定値 ----
  const GSI_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
  const GSI_ATTR = '地理院タイル（国土地理院）';
  const SAVE_ZOOMS = [15, 16, 17, 18];   // 一括保存するズームレベル
  const MAX_TILES = 600;                  // 過負荷防止：1回の保存上限枚数
  const WARN_TILES = 450;                 // 警告ライン
  const DEFAULT_CENTER = [32.92978, 131.87028]; // 初期表示（佐伯市中心部・地番データに合わせる）
  const DEFAULT_ZOOM = 16;

  // ---- 状態 ----
  let map, baseLayer, parcelLayer, meMarker, meAccuracy, parcelRenderer;
  let following = false;
  let watchId = null;
  const memoMarkers = new Map();
  let saving = false;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const netStatus = $('net-status');
  const gpsStatus = $('gps-status');
  const finder = $('finder');
  const toastEl = $('toast');

  // =====================================================================
  // 初期化
  // =====================================================================
  function init() {
    map = L.map('map', {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: true,
      tap: true,
      maxZoom: 21,
      minZoom: 5,
    });
    L.control.zoom({ position: 'topleft' }).addTo(map);

    parcelRenderer = L.canvas({ padding: 0.5 });

    baseLayer = offlineTileLayer(GSI_URL, {
      attribution: GSI_ATTR,
      maxNativeZoom: 18,
      maxZoom: 21,
    }).addTo(map);

    loadParcelLayer();   // 地番レイヤー（あれば）
    restoreLastView();   // 前回表示位置の復元
    bindUI();

    // 開発確認用: localhost のときだけ map をデバッグ公開（本番では無効）
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      window._map = map;
      window._parcelTiles = parcelTiles;
    }
    setupNetworkStatus();
    startGPS();
    renderMemoMarkers();

    // 地図移動時に保存範囲の見積りを更新
    map.on('moveend zoomend', () => {
      saveLastView();
      if (!$('finder').classList.contains('hidden')) updateFinderInfo();
    });
    // ユーザーが地図をドラッグしたら追従を解除
    map.on('dragstart', () => setFollowing(false));
  }

  // =====================================================================
  // 地番レイヤー（事前にGeoJSONへ変換したデータを読み込む）
  //   data/parcels/index.json の有無・形式で3通りに対応する:
  //    (A) ondemand方式 : {mode:"ondemand", minZoom, files:[{file,bbox}]}
  //          → 地図の表示範囲に重なるファイルだけを都度読み込む（大容量向け）
  //    (B) 一括方式      : {files:["a.geojson", ...]}  → 全ファイルを読み込む
  //    (C) 単一ファイル  : index.json 無し → data/parcels.geojson を読む（後方互換）
  // =====================================================================
  const PARCEL_STYLE = { color: '#d84315', weight: 1.0, fillColor: '#ff7043', fillOpacity: 0.06 };
  const PARCEL_DIR = 'data/parcels/';

  // ondemand用の状態
  const parcelTiles = new Map();   // file名 -> { layer, bbox } 読込済みの管理
  let parcelIndex = null;          // index.json の中身（ondemand時）
  let parcelMinZoom = 15;

  function parcelTooltip(f, layer) {
    const p = f.properties || {};
    const label = p.chiban || p.地番 || p.筆ID || '';
    if (label) {
      layer.bindTooltip(String(label), {
        permanent: false, direction: 'center', className: 'parcel-label',
      });
    }
  }

  function makeParcelLayer() {
    return L.geoJSON(null, { style: PARCEL_STYLE, onEachFeature: parcelTooltip, renderer: parcelRenderer });
  }

  function loadParcelLayer() {
    parcelLayer = makeParcelLayer().addTo(map);   // ベースのレイヤーグループ
    fetch(PARCEL_DIR + 'index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((idx) => {
        if (idx && idx.mode === 'ondemand' && Array.isArray(idx.files)) {
          // (A) オンデマンド方式
          parcelIndex = idx;
          parcelMinZoom = idx.minZoom || 15;

          // [1] 表示が変わるたびに更新。move も購読して発火漏れに備える（[4]）。
          map.on('moveend zoomend', updateParcelTiles);
          map.on('move', scheduleParcelUpdate);   // デバウンス経由

          // [1] bounds が確定してから初回実行（初期取りこぼし対策）
          map.whenReady(() => updateParcelTiles());
        } else if (idx && Array.isArray(idx.files) && idx.files.length) {
          // (B) 一括方式（文字列配列）
          loadParcelFilesInto(parcelLayer, idx.files.map((f) => PARCEL_DIR + f));
        } else {
          // (C) 単一ファイル（後方互換）
          loadParcelFilesInto(parcelLayer, ['data/parcels.geojson']);
        }
      })
      .catch(() => loadParcelFilesInto(parcelLayer, ['data/parcels.geojson']));
  }

  // bbox=[w,s,e,n] と Leaflet の bounds が交差するか
  function bboxIntersects(bbox, bounds) {
    return !(bbox[2] < bounds.getWest() || bbox[0] > bounds.getEast() ||
             bbox[3] < bounds.getSouth() || bbox[1] > bounds.getNorth());
  }

  // [4] move連発を間引くデバウンス（120ms）。過剰fetchを防ぐ。
  let _parcelUpdateTimer = null;
  function scheduleParcelUpdate() {
    if (_parcelUpdateTimer) return;
    _parcelUpdateTimer = setTimeout(() => {
      _parcelUpdateTimer = null;
      updateParcelTiles();
    }, 120);
  }

  // [5] 空ジオメトリ・空featureを除外して "M0 0" パスの生成を防ぐ
  function hasUsableGeometry(feature) {
    const g = feature && feature.geometry;
    if (!g || !g.coordinates) return false;
    // 座標配列を平坦化して1つでも数値があるか
    const flat = g.coordinates.flat(Infinity);
    return flat.length > 0 && flat.some((n) => typeof n === 'number' && isFinite(n));
  }

  // 表示範囲に応じて、必要な分割ファイルを読み込み／不要なものを破棄
  function updateParcelTiles() {
    try {
      if (!parcelIndex || !map) return;

      // ズームが浅いときは地番を出さない（筆が多すぎて重くなるため）
      if (map.getZoom() < parcelMinZoom) {
        parcelTiles.forEach((t) => map.removeLayer(t.layer));
        parcelTiles.clear();
        return;
      }

      const view = map.getBounds().pad(0.2);   // 少し広めに先読み

      // 不要になったタイルを破棄（メモリ節約）
      parcelTiles.forEach((t, name) => {
        if (!bboxIntersects(t.bbox, view)) {
          map.removeLayer(t.layer);
          parcelTiles.delete(name);
        }
      });

      // 表示範囲に重なる未読込ファイルを取得
      parcelIndex.files.forEach((fi) => {
        if (parcelTiles.has(fi.file)) return;
        if (!bboxIntersects(fi.bbox, view)) return;

        const layer = makeParcelLayer().addTo(map);
        parcelTiles.set(fi.file, { layer, bbox: fi.bbox });   // 多重取得防止に先に登録

        fetch(PARCEL_DIR + fi.file)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((geo) => {
            // [5] 空ジオメトリを除外してから addData
            if (geo && Array.isArray(geo.features)) {
              geo.features = geo.features.filter(hasUsableGeometry);
            }
            if (geo) layer.addData(geo);
          })
          .catch(() => {
            // [3] 失敗したら確実に登録解除。次回の更新で再取得の機会を残す。
            map.removeLayer(layer);
            parcelTiles.delete(fi.file);
          });
      });
    } catch (e) {
      // [2] 1回の更新でこけても、次回の moveend で再挑戦できるよう握り潰す
      // （必要ならデバッグ時のみ console.warn を有効化）
      // console.warn('updateParcelTiles error:', e);
    }
  }

  // 指定レイヤーへ複数ファイルをまとめて読み込む（一括/単一方式用）
  function loadParcelFilesInto(layer, urls) {
    urls.forEach((url) => {
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((geo) => {
          if (geo && Array.isArray(geo.features)) {
            geo.features = geo.features.filter(hasUsableGeometry);
          }
          if (geo) layer.addData(geo);
        })
        .catch(() => { /* 一部欠落しても他は表示 */ });
    });
  }

  // =====================================================================
  // ネットワーク状態の可視化
  // =====================================================================
  function setupNetworkStatus() {
    const update = () => {
      if (navigator.onLine) {
        netStatus.className = 'status-chip ok';
        netStatus.querySelector('.label').textContent = 'オンライン';
      } else {
        netStatus.className = 'status-chip off';
        netStatus.querySelector('.label').textContent = 'オフライン';
      }
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  // =====================================================================
  // GPS 現在地
  // =====================================================================
  function startGPS() {
    if (!('geolocation' in navigator)) {
      setGpsStatus('off', 'GPS非対応');
      return;
    }
    setGpsStatus('warn', 'GPS取得中');
    watchId = navigator.geolocation.watchPosition(
      onPosition,
      onPositionError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    const ll = [latitude, longitude];
    if (!meMarker) {
      const icon = L.divIcon({
        className: '', iconSize: [22, 22], iconAnchor: [11, 11],
        html: '<div class="me-marker"><div class="me-pulse"></div><div class="me-dot"></div></div>',
      });
      meMarker = L.marker(ll, { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
      meAccuracy = L.circle(ll, { radius: accuracy, color: '#1565c0', weight: 1, fillOpacity: 0.08 }).addTo(map);
      setFollowing(true);
      map.setView(ll, Math.max(map.getZoom(), 16));
    } else {
      meMarker.setLatLng(ll);
      meAccuracy.setLatLng(ll).setRadius(accuracy);
    }
    const q = accuracy <= 20 ? 'ok' : 'warn';
    setGpsStatus(q, accuracy <= 20 ? 'GPS良好' : `GPS誤差±${Math.round(accuracy)}m`);
    if (following) map.panTo(ll, { animate: true });
  }

  function onPositionError(err) {
    const msg = err.code === 1 ? 'GPS許可なし'
              : err.code === 3 ? 'GPSタイムアウト' : 'GPS取得失敗';
    setGpsStatus('off', msg);
  }

  function setGpsStatus(cls, label) {
    gpsStatus.className = 'status-chip ' + cls;
    gpsStatus.querySelector('.label').textContent = label;
  }

  function setFollowing(on) {
    following = on;
    $('btn-locate').classList.toggle('active', on);
  }

  // =====================================================================
  // メモのマーカー描画
  // =====================================================================
  const MEMO_ICONS = { '分かれ道': '🔀', '倒木あり': '🌲', '水場（水源）': '💧' };
  function memoIcon(memo) { return memo.icon || MEMO_ICONS[memo.text] || '✏️'; }

  async function renderMemoMarkers() {
    memoMarkers.forEach((m) => map.removeLayer(m));
    memoMarkers.clear();
    const memos = await DB.allMemos();
    memos.forEach((memo) => {
      const icon = L.divIcon({
        className: '', iconSize: [34, 34], iconAnchor: [17, 30],
        html: `<div class="memo-pin">📍</div>`,
      });
      const m = L.marker([memo.lat, memo.lng], { icon }).addTo(map);
      m.bindPopup(popupHtml(memo));
      memoMarkers.set(memo.id, m);
    });
    $('list-count').textContent = memos.length;
  }

  function popupHtml(memo) {
    const d = new Date(memo.createdAt);
    return `<div style="font-size:15px;font-weight:700">${memoIcon(memo)} ${escapeHtml(memo.text)}</div>
            <div style="font-size:12px;color:#777;margin-top:4px">${fmtDate(d)}<br>${memo.lat.toFixed(6)}, ${memo.lng.toFixed(6)}</div>`;
  }

  // =====================================================================
  // UI バインド
  // =====================================================================
  function bindUI() {
    $('btn-locate').addEventListener('click', () => {
      if (meMarker) { setFollowing(true); map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 16)); }
      else toast('現在地をまだ取得できていません');
    });

    $('btn-memo').addEventListener('click', openMemoSheet);
    $('btn-list').addEventListener('click', openListSheet);
    $('btn-save').addEventListener('click', openSaveSheet);

    // シートの閉じるボタン
    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => closeSheet(b.getAttribute('data-close'))));
    document.querySelectorAll('.sheet').forEach((s) =>
      s.addEventListener('click', (e) => { if (e.target === s) closeSheet(s.id); }));

    // 定型文ボタン
    document.querySelectorAll('.memo-btn').forEach((b) =>
      b.addEventListener('click', () => onMemoTemplate(b.getAttribute('data-memo'), b.getAttribute('data-icon'))));
    $('memo-other-save').addEventListener('click', saveOtherMemo);

    // 保存
    $('save-start').addEventListener('click', startSave);
    $('save-cancel').addEventListener('click', () => { saving = false; });
  }

  function openSheet(id) { $(id).classList.remove('hidden'); }
  function closeSheet(id) {
    $(id).classList.add('hidden');
    if (id === 'save-sheet') hideFinder();
  }

  // =====================================================================
  // メモ追加
  // =====================================================================
  let pendingCoord = null;

  function openMemoSheet() {
    // メモ地点は「現在地優先、なければ地図中心」
    const ll = meMarker ? meMarker.getLatLng() : map.getCenter();
    pendingCoord = { lat: ll.lat, lng: ll.lng, source: meMarker ? 'gps' : 'center' };
    $('memo-coord').textContent =
      `${pendingCoord.source === 'gps' ? '現在地' : '地図中央'}：${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
    $('memo-other-area').classList.add('hidden');
    $('memo-text').value = '';
    openSheet('memo-sheet');
  }

  function onMemoTemplate(text, icon) {
    if (text === '__other__') {
      $('memo-other-area').classList.remove('hidden');
      $('memo-text').focus();
      return;
    }
    saveMemo(text, icon);
  }

  function saveOtherMemo() {
    const t = $('memo-text').value.trim();
    if (!t) { toast('内容を入力してください'); return; }
    saveMemo(t, '✏️');
  }

  async function saveMemo(text, icon) {
    if (!pendingCoord) return;
    const memo = {
      text, icon,
      lat: pendingCoord.lat, lng: pendingCoord.lng,
      coordSource: pendingCoord.source,
      createdAt: Date.now(),
    };
    const id = await DB.addMemo(memo);
    memo.id = id;
    // 即時にピンを追加
    const lic = L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 30], html: `<div class="memo-pin">📍</div>` });
    const m = L.marker([memo.lat, memo.lng], { icon: lic }).addTo(map);
    m.bindPopup(popupHtml(memo));
    memoMarkers.set(id, m);
    $('list-count').textContent = memoMarkers.size;
    closeSheet('memo-sheet');
    toast(`${icon} 「${text}」を記録しました`);
  }

  // =====================================================================
  // メモ一覧
  // =====================================================================
  async function openListSheet() {
    const memos = await DB.allMemos();
    const body = $('list-body');
    $('list-count').textContent = memos.length;
    if (!memos.length) {
      body.innerHTML = '<div class="list-empty">まだメモはありません。<br>「メモを追加」から記録できます。</div>';
    } else {
      body.innerHTML = '';
      memos.forEach((memo) => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.innerHTML = `
          <div class="li-ico">${memoIcon(memo)}</div>
          <div class="li-main">
            <div class="li-title">${escapeHtml(memo.text)}</div>
            <div class="li-meta">${fmtDate(new Date(memo.createdAt))} ／ ${memo.lat.toFixed(5)}, ${memo.lng.toFixed(5)}</div>
          </div>
          <button class="li-del" aria-label="削除">🗑</button>`;
        row.querySelector('.li-main').addEventListener('click', () => {
          closeSheet('list-sheet');
          map.setView([memo.lat, memo.lng], Math.max(map.getZoom(), 17));
          const mk = memoMarkers.get(memo.id);
          if (mk) mk.openPopup();
        });
        row.querySelector('.li-del').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('このメモを削除しますか？')) return;
          await DB.deleteMemo(memo.id);
          const mk = memoMarkers.get(memo.id);
          if (mk) { map.removeLayer(mk); memoMarkers.delete(memo.id); }
          openListSheet();
          toast('削除しました');
        });
        body.appendChild(row);
      });
    }
    openSheet('list-sheet');
  }

  // =====================================================================
  // 地図保存（ファインダー方式・自動ズーム・過負荷ブロック）
  // =====================================================================
  function openSaveSheet() {
    showFinder();
    $('save-progress-wrap').classList.add('hidden');
    $('save-cancel').classList.add('hidden');
    $('save-start').classList.remove('hidden');
    updateFinderInfo();
    openSheet('save-sheet');
  }

  function showFinder() { finder.classList.remove('hidden'); }
  function hideFinder() { finder.classList.add('hidden'); }

  // ファインダー枠が示す地理範囲を求める
  function finderBounds() {
    const box = document.querySelector('.finder-box').getBoundingClientRect();
    const nw = map.containerPointToLatLng([box.left, box.top]);
    const se = map.containerPointToLatLng([box.right, box.bottom]);
    return L.latLngBounds(se, nw);
  }

  // 枠内・指定ズーム群のタイル座標を列挙
  function tilesForBounds(bounds) {
    const list = [];
    SAVE_ZOOMS.forEach((z) => {
      const nw = project(bounds.getNorthWest(), z);
      const se = project(bounds.getSouthEast(), z);
      for (let x = nw.x; x <= se.x; x++) {
        for (let y = nw.y; y <= se.y; y++) {
          list.push({ z, x, y });
        }
      }
    });
    return list;
  }

  function project(latlng, z) {
    const n = Math.pow(2, z);
    const x = Math.floor((latlng.lng + 180) / 360 * n);
    const latRad = latlng.lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x: Math.max(0, x), y: Math.max(0, y) };
  }

  function updateFinderInfo() {
    const tiles = tilesForBounds(finderBounds());
    const count = tiles.length;
    const info = $('finder-info');
    const est = $('save-estimate');
    const startBtn = $('save-start');
    const mb = (count * 18 / 1024).toFixed(1); // 1枚≒18KB目安

    if (count > MAX_TILES) {
      finder.classList.add('too-wide');
      info.textContent = '範囲が広すぎます。地図を拡大してください';
      est.innerHTML = `<span class="save-estimate-warn">範囲が広すぎます（約${count}枚）。地図を拡大してください。</span>`;
      startBtn.disabled = true; startBtn.style.opacity = .5;
    } else {
      finder.classList.remove('too-wide');
      info.textContent = `保存枚数：約 ${count} 枚`;
      const cls = count > WARN_TILES ? 'save-estimate-warn' : 'save-estimate-ok';
      est.innerHTML = `保存対象：<span class="${cls}">約 ${count} 枚（約 ${mb} MB）</span>　ズーム${SAVE_ZOOMS[0]}〜${SAVE_ZOOMS[SAVE_ZOOMS.length-1]}`;
      startBtn.disabled = false; startBtn.style.opacity = 1;
    }
  }

  async function startSave() {
    if (saving) return;
    const tiles = tilesForBounds(finderBounds());
    if (tiles.length > MAX_TILES) { toast('範囲が広すぎます'); return; }
    if (!navigator.onLine) { toast('保存にはオンライン接続が必要です'); return; }

    saving = true;
    $('save-start').classList.add('hidden');
    $('save-cancel').classList.remove('hidden');
    $('save-progress-wrap').classList.remove('hidden');
    hideFinder();

    const total = tiles.length;
    let done = 0, failed = 0;
    const bar = $('save-progress-bar');
    const txt = $('save-progress-text');
    const setProg = () => {
      bar.style.width = (done / total * 100).toFixed(1) + '%';
      txt.textContent = `${done} / ${total} 枚`;
    };
    setProg();

    // 4並列でダウンロード
    const queue = tiles.slice();
    const worker = async () => {
      while (queue.length && saving) {
        const t = queue.shift();
        const key = `${t.z}/${t.x}/${t.y}`;
        try {
          if (!(await DB.hasTile(key))) {
            const url = GSI_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
            const res = await fetch(url, { mode: 'cors' });
            if (res.ok) { await DB.putTile(key, await res.blob()); }
            else failed++;
          }
        } catch (_) { failed++; }
        done++; setProg();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    saving = false;
    $('save-cancel').classList.add('hidden');
    $('save-start').classList.remove('hidden');
    baseLayer.redraw();
    closeSheet('save-sheet');
    toast(failed ? `保存完了（${total - failed}枚成功・${failed}枚失敗）` : `地図を保存しました（${total}枚）`);
  }

  // =====================================================================
  // 前回表示位置の保存／復元
  // =====================================================================
  function saveLastView() {
    try {
      const c = map.getCenter();
      localStorage.setItem('lastView', JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() }));
    } catch (_) {}
  }
  function restoreLastView() {
    try {
      const v = JSON.parse(localStorage.getItem('lastView'));
      if (v) map.setView([v.lat, v.lng], v.z);
    } catch (_) {}
  }

  // =====================================================================
  // ユーティリティ
  // =====================================================================
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }
  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---- Service Worker 登録 ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () =>
      navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
