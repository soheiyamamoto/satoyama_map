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
      // 未保存 → 常に取得を試みる。
      // ブラウザのオンライン状態フラグは macOS/Chrome 等で実際の接続性と
      // 無関係に false を返すことがあり、事前分岐に使うと取得を試みずに
      // 全タイルがプレースホルダ化して地図がグレー一色になる。事前判定はせず、
      // 失敗したら onerror で初めてプレースホルダに落とす（本当にオフラインなら
      // 取得が失敗するため、オフライン時の挙動は従来と同等）。
      // CORS属性は付けない: 表示のみでピクセル読み取り(canvas readback)を
      // 行わないため不要。付けるとCDNのCORSヘッダーが不安定な場合に
      // 読み込み自体が失敗し、タイルが灰色プレースホルダに置き換わる。
      tile.src = url;
      tile.onload = () => done(null, tile);
      tile.onerror = () => { tile.src = this._blankUrl; tile.classList.add('tile-missing'); done(null, tile); };
    }).catch(() => { tile.src = this._blankUrl; done(null, tile); });

    return tile;
  },
});

function offlineTileLayer(urlTemplate, options) {
  return new OfflineTileLayer(urlTemplate, options);
}
