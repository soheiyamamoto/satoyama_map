#!/usr/bin/env python3
# =====================================================================
# prepare_parcels.py
#   地番GeoJSONをアプリ用に正規化する PC側の前処理ツール。
#
#   仕様書 3.1 の制約「端末では地図XMLを直接読まず、事前にPCで
#   GeoJSON/ベクタータイルへ変換したものを読み込む」に対応する。
#
#   入力 : WGS84(経度緯度, EPSG:4326)のGeoJSON（FeatureCollection / Polygon系）
#   出力 : data/parcels.geojson（地番を "chiban" プロパティへ統一）
#
#   使い方:
#     python3 tools/prepare_parcels.py input.geojson \
#         --chiban-key 地番 --out data/parcels.geojson
#
#   ※ 法務省「登記所備付地図データ」や G空間情報センターのデータは、
#     まず GIS / ogr2ogr 等で EPSG:4326 のGeoJSONに変換してから本ツールへ。
#       例)  ogr2ogr -f GeoJSON -t_srs EPSG:4326 input.geojson source.shp
#     XMLフォーマットの場合は MOJ-XML→GeoJSON 変換ツールで一旦GeoJSON化する。
# =====================================================================
import argparse, json, sys

CHIBAN_CANDIDATES = ["chiban", "地番", "CHIBAN", "筆ID", "fude_id", "地番号"]


def pick_chiban(props, key):
    if key and key in props:
        return props[key]
    for k in CHIBAN_CANDIDATES:
        if k in props:
            return props[k]
    return ""


def bbox_of(features):
    xs, ys = [], []
    def walk(coords):
        if isinstance(coords[0], (int, float)):
            xs.append(coords[0]); ys.append(coords[1])
        else:
            for c in coords:
                walk(c)
    for f in features:
        g = f.get("geometry") or {}
        if g.get("coordinates"):
            walk(g["coordinates"])
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def main():
    ap = argparse.ArgumentParser(description="地番GeoJSONをアプリ用に正規化")
    ap.add_argument("input", help="入力GeoJSON(EPSG:4326)")
    ap.add_argument("--chiban-key", default=None, help="地番が入っているプロパティ名")
    ap.add_argument("--out", default="data/parcels.geojson", help="出力先")
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        gj = json.load(f)

    feats = gj.get("features", []) if gj.get("type") == "FeatureCollection" else [gj]
    out_feats = []
    for f in feats:
        g = f.get("geometry")
        if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        props = f.get("properties") or {}
        out_feats.append({
            "type": "Feature",
            "properties": {"chiban": str(pick_chiban(props, args.chiban_key))},
            "geometry": g,
        })

    if not out_feats:
        print("ポリゴンが見つかりませんでした。入力データを確認してください。", file=sys.stderr)
        sys.exit(1)

    bb = bbox_of(out_feats)
    if bb and (bb[0] < -180 or bb[2] > 180 or bb[1] < -90 or bb[3] > 90):
        print("警告: 座標が経度緯度(EPSG:4326)の範囲外です。先に再投影してください。", file=sys.stderr)

    result = {"type": "FeatureCollection", "name": "parcels", "features": out_feats}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)

    print(f"出力完了: {args.out}")
    print(f"  筆数 : {len(out_feats)}")
    if bb:
        print(f"  範囲 : 経度 {bb[0]:.5f}〜{bb[2]:.5f} / 緯度 {bb[1]:.5f}〜{bb[3]:.5f}")
    print("  → この範囲が初期表示されるよう、必要なら js/app.js の DEFAULT_CENTER を更新してください。")


if __name__ == "__main__":
    main()
