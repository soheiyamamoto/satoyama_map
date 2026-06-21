#!/usr/bin/env python3
# =====================================================================
# split_parcels.py
#   巨大な地番GeoJSON（例: 法務省 登記所備付地図データ・市町村1ファイル）を
#   緯度経度メッシュで複数ファイルへ分割し、各ファイルの範囲(bbox)を記した
#   index.json を出力する。アプリはこの index.json を見て、
#   「地図の表示範囲に重なるファイルだけ」をオンデマンド読込する。
#
#   同時に軽量化を行う:
#     ・アプリが使うプロパティ（既定: 地番→chiban、任意で大字名）だけ残す
#     ・座標を指定桁(既定6桁≒0.1m)に丸める
#   これによりファイル総量を大幅に削減する。
#
#   入力は EPSG:4326（経度緯度, CRS84）であること。
#   1 Feature が 1 行のGeoJSON（ogr2ogr等の標準出力）を想定したストリーム処理。
#
#   使い方の例:
#     python3 tools/split_parcels.py data/44205__2_r_2025.geojson \
#         --outdir data/parcels --grid 0.02 --precision 6 \
#         --chiban-key 地番 --keep 大字名 --min-zoom 15
# =====================================================================
import argparse, json, os, sys, glob
from collections import OrderedDict

HANDLE_CAP = 200   # 同時に開くファイル数の上限（OSのfd枯渇を防ぐ）


def round_coords(obj, p):
    if isinstance(obj, list):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], p), round(obj[1], p)]
        return [round_coords(x, p) for x in obj]
    return obj


def first_point(geom):
    c = geom.get("coordinates")
    while isinstance(c, list) and c and isinstance(c[0], list):
        c = c[0]
    return c if (isinstance(c, list) and len(c) >= 2 and isinstance(c[0], (int, float))) else None


def update_bbox(bb, geom):
    def walk(co):
        if co and isinstance(co[0], (int, float)):
            x, y = co[0], co[1]
            if x < bb[0]: bb[0] = x
            if y < bb[1]: bb[1] = y
            if x > bb[2]: bb[2] = x
            if y > bb[3]: bb[3] = y
        elif isinstance(co, list):
            for c in co:
                walk(c)
    walk(geom.get("coordinates"))


class LRUWriter:
    """ファイルハンドルをLRUで使い回し、各セルへ追記していく。"""
    def __init__(self, outdir, cap=HANDLE_CAP):
        self.outdir = outdir
        self.cap = cap
        self.open = OrderedDict()       # name -> file handle
        self.started = {}               # name -> True（ヘッダ書込済み）
        self.bbox = {}                  # name -> [w,s,e,n]
        self.count = {}                 # name -> 筆数

    def _path(self, name):
        return os.path.join(self.outdir, name + ".geojson")

    def _handle(self, name):
        if name in self.open:
            self.open.move_to_end(name)
            return self.open[name]
        if len(self.open) >= self.cap:
            old, fh = self.open.popitem(last=False)
            fh.close()
        mode = "a" if self.started.get(name) else "w"
        fh = open(self._path(name), mode, encoding="utf-8")
        self.open[name] = fh
        return fh

    def write(self, name, feat_json, geom):
        fh = self._handle(name)
        if not self.started.get(name):
            fh.write('{"type":"FeatureCollection","name":"%s","features":[\n' % name)
            self.started[name] = True
            self.bbox[name] = [180, 90, -180, -90]
            self.count[name] = 0
        else:
            fh.write(",\n")
        fh.write(feat_json)
        update_bbox(self.bbox[name], geom)
        self.count[name] += 1

    def finalize(self):
        # 開いているものを一旦閉じ、各ファイルにフッタを追記
        for fh in self.open.values():
            fh.close()
        self.open.clear()
        for name in self.started:
            with open(self._path(name), "a", encoding="utf-8") as fh:
                fh.write("\n]}\n")


def main():
    ap = argparse.ArgumentParser(description="巨大地番GeoJSONをメッシュ分割＋軽量化")
    ap.add_argument("input", help="入力GeoJSON(EPSG:4326, 1 Feature/行)")
    ap.add_argument("--outdir", default="data/parcels", help="出力フォルダ")
    ap.add_argument("--grid", type=float, default=0.02, help="メッシュ1辺の度数(既定0.02≒2km)")
    ap.add_argument("--precision", type=int, default=6, help="座標の小数桁(既定6≒0.1m)")
    ap.add_argument("--chiban-key", default="地番", help="地番が入っているプロパティ名")
    ap.add_argument("--keep", nargs="*", default=[], help="追加で残すプロパティ名(例: 大字名)")
    ap.add_argument("--min-zoom", type=int, default=15, help="この縮尺以上で地番を表示(オンデマンド開始)")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    # 既存の分割ファイルを掃除（作り直しのため）
    for old in glob.glob(os.path.join(args.outdir, "*.geojson")):
        os.remove(old)

    g = args.grid
    w = LRUWriter(args.outdir)
    total = 0
    skipped = 0

    with open(args.input, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s.startswith('{ "type": "Feature"') and not s.startswith('{"type":"Feature"') \
               and not s.startswith('{ "type":"Feature"'):
                continue
            if s.endswith(","):
                s = s[:-1]
            try:
                feat = json.loads(s)
            except json.JSONDecodeError:
                skipped += 1
                continue
            geom = feat.get("geometry")
            if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
                skipped += 1
                continue

            props = feat.get("properties") or {}
            new_props = {"chiban": str(props.get(args.chiban_key, ""))}
            for k in args.keep:
                if k in props:
                    new_props[k] = props[k]

            geom["coordinates"] = round_coords(geom["coordinates"], args.precision)
            fp = first_point(geom)
            if not fp:
                skipped += 1
                continue
            cx = int(fp[0] // g)
            cy = int(fp[1] // g)
            name = f"r{cy}_c{cx}"   # セル名（行r=緯度, 列c=経度）

            slim = {"type": "Feature", "properties": new_props, "geometry": geom}
            w.write(name, json.dumps(slim, ensure_ascii=False, separators=(",", ":")), geom)
            total += 1
            if total % 50000 == 0:
                print(f"  処理中… {total} 筆", file=sys.stderr)

    w.finalize()

    # index.json を出力（各ファイルの範囲bboxつき）
    files = []
    for name in sorted(w.started):
        bb = [round(v, args.precision) for v in w.bbox[name]]
        files.append({"file": name + ".geojson", "bbox": bb, "count": w.count[name]})

    index = {
        "mode": "ondemand",
        "minZoom": args.min_zoom,
        "grid": g,
        "files": files,
    }
    with open(os.path.join(args.outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)

    # 結果サマリ
    sizes = [os.path.getsize(os.path.join(args.outdir, fi["file"])) for fi in files]
    print(f"完了: {total} 筆 / {len(files)} ファイル（スキップ {skipped}）")
    if sizes:
        print(f"  ファイル容量: 合計 {sum(sizes)/1e6:.1f} MB / 最大 {max(sizes)/1e6:.2f} MB / 平均 {sum(sizes)/len(sizes)/1e3:.0f} KB")
    print(f"  index.json: {os.path.join(args.outdir, 'index.json')}")
    print(f"  → オンデマンド開始ズーム: {args.min_zoom}（これ以上に拡大すると表示範囲の地番が読み込まれます）")


if __name__ == "__main__":
    main()
