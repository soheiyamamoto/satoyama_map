/* =====================================================================
 * app.js  —  里山調査用オフライン地図 メインロジック
 * ===================================================================== */
(() => {
  'use strict';

  // ---- 設定値 ----
  const GSI_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
  const GSI_ATTR = '地理院タイル（国土地理院）';
  const HILLSHADE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png';
  const SAVE_ZOOMS = [15, 16, 17, 18];   // 一括保存するズームレベル
  const MAX_TILES = 600;                  // 過負荷防止：1回の保存上限枚数
  const WARN_TILES = 450;                 // 警告ライン
  const DEFAULT_CENTER = [32.92978, 131.87028]; // 初期表示（佐伯市中心部・地番データに合わせる）
  const DEFAULT_ZOOM = 16;

  // ---- 状態 ----
  let map, baseLayer, parcelLayer, meMarker, meAccuracy, parcelRenderer, terrainLayer;
  let following = false;
  let watchId = null;
  const memoMarkers = new Map();
  let saving = false;
  let satomichiMode = false;   // 里道モード（筆の塗りを強調し隙間を視認しやすくする）
  let terrainMode = false;     // 地形モード（陰影起伏図を半透明オーバーレイ表示）

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const netStatus = $('net-status');
  const gpsStatus = $('gps-status');
  const finder = $('finder');
  const toastEl = $('toast');

  // =====================================================================
  // #map の高さ同期（iOS PWA対策）
  //   100dvhでも一部のiOS実機ではPWAスタンドアロン起動時に灰色の帯が
  //   解消しないケースがあったため、window.visualViewport.height を
  //   #map へ直接反映する。visualViewport非対応環境ではCSSのdvhへ
  //   フォールバックする（このブロック自体が何もしない）。
  // =====================================================================
  let _syncMapHeightScheduled = false;
  function syncMapHeight() {
    const vv = window.visualViewport;
    if (vv) {
      $('map').style.height = vv.height + 'px';
    }
    if (map) map.invalidateSize();
  }
  // visualViewportのresize/scrollは連続発火しうるため、1フレームに1回へ間引く
  function scheduleSyncMapHeight() {
    if (_syncMapHeightScheduled) return;
    _syncMapHeightScheduled = true;
    requestAnimationFrame(() => {
      _syncMapHeightScheduled = false;
      syncMapHeight();
    });
  }

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

    // 重ね順: 背景地形図(tilePane, z200) < 陰影起伏図(hillshadePane, z350) < 地番(overlayPane, z400)
    // 専用paneのzIndexで担保するため、addTo順やレイヤー種別に依存しない。
    map.createPane('hillshadePane');
    map.getPane('hillshadePane').style.zIndex = 350;
    // 半透明オーバーレイはオンライン専用（通常のL.tileLayer）。
    // オフライン保存(IndexedDB)の対象に含めるとストレージが膨らむため対象外とする。
    terrainLayer = L.tileLayer(HILLSHADE_URL, {
      attribution: GSI_ATTR,
      maxNativeZoom: 16,
      maxZoom: 21,
      opacity: 0.5,
      pane: 'hillshadePane',
    });

    restoreSatomichiMode();   // 里道モードの復元（loadParcelLayerより前＝初回描画から反映）
    restoreTerrainMode();     // 地形モードの復元
    loadParcelLayer();   // 地番レイヤー（あれば）
    restoreLastView();   // 前回表示位置の復元
    bindUI();
    setTimeout(loadWhatsNew, 1000);   // 地図描画を優先し、少し遅らせてお知らせを確認

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
      updateZoomHint();
      applyLabelsToAll();
    });
    updateZoomHint();
    // ユーザーが地図をドラッグしたら追従を解除
    map.on('dragstart', () => setFollowing(false));

    // iOS PWA(スタンドアロン起動)対策: 起動直後はビューポートが確定しきって
    // おらず、Leafletがコンテナサイズを誤って測り画面下部がグレーに切れる
    // ことがある。複数のタイミングで invalidateSize() を呼び直して確実にする。
    setTimeout(() => map.invalidateSize(), 100);
    window.addEventListener('resize', () => map.invalidateSize());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) map.invalidateSize();
    });

    // visualViewport対応環境では、#mapの高さをvisualViewport.heightへ
    // 直接同期する（100dvhでも解消しなかったPWAの灰色帯対策）。
    // 非対応環境（Android等の一部ブラウザ）では window.visualViewport が
    // undefinedになるだけで、CSSのdvhフォールバックがそのまま効く。
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleSyncMapHeight);
      window.visualViewport.addEventListener('scroll', scheduleSyncMapHeight);
    }
    window.addEventListener('load', syncMapHeight);
    syncMapHeight();   // 初回実行
  }

  // =====================================================================
  // 地番レイヤー（事前にGeoJSONへ変換したデータを読み込む）
  //   data/parcels/index.json の有無・形式で3通りに対応する:
  //    (A) ondemand方式 : {mode:"ondemand", minZoom, files:[{file,bbox}]}
  //          → 地図の表示範囲に重なるファイルだけを都度読み込む（大容量向け）
  //    (B) 一括方式      : {files:["a.geojson", ...]}  → 全ファイルを読み込む
  //    (C) 単一ファイル  : index.json 無し → data/parcels.geojson を読む（後方互換）
  // =====================================================================
  const PARCEL_STROKE = { color: '#d84315', weight: 1.0, fillColor: '#ff7043' };
  const PARCEL_FILL_NORMAL = 0.06;
  const PARCEL_FILL_SATOMICHI = 0.35;   // 里道モード: 筆を面として強調し、塗られない隙間を浮かび上がらせる
  const PARCEL_DIR = 'data/parcels/';
  const LABEL_MIN_ZOOM = 17;           // これ以上で地番番号を常時表示（それ未満はタップで確認）

  // 現在のモードを反映したスタイルを返す（features引数はLeafletのstyle関数仕様に合わせるが未使用）
  function parcelStyle() {
    return { ...PARCEL_STROKE, fillOpacity: satomichiMode ? PARCEL_FILL_SATOMICHI : PARCEL_FILL_NORMAL };
  }

  // ondemand用の状態
  const parcelTiles = new Map();   // file名 -> { layer, bbox } 読込済みの管理
  let parcelIndex = null;          // index.json の中身（ondemand時）
  let parcelMinZoom = 15;

  function parcelProps(f) {
    const p = (f && f.properties) || {};
    return {
      chiban: p.chiban || p.地番 || p.筆ID || '',
      oaza: p.大字名 || p.oaza || '',
    };
  }

  function parcelPopupHtml(f) {
    const { chiban, oaza } = parcelProps(f);
    const title = chiban ? escapeHtml(String(chiban)) : '地番なし';
    const oazaLine = oaza
      ? `<div class="parcel-popup-oaza">${escapeHtml(String(oaza))}</div>`
      : '';
    return `<div class="parcel-popup">
      <div class="parcel-popup-chiban">${title}</div>
      ${oazaLine}
    </div>`;
  }

  function labelsShouldShow() {
    return !!(map && map.getZoom() >= LABEL_MIN_ZOOM);
  }

  // 常時ラベルは拡大時かつ画面内の、ある程度大きい筆だけ DOM に載せる
  function applyLabelsToLayer(layer) {
    if (!layer || !layer.eachLayer || !map) return;
    const show = labelsShouldShow();
    const view = show ? map.getBounds() : null;
    layer.eachLayer((l) => {
      if (show && shouldShowParcelLabel(l, view)) {
        if (l.getTooltip()) return;
        const chiban = parcelProps(l.feature).chiban;
        if (!chiban) return;
        l.bindTooltip(String(chiban), {
          permanent: true,
          direction: 'center',
          className: 'parcel-label',
          interactive: false,
        });
      } else if (l.getTooltip()) {
        l.unbindTooltip();
      }
    });
  }

  function shouldShowParcelLabel(layer, view) {
    if (!layer.getBounds) return false;
    const b = layer.getBounds();
    if (!b.isValid() || !view.intersects(b)) return false;
    const sw = map.latLngToContainerPoint(b.getSouthWest());
    const ne = map.latLngToContainerPoint(b.getNorthEast());
    const w = Math.abs(ne.x - sw.x);
    const h = Math.abs(ne.y - sw.y);
    return w >= 28 && h >= 16;
  }

  function applyLabelsToAll() {
    if (parcelLayer) applyLabelsToLayer(parcelLayer);
    parcelTiles.forEach((t) => applyLabelsToLayer(t.layer));
  }

  function updateZoomHint() {
    const el = $('zoom-hint');
    if (!el || !map) return;
    el.classList.toggle('hidden', map.getZoom() >= parcelMinZoom);
  }

  function onEachParcel(f, layer) {
    layer.bindPopup(parcelPopupHtml(f), { className: 'parcel-popup-wrap', maxWidth: 240 });
  }

  function makeParcelLayer() {
    // style に関数を渡すことで、後からondemandで読み込まれるタイルにも
    // その時点の satomichiMode が反映される（追加時に都度呼び出される）。
    return L.geoJSON(null, { style: parcelStyle, onEachFeature: onEachParcel, renderer: parcelRenderer });
  }

  // 里道モード切り替え時、既に読み込み済みの全レイヤーへ即座にスタイルを反映
  function applyParcelStyleToAll() {
    if (parcelLayer) parcelLayer.setStyle(parcelStyle);
    parcelTiles.forEach((t) => t.layer.setStyle(parcelStyle));
  }

  function setSatomichiMode(on) {
    satomichiMode = on;
    $('btn-satomichi').classList.toggle('active', on);
    applyParcelStyleToAll();
    try { localStorage.setItem('satomichiMode', JSON.stringify(on)); } catch (_) {}
  }

  // 地形モード（陰影起伏図オーバーレイ）の切り替え。
  // OFF時はレイヤーごとmapから外すため、非表示中はタイル取得も発生しない。
  function setTerrainMode(on) {
    terrainMode = on;
    $('btn-terrain').classList.toggle('active', on);
    if (on) { if (!map.hasLayer(terrainLayer)) terrainLayer.addTo(map); }
    else { map.removeLayer(terrainLayer); }
    try { localStorage.setItem('terrainMode', JSON.stringify(on)); } catch (_) {}
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
          updateZoomHint();

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
        updateZoomHint();
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
            if (geo) {
              layer.addData(geo);
              applyLabelsToLayer(layer);
            }
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
          if (geo) {
            layer.addData(geo);
            applyLabelsToLayer(layer);
          }
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
  function memoPinIcon(memo) {
    return L.divIcon({
      className: '', iconSize: [34, 34], iconAnchor: [17, 30],
      html: `<div class="memo-pin">${memoIcon(memo)}</div>`,
    });
  }

  async function renderMemoMarkers() {
    memoMarkers.forEach((m) => map.removeLayer(m));
    memoMarkers.clear();
    const memos = await DB.allMemos();
    memos.forEach((memo) => {
      const m = L.marker([memo.lat, memo.lng], { icon: memoPinIcon(memo) }).addTo(map);
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
    $('btn-help').addEventListener('click', () => openSheet('help-sheet'));

    $('btn-locate').addEventListener('click', () => {
      if (meMarker) { setFollowing(true); map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 16)); }
      else toast('現在地をまだ取得できていません');
    });

    $('btn-satomichi').addEventListener('click', () => setSatomichiMode(!satomichiMode));
    $('btn-terrain').addEventListener('click', () => setTerrainMode(!terrainMode));

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
    $('memo-place-gps').addEventListener('click', () => setMemoPlace('gps'));
    $('memo-place-center').addEventListener('click', () => setMemoPlace('center'));
    $('memo-place-tap').addEventListener('click', startMemoPlaceTap);
    $('place-mask').addEventListener('click', onMemoPlaceTap);
    $('place-cancel').addEventListener('click', cancelMemoPlaceTap);
    $('list-export').addEventListener('click', exportMemos);

    // 保存
    $('save-start').addEventListener('click', startSave);
    $('save-cancel').addEventListener('click', () => { saving = false; });
    $('save-clear').addEventListener('click', clearSavedMap);
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
  let placingMemo = false;
  let keepTapPlace = false;

  function openMemoSheet() {
    $('memo-other-area').classList.add('hidden');
    $('memo-text').value = '';
    if (keepTapPlace && pendingCoord && pendingCoord.source === 'tap') {
      keepTapPlace = false;
      updateMemoPlaceUi();
    } else {
      setMemoPlace(meMarker ? 'gps' : 'center');
    }
    openSheet('memo-sheet');
  }

  function setMemoPlace(source) {
    if (source === 'gps') {
      if (!meMarker) {
        toast('現在地をまだ取得できていません');
        if (!pendingCoord) setMemoPlace('center');
        else updateMemoPlaceUi();
        return;
      }
      const ll = meMarker.getLatLng();
      pendingCoord = { lat: ll.lat, lng: ll.lng, source: 'gps' };
    } else if (source === 'center') {
      const ll = map.getCenter();
      pendingCoord = { lat: ll.lat, lng: ll.lng, source: 'center' };
    }
    updateMemoPlaceUi();
  }

  function updateMemoPlaceUi() {
    if (!pendingCoord) return;
    const label = pendingCoord.source === 'gps' ? '現在地'
      : pendingCoord.source === 'tap' ? 'タップした位置' : '地図の中央';
    $('memo-coord').textContent =
      `${label}：${pendingCoord.lat.toFixed(6)}, ${pendingCoord.lng.toFixed(6)}`;
    $('memo-place-gps').setAttribute('aria-pressed', pendingCoord.source === 'gps' ? 'true' : 'false');
    $('memo-place-center').setAttribute('aria-pressed', pendingCoord.source === 'center' ? 'true' : 'false');
    $('memo-place-tap').setAttribute('aria-pressed', pendingCoord.source === 'tap' ? 'true' : 'false');
  }

  function startMemoPlaceTap() {
    closeSheet('memo-sheet');
    placingMemo = true;
    $('place-mask').classList.remove('hidden');
    $('place-hint').classList.remove('hidden');
  }

  function onMemoPlaceTap(e) {
    if (!placingMemo || !map) return;
    const rect = $('map').getBoundingClientRect();
    const pt = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const ll = map.containerPointToLatLng(pt);
    pendingCoord = { lat: ll.lat, lng: ll.lng, source: 'tap' };
    keepTapPlace = true;
    stopMemoPlaceTap();
    openMemoSheet();
  }

  function cancelMemoPlaceTap() {
    stopMemoPlaceTap();
    if (!pendingCoord) setMemoPlace(meMarker ? 'gps' : 'center');
    else updateMemoPlaceUi();
    $('memo-other-area').classList.add('hidden');
    openSheet('memo-sheet');
  }

  function stopMemoPlaceTap() {
    placingMemo = false;
    $('place-mask').classList.add('hidden');
    $('place-hint').classList.add('hidden');
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
    const m = L.marker([memo.lat, memo.lng], { icon: memoPinIcon(memo) }).addTo(map);
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
    $('list-export').classList.toggle('hidden', !memos.length);
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

  async function exportMemos() {
    const memos = await DB.allMemos();
    if (!memos.length) { toast('書き出すメモがありません'); return; }
    const geo = {
      type: 'FeatureCollection',
      features: memos.map((m) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
        properties: {
          text: m.text,
          icon: memoIcon(m),
          createdAt: new Date(m.createdAt).toISOString(),
          coordSource: m.coordSource || '',
        },
      })),
    };
    const json = JSON.stringify(geo, null, 2);
    const name = `satoyama-memos-${new Date().toISOString().slice(0, 10)}.geojson`;
    const blob = new Blob([json], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '里山地図のメモ' });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('メモを書き出しました');
  }

  // =====================================================================
  // 地図保存（ファインダー方式・自動ズーム・過負荷ブロック）
  // =====================================================================
  function openSaveSheet() {
    showFinder();
    $('save-progress-wrap').classList.add('hidden');
    $('save-cancel').classList.add('hidden');
    $('save-start').classList.remove('hidden');
    $('save-clear').classList.remove('hidden');
    updateFinderInfo();
    refreshSaveStorage();
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

  async function refreshSaveStorage() {
    const el = $('save-storage');
    if (!el) return;
    try {
      const n = await DB.countTiles();
      const est = await DB.estimate();
      const mb = est && est.usage ? (est.usage / (1024 * 1024)).toFixed(1) : null;
      el.textContent = mb
        ? `保存済みの地図：${n} 枚　／　このアプリの使用量：約 ${mb} MB（目安）`
        : `保存済みの地図：${n} 枚`;
      $('save-clear').disabled = n === 0;
      $('save-clear').style.opacity = n === 0 ? .5 : 1;
    } catch (_) {
      el.textContent = '保存済みの地図：確認できませんでした';
    }
  }

  async function clearSavedMap() {
    if (saving) return;
    const n = await DB.countTiles();
    if (!n) { toast('削除する地図はありません'); return; }
    if (!confirm('保存した地図を削除しますか？電波のない場所では、保存した範囲の地図が出なくなります。')) return;
    await DB.clearTiles();
    if (baseLayer) baseLayer.redraw();
    await refreshSaveStorage();
    toast('保存した地図を削除しました');
  }

  async function ensureParcelIndex() {
    if (parcelIndex) return;
    try {
      const r = await fetch(PARCEL_DIR + 'index.json');
      const idx = r.ok ? await r.json() : null;
      if (idx && idx.mode === 'ondemand' && Array.isArray(idx.files)) {
        parcelIndex = idx;
        parcelMinZoom = idx.minZoom || 15;
      }
    } catch (_) { /* 地番の先読みは省略して地図保存だけ進める */ }
  }

  function parcelFilesForBounds(bounds) {
    if (!parcelIndex || !Array.isArray(parcelIndex.files)) return [];
    return parcelIndex.files.filter((fi) => Array.isArray(fi.bbox) && bboxIntersects(fi.bbox, bounds));
  }

  async function startSave() {
    if (saving) return;
    const bounds = finderBounds();
    const tiles = tilesForBounds(bounds);
    if (tiles.length > MAX_TILES) { toast('範囲が広すぎます'); return; }
    if (!navigator.onLine) { toast('保存にはオンライン接続が必要です'); return; }

    await ensureParcelIndex();
    const parcelFiles = parcelFilesForBounds(bounds);

    saving = true;
    $('save-start').classList.add('hidden');
    $('save-clear').classList.add('hidden');
    $('save-cancel').classList.remove('hidden');
    $('save-progress-wrap').classList.remove('hidden');
    hideFinder();

    const tileTotal = tiles.length;
    const parcelTotal = parcelFiles.length;
    const total = tileTotal + parcelTotal;
    let done = 0, tileFailed = 0, parcelFailed = 0;
    const bar = $('save-progress-bar');
    const txt = $('save-progress-text');
    const setProg = () => {
      bar.style.width = total ? (done / total * 100).toFixed(1) + '%' : '100%';
      txt.textContent = parcelTotal
        ? `${done} / ${total}（地図 ${tileTotal} 枚・地番 ${parcelTotal} ファイル）`
        : `${done} / ${tileTotal} 枚`;
    };
    setProg();

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
            else tileFailed++;
          }
        } catch (_) { tileFailed++; }
        done++; setProg();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    const pqueue = parcelFiles.slice();
    const pworker = async () => {
      while (pqueue.length && saving) {
        const fi = pqueue.shift();
        try {
          const r = await fetch(PARCEL_DIR + fi.file);
          if (!r.ok) parcelFailed++;
          else await r.arrayBuffer();
        } catch (_) { parcelFailed++; }
        done++; setProg();
      }
    };
    if (saving) await Promise.all([pworker(), pworker(), pworker(), pworker()]);

    const cancelled = !saving;
    saving = false;
    $('save-cancel').classList.add('hidden');
    $('save-start').classList.remove('hidden');
    $('save-clear').classList.remove('hidden');
    baseLayer.redraw();
    await refreshSaveStorage();
    closeSheet('save-sheet');
    if (cancelled) { toast('保存を中止しました'); return; }
    const tileOk = tileTotal - tileFailed;
    const parcelOk = parcelTotal - parcelFailed;
    if (tileFailed || parcelFailed) {
      toast(`保存完了（地図 ${tileOk}/${tileTotal} 枚、地番 ${parcelOk}/${parcelTotal} ファイル）`);
    } else if (parcelTotal) {
      toast(`地図と地番を保存しました（地図 ${tileTotal} 枚・地番 ${parcelTotal} ファイル）`);
    } else {
      toast(`地図を保存しました（${tileTotal}枚）`);
    }
  }

  // =====================================================================
  // 里道モードの復元（保存はトグル操作時に setSatomichiMode 内で行う）
  // =====================================================================
  function restoreSatomichiMode() {
    try {
      const v = JSON.parse(localStorage.getItem('satomichiMode'));
      satomichiMode = v === true;
    } catch (_) {}
    $('btn-satomichi').classList.toggle('active', satomichiMode);
  }

  // =====================================================================
  // 地形モード（陰影起伏図）の復元（デフォルトOFF）
  // =====================================================================
  function restoreTerrainMode() {
    let on = false;
    try {
      const v = JSON.parse(localStorage.getItem('terrainMode'));
      on = v === true;
    } catch (_) {}
    terrainMode = on;
    $('btn-terrain').classList.toggle('active', on);
    if (on) terrainLayer.addTo(map);
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

  // =====================================================================
  // 更新のお知らせモーダル（version.json）
  //   前回見たバージョン（localStorage）と現在のバージョンが違う時だけ、
  //   平易な言葉で変更点を1回だけ知らせる。初回起動時は記録のみ行い、
  //   使ったことのない人に「新しくなりました」は見せない。
  // =====================================================================
  function loadWhatsNew() {
    // cache: 'no-store' は SW 非制御時（初回や localhost）のブラウザHTTPキャッシュを避ける。
    // SW 制御下では install 時に SHELL へ version.json が入り直るため、リロード後は新版が返る。
    fetch('version.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((info) => {
      if (!info || !info.version) return;
      let last = null;
      try { last = localStorage.getItem('lastSeenVersion'); } catch (_) {}
      if (last === null) {
        try { localStorage.setItem('lastSeenVersion', info.version); } catch (_) {}
        return;
      }
      if (last === info.version) return;
      $('whatsnew-date').textContent = info.date || '';
      $('whatsnew-notes').innerHTML = (info.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
      openSheet('whatsnew-sheet');
      try { localStorage.setItem('lastSeenVersion', info.version); } catch (_) {}
    }).catch(() => {});
  }

  // =====================================================================
  // Service Worker 更新の検知・控えめな通知・反映
  //   sw.js は skipWaiting()/clients.claim() 済みのため新SWは待たずに
  //   有効化されるが、開きっぱなしのタブではブラウザが自発的に更新確認
  //   する機会（ナビゲーション）がほぼ無い。ここで能動的に確認を促し、
  //   有効化を検知したらバナーで知らせ、ユーザー操作かアプリ再開の
  //   自然なタイミングでリロードして反映する（突然のリロードはしない）。
  // =====================================================================
  // このページ読み込み時点で既にSWに制御されていたか。
  // false の場合、直後に来る最初の controllerchange は「新規インストール」
  // であって「更新」ではないため無視する（誤ってバナーを出さないためのガード）。
  let swUpdateArmed = !!navigator.serviceWorker.controller;
  let swUpdatePending = false;
  // バナーをフォアグラウンドで一度でも表示できたか。
  // controllerchangeがバックグラウンド中に発火した場合、ユーザーは
  // まだバナーを一度も見ていないため、次にvisibleへ戻った瞬間に
  // 即リロードすると「気づかないまま再読み込みされた」体験になる。
  // その復帰では表示するだけに留め、確認済みにしてから反映対象にする。
  let bannerAcknowledged = false;

  function setupSwUpdateWatcher(reg) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!swUpdateArmed) { swUpdateArmed = true; return; }
      swUpdatePending = true;
      $('update-banner').classList.remove('hidden');
      // 検知した瞬間フォアグラウンドで見ているなら、その場でバナーが
      // 目に入るため確認済み扱いにする（従来通り即反映の対象になる）。
      if (!document.hidden) bannerAcknowledged = true;
    });

    const checkForUpdate = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      checkForUpdate();
      if (swUpdatePending && !bannerAcknowledged) {
        // バックグラウンド中に検知された更新を、この復帰で初めて見せる。
        // このタイミングではまだ反映せず、次の復帰かタップから対象にする。
        bannerAcknowledged = true;
        return;
      }
      applyPendingUpdateIfSafe();
    });
    setInterval(checkForUpdate, 30 * 60 * 1000);

    $('update-banner').addEventListener('click', () => location.reload());
  }

  // シートが1つでも開いている間（地図保存の進捗表示中も save-sheet が
  // 開いたままなので、この判定だけで両方のケースをまとめてガードできる）、
  // および現在地に追従中（現地調査で歩きながら地図を見ている状態）は
  // リロードを見送り、作業を中断させない。バナーは表示したまま次の機会を待つ。
  function applyPendingUpdateIfSafe() {
    if (!swUpdatePending) return;
    if (document.querySelector('.sheet:not(.hidden)')) return;
    if (placingMemo) return;
    if (following) return;
    location.reload();
  }

  // ---- Service Worker 登録 ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () =>
      navigator.serviceWorker.register('sw.js')
        .then((reg) => setupSwUpdateWatcher(reg))
        .catch(() => {}));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
