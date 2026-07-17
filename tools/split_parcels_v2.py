#!/usr/bin/env python3
# =====================================================================
# split_parcels_v2.py
#   split_parcels.py (v1) の改良版。v1 は「筆の最初の頂点」だけでファイルを
#   振り分けていたため、1筆が複数メッシュにまたがる場合に片方からしか
#   見えない（境界の反対側からは欠けて見える）ことがあった。
#
#   v2 の変更点:
#     1. セル割り当てを「筆ポリゴンの外接矩形(bbox)が重なる全セル」に変更。
#        1筆が複数セルにまたがる場合は、該当する全ファイルに同じ筆データを
#        含める（重複を許容する）。
#     2. 固定グリッドではなく quadtree式の可変分割:
#          grid(既定0.02) → 筆数500超なら grid/2(既定0.01) → まだ500超なら
#          grid/4(既定0.005、下限。これ以上は分割しない)。
#        筆数0のセルはファイル・index.jsonエントリとも出力しない。
#        あるセルが分割された場合、そのセル自身のファイルは出力しない
#        （リーフセルのみが出力される。親子が同時に出力されることはない）。
#     3. index.json の各ファイルエントリに、そのファイル固有の grid 値を
#        持たせる（旧来のトップレベル grid 単一値を廃止）。
#
#   処理は2パス構成。332MBのファイルを2回ストリーム読込するが、
#   メモリに保持するのは「セルID→筆数」の小さな辞書のみで、
#   筆データそのものを全件展開することはない。
#
#     Pass 1: 各筆のbboxが、grid / grid/2 / grid/4 の3段階それぞれで
#             重なるセルを求め、セルごとの筆数をカウントする（筆データ自体は
#             捨てる）。3段階を同時にカウントすることで、後段の分割要否判定
#             のために元データを読み直す必要がない。
#     （カウント確定後、メモリ上だけでリーフセルの集合を決定）
#     Pass 2: 確定したリーフセル一覧をもとに、各筆のbboxが重なる全リーフへ
#             実際にデータを書き込む（1筆が複数リーフに書かれる＝重複を許容）。
#
#   注意（二重計上について）:
#     あるセルを分割するかどうかの判定は、そのセル自身のカウント値でのみ
#     行う。4子セルの筆数合計は、境界をまたぐ筆が複数の子に重複計上される
#     ため、親セルの実筆数より多くなり得るが、これは想定内の挙動であり、
#     子セルの500超判定は子セル自身のカウント値に対して独立に行う
#     （親の値で補正・按分するようなことはしない）。
#
#   使い方の例:
#     python3 tools/split_parcels_v2.py data/source/44205__2_r_2025.geojson \
#         --outdir data/parcels --grid 0.02 --min-grid 0.005 --max-count 1500 \
#         --precision 6 --chiban-key 地番 --keep 大字名 --min-zoom 15
# =====================================================================
import argparse, json, os, sys, glob, time
from collections import OrderedDict

HANDLE_CAP = 200   # 同時に開くファイル数の上限（OSのfd枯渇を防ぐ）


def round_coords(obj, p):
    if isinstance(obj, list):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], p), round(obj[1], p)]
        return [round_coords(x, p) for x in obj]
    return obj


