/* =====================================================================
 * tilelayer.js  —  オフライン対応タイルレイヤー
 *  読み込み優先順位:
 *    1) IndexedDB に保存済みタイルがあればそれを表示（完全オフライン動作）
 *    2) 無く、かつオンラインならネットから取得し、表示しつつ自動キャッシュ
 *    3) 取得できなければ「未保存」プレースホルダを表示
 *  地理院タイルの利用規約に基づき出典表示を付与する。
 * ===================================================================== */
const OfflineTileLayer = L.TileLayer.extend({
  // 未保存領域に表示する淡色プレースホルダ（1x1 透過 → CSS背景でグレー）
  _blankUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=',

  createTile: function (coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    const key = `${coords.z}/${coords.x}/${coords.y}`;
    const url = this.getTileUrl(coords);

    DB.getTile(key).then((blob) => {
      if (blob) {
        // 保存済み → オフラインでも確実に表示
        tile.src = URL.createObjectURL(blob);
        tile.onload = () => { URL.revokeObjectURL(tile.src); done(null, tile); };
        tile.onerror = () => done(null, tile);
        return;
      }
      if (navigator.onLine) {
        // 未保存だがオンライン → 取得して表示（閲覧用、自動キャッシュはしない）
        // CORS属性は付けない: 表示のみでピクセル読み取り(canvas readback)を
        // 行わないため不要。付けるとCDNのCORSヘッダーが不安定な場合に
        // 読み込み自体が失敗し、タイルが灰色プレースホルダに置き換わる
        // （Chrome等で再現）。
        tile.src = url;
        tile.onload = () => done(null, tile);
        tile.onerror = () => { tile.src = this._blankUrl; tile.classList.add('tile-missing'); done(null, tile); };
      } else {
        // 未保存かつオフライン → プレースホルダ
        tile.src = this._blankUrl;
        tile.classList.add('tile-missing');
        done(null, tile);
      }
    }).catch(() => { tile.src = this._blankUrl; done(null, tile); });

    return tile;
  },
});

function offlineTileLayer(urlTemplate, options) {
  return new OfflineTileLayer(urlTemplate, options);
}