def feature_bbox(geom):
    """ジオメトリ全体（Polygon/MultiPolygon、穴を含む）の外接矩形を返す"""
    xs, ys = [], []
    def walk(co):
        if co and isinstance(co[0], (int, float)):
            xs.append(co[0]); ys.append(co[1])
        elif isinstance(co, list):
            for c in co:
                walk(c)
    walk(geom.get("coordinates"))
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def cells_overlapping(bbox, grid):
    """bbox=(xmin,ymin,xmax,ymax) が重なる grid セルの (row,col) を全列挙する"""
    xmin, ymin, xmax, ymax = bbox
    c0, c1 = int(xmin // grid), int(xmax // grid)
    r0, r1 = int(ymin // grid), int(ymax // grid)
    return [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


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
    """ファイルハンドルをLRUで使い回し、各セルへ追記していく。
    1筆が複数セルへ書かれる場合は write() を複数回呼び出す想定。"""
    def __init__(self, outdir, cap=HANDLE_CAP):
        self.outdir = outdir
        self.cap = cap
        self.open = OrderedDict()
        self.started = {}
        self.bbox = {}
        self.count = {}

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
        for fh in self.open.values():
            fh.close()
        self.open.clear()
        for name in self.started:
            with open(self._path(name), "a", encoding="utf-8") as fh:
                fh.write("\n]}\n")


def iter_features(path):
    """332MBファイルを1行ずつストリームし、(feature dict, 生JSON文字列) をyieldする。
    地番以外(Polygon/MultiPolygon以外)やパース不能な行は (None, 生テキスト) を返す。"""
    with open(path, encoding="utf-8") as f:
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
                yield None, s
                continue
            geom = feat.get("geometry")
            if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
                yield None, s
                continue
            yield feat, s


def main():
    ap = argparse.ArgumentParser(description="巨大地番GeoJSONをquadtree分割＋軽量化(v2: bbox全重なり出力)")
    ap.add_argument("input", help="入力GeoJSON(EPSG:4326, 1 Feature/行)")
    ap.add_argument("--outdir", default="data/parcels", help="出力フォルダ")
    ap.add_argument("--grid", type=float, default=0.02, help="初期メッシュ1辺の度数(既定0.02)")
    ap.add_argument("--min-grid", type=float, default=0.005, help="分割の下限(既定0.005=grid/4)")
    ap.add_argument("--max-count", type=int, default=1500, help="このセルの筆数を超えたら分割(既定1500)")
    ap.add_argument("--precision", type=int, default=6, help="座標の小数桁(既定6≒0.1m)")
    ap.add_argument("--chiban-key", default="地番", help="地番が入っているプロパティ名")
    ap.add_argument("--keep", nargs="*", default=[], help="追加で残すプロパティ名(例: 大字名)")
    ap.add_argument("--min-zoom", type=int, default=15, help="この縮尺以上で地番を表示(オンデマンド開始)")
    args = ap.parse_args()

    GRID0 = args.grid
    GRID1 = GRID0 / 2
    GRID2 = GRID1 / 2
    if abs(GRID2 - args.min_grid) > 1e-9:
        sys.exit(
            f"エラー: --grid を2回半分にした値({GRID2})が --min-grid({args.min_grid})と"
            f"一致しません。本スクリプトは grid → grid/2 → grid/4 の固定2段階分割のみ対応します。"
        )

    os.makedirs(args.outdir, exist_ok=True)
    for old in glob.glob(os.path.join(args.outdir, "*.geojson")):
        os.remove(old)

    t_start = time.time()

    # ===== Pass 1: 3段階同時カウント（筆データ自体は保持しない） =====
    counts0, counts1, counts2 = {}, {}, {}
    total_features = 0
    skipped = 0
    for feat, raw in iter_features(args.input):
        if feat is None:
            skipped += 1
            continue
        bbox = feature_bbox(feat["geometry"])
        if not bbox:
            skipped += 1
            continue
        total_features += 1
        for (r, c) in cells_overlapping(bbox, GRID0):
            counts0[(r, c)] = counts0.get((r, c), 0) + 1
        for (r, c) in cells_overlapping(bbox, GRID1):
            counts1[(r, c)] = counts1.get((r, c), 0) + 1
        for (r, c) in cells_overlapping(bbox, GRID2):
            counts2[(r, c)] = counts2.get((r, c), 0) + 1
        if total_features % 50000 == 0:
            print(f"  Pass1処理中… {total_features} 筆", file=sys.stderr)

    t_pass1 = time.time()

    # ===== リーフセルの確定（メモリ上のみ、ファイル再読込なし） =====
    # leaves[(level, r, c)] = そのセルのgrid値。level=0,1,2。
    # あるセルがここに登録されたら、その親・祖先セルは絶対に登録されない
    # （if/continue の排他制御のため、親子が同時に出力されることはない）。
    leaves = {}
    for (r0, c0), cnt0 in counts0.items():
        if cnt0 <= args.max_count:
            leaves[(0, r0, c0)] = GRID0
            continue
        for (r1, c1) in ((2*r0, 2*c0), (2*r0, 2*c0+1), (2*r0+1, 2*c0), (2*r0+1, 2*c0+1)):
            cnt1 = counts1.get((r1, c1), 0)
            if cnt1 <= 0:
                continue
            if cnt1 <= args.max_count:
                leaves[(1, r1, c1)] = GRID1
                continue
            for (r2, c2) in ((2*r1, 2*c1), (2*r1, 2*c1+1), (2*r1+1, 2*c1), (2*r1+1, 2*c1+1)):
                cnt2 = counts2.get((r2, c2), 0)
                if cnt2 <= 0:
                    continue
                leaves[(2, r2, c2)] = GRID2   # 下限: 500超でも分割しない

    def leaf_name(level, r, c):
        return f"r{r}_c{c}_L{level}"

    name_to_grid = {leaf_name(level, r, c): g for (level, r, c), g in leaves.items()}

    # ===== Pass 2: 実書き込み（bboxが重なる全リーフへ、重複許容） =====
    w = LRUWriter(args.outdir)
    total_written = 0
    total_source_feats = 0
    unmatched = 0

    for feat, raw in iter_features(args.input):
        if feat is None:
            continue
        geom = feat["geometry"]
        bbox = feature_bbox(geom)
        if not bbox:
            continue
        total_source_feats += 1

        cand0 = cells_overlapping(bbox, GRID0)
        cand1 = cells_overlapping(bbox, GRID1)
        cand2 = cells_overlapping(bbox, GRID2)

        matched = set()
        for (r0, c0) in cand0:
            if (0, r0, c0) in leaves:
                matched.add((0, r0, c0))
                continue
            for (r1, c1) in cand1:
                if not (r1 in (2*r0, 2*r0+1) and c1 in (2*c0, 2*c0+1)):
                    continue
                if (1, r1, c1) in leaves:
                    matched.add((1, r1, c1))
                    continue
                for (r2, c2) in cand2:
                    if not (r2 in (2*r1, 2*r1+1) and c2 in (2*c1, 2*c1+1)):
                        continue
                    if (2, r2, c2) in leaves:
                        matched.add((2, r2, c2))

        if not matched:
            unmatched += 1
            continue

        geom["coordinates"] = round_coords(geom["coordinates"], args.precision)
        props = feat.get("properties") or {}
        new_props = {"chiban": str(props.get(args.chiban_key, ""))}
        for k in args.keep:
            if k in props:
                new_props[k] = props[k]
        slim = {"type": "Feature", "properties": new_props, "geometry": geom}
        slim_json = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))

        for (level, r, c) in matched:
            w.write(leaf_name(level, r, c), slim_json, geom)
            total_written += 1

        if total_source_feats % 50000 == 0:
            print(f"  Pass2処理中… {total_source_feats} 筆", file=sys.stderr)

    w.finalize()
    t_pass2 = time.time()

    # ===== index.json =====
    files = []
    for name in sorted(w.started):
        bb = [round(v, args.precision) for v in w.bbox[name]]
        files.append({
            "file": name + ".geojson",
            "bbox": bb,
            "count": w.count[name],
            "grid": name_to_grid[name],
        })

    index = {
        "mode": "ondemand",
        "minZoom": args.min_zoom,
        "gridLevels": [GRID0, GRID1, GRID2],
        "files": files,
    }
    with open(os.path.join(args.outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)

    # ===== ログ出力 =====
    counts_per_file = sorted(w.count.values())
    n = len(counts_per_file)
    median = counts_per_file[n // 2] if n % 2 == 1 else (counts_per_file[n//2 - 1] + counts_per_file[n//2]) / 2 if n else 0
    over_threshold = sum(1 for c in counts_per_file if c > args.max_count)
    dup_ratio = total_written / total_source_feats if total_source_feats else 0

    print()
    print(f"完了: 総筆数(重複なし) {total_source_feats} 筆 / 総ファイル数 {len(files)}")
    print(f"  延べ書き込み件数(重複込み): {total_written} 件 / 総筆数比: {dup_ratio:.4f} 倍")
    print(f"  Pass1でのスキップ行数: {skipped}（非Feature行・非Polygon等）")
    print(f"  マッチ先リーフが見つからなかった筆: {unmatched} 件（本来発生しないはず。0以外なら要確認）")
    if counts_per_file:
        print(f"  筆数分布: 最小={counts_per_file[0]} 最大={counts_per_file[-1]} 中央値={median} "
              f"/ {args.max_count}超のセル数={over_threshold}（下限gridでのみ発生しうる）")
    print(f"  処理時間: Pass1 {t_pass1 - t_start:.1f}秒 / Pass2 {t_pass2 - t_pass1:.1f}秒 / "
          f"合計 {t_pass2 - t_start:.1f}秒")
    print(f"  index.json: {os.path.join(args.outdir, 'index.json')}")


if __name__ == "__main__":
    main()
