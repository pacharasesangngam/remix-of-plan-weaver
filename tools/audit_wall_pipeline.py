"""Isolated wall audit. Runtime wrappers only; never edits production code/assets.

Run from the repository root: python tools/audit_wall_pipeline.py
All distances are in processed-image pixels; raw snapshots retain normalized coords.
"""
from __future__ import annotations

import ast
import contextlib
import copy
import csv
import hashlib
import inspect
import io
import json
import platform
import sys
from types import SimpleNamespace
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment
from shapely.geometry import LineString, Point, box
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import floorplan_api as api
import torch
import ultralytics
import shapely

OUT = ROOT / "audit" / "wall_pipeline"
NAMES = """_opening_requires_wall _close_all_gaps _seal_wall_gaps _merge_collinear_walls
_patch_wall_holes _close_topology_gaps _process_wall_graph _snap_merge
_filter_staircase_walls _heal _snap_to_structural _infer_walls_from_openings
_bridge_openings _snap_anchors _clip_to_boundary _filter_structural _split_at_junctions
_filter_walls_by_rooms _heal_wall_corners _connect_openings_to_walls _force_connect_broken
_extend_walls_at_junctions _restore_verified_yolo_walls _fill_boundary_gaps
_weld_near_endpoints _bridge_small_wall_gaps _quantize_wall_graph""".split()
ORIGINAL = {name: getattr(api, name) for name in NAMES}
ROOM_MASKS_PX = []


def dump(path, data):
    path.write_text(json.dumps(data, indent=2, default=lambda v: v.item() if isinstance(v, np.generic) else str(v)), encoding="utf-8")


def snapshot(h, v):
    return copy.deepcopy([h, v])


def segments(state, w, h):
    return ([{"id": f"h{i}", "axis": "h", "p": [s["x1"]*w, s["y"]*h], "q": [s["x2"]*w, s["y"]*h]} for i, s in enumerate(state[0])]
            + [{"id": f"v{i}", "axis": "v", "p": [s["x"]*w, s["y1"]*h], "q": [s["x"]*w, s["y2"]*h]} for i, s in enumerate(state[1])])


def lines(state, w, h):
    return [LineString([s["p"], s["q"]]) for s in segments(state, w, h) if s["p"] != s["q"]]


def line_parts(g):
    if g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    return [p for child in getattr(g, "geoms", []) for p in line_parts(child)]


def graph_stats(g):
    adjacency = {}
    for line in line_parts(g):
        coords = list(line.coords)
        for a, b in zip(coords, coords[1:]):
            a, b = tuple(round(x, 6) for x in a), tuple(round(x, 6) for x in b)
            adjacency.setdefault(a, set()).add(b)
            adjacency.setdefault(b, set()).add(a)
    components, visited = 0, set()
    for node in adjacency:
        if node in visited:
            continue
        components += 1
        stack = [node]
        while stack:
            n = stack.pop()
            if n in visited:
                continue
            visited.add(n)
            stack.extend(adjacency[n] - visited)
    return {"components": components,
            "dangling": [list(p) for p, peers in adjacency.items() if len(peers) == 1],
            "junctions": [list(p) for p, peers in adjacency.items() if len(peers) >= 3]}


def opening_stats(g, openings, w, h):
    result = []
    for op in openings:
        b = op["bbox"]
        x, y, bw, bh = b["x"]*w, b["y"]*h, b["w"]*w, b["h"]*h
        horizontal = bw >= bh
        center = Point(x+bw/2, y+bh/2)
        # A bbox overlap is evidence of wall-host support, NOT an opening occlusion.
        region = box(x, y, x+bw, y+bh)
        overlap = g.intersection(region).length
        result.append({"id": op["id"], "kind": op["audit_kind"], "axis": "h" if horizontal else "v",
                       "center_to_wall_px": center.distance(g), "wall_in_bbox_px": overlap})
    return result


def metrics(state, w, h, openings):
    ls = lines(state, w, h)
    g = unary_union(ls)
    graph = graph_stats(g)
    cells = list(polygonize(g))
    return {"walls": sum(map(len, state)), "sum_span_px": sum(l.length for l in ls),
            "union_span_px": g.length, "components": graph["components"],
            "dangling_count": len(graph["dangling"]), "junction_count": len(graph["junctions"]),
            "cells": len(cells), "closed_area_px2": sum(c.area for c in cells),
            "dangling": graph["dangling"], "junctions": graph["junctions"],
            "cell_areas_px2": sorted(c.area for c in cells),
            "room_mask_best_cell_iou": [max((mask.intersection(c).area / mask.union(c).area for c in cells), default=0) for mask in ROOM_MASKS_PX],
            "openings": opening_stats(g, openings, w, h)}


def sampled_hausdorff(a, b):
    # GEOS's default vertex-only Hausdorff can miss the interior of a filled gap.
    # Sample every <=1 pixel; distance to the opposing geometry is exact.
    if a.is_empty or b.is_empty:
        return 0.0 if a.is_empty and b.is_empty else None
    def directed(source, target):
        points = []
        for line in line_parts(source):
            for t in np.linspace(0, line.length, max(2, int(np.ceil(line.length))+1)):
                p = line.interpolate(t)
                points.append((p.x, p.y))
        return float(np.max(shapely.distance(shapely.points(points), target))) if points else 0.0
    return max(directed(a, b), directed(b, a))


def changes(before, after, w, h, image):
    a, b = segments(before, w, h), segments(after, w, h)
    ga, gb = unary_union(lines(before, w, h)), unary_union(lines(after, w, h))
    # Correspondence is geometric, not persistent lineage. Raw snapshots disambiguate.
    costs = np.full((len(a), len(b)), 1e9)
    candidates = []
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            if x["axis"] != y["axis"]:
                continue
            costs[i, j] = (np.linalg.norm(np.array(x["p"])-y["p"])+np.linalg.norm(np.array(x["q"])-y["q"]))/2
            axis = 0 if x["axis"] == "h" else 1
            overlap = min(x["q"][axis], y["q"][axis])-max(x["p"][axis], y["p"][axis])
            if abs(x["p"][1-axis]-y["p"][1-axis]) <= 3 and overlap > 0.1:
                candidates.append((i, j))
    matches = []
    if len(a) and len(b):
        ri, ci = linear_sum_assignment(costs)
        for i, j in zip(ri, ci):
            if costs[i, j] > 80:
                continue
            x, y = a[i], b[j]
            d1, d2 = np.linalg.norm(np.array(x["p"])-y["p"]), np.linalg.norm(np.array(x["q"])-y["q"])
            if max(d1, d2) > 1e-8:
                matches.append({"before": x["id"], "after": y["id"], "p_displacement_px": d1,
                                "q_displacement_px": d2, "span_delta_px": LineString([y["p"], y["q"]]).length-LineString([x["p"], x["q"]]).length})
    exact = lambda s: (s["axis"], *s["p"], *s["q"])
    ca, cb = Counter(map(exact, a)), Counter(map(exact, b))
    added = gb.difference(ga.buffer(1))
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dark = cv2.dilate((gray < 150).astype(np.uint8), np.ones((3, 3), np.uint8))
    added_parts = []
    for part in line_parts(added):
        samples = [part.interpolate(float(t)) for t in np.linspace(0, part.length, max(2, int(part.length)+1))]
        support = np.mean([dark[min(h-1, max(0, int(p.y))), min(w-1, max(0, int(p.x)))] for p in samples])
        added_parts.append({"coords_px": list(part.coords), "length_px": part.length, "dark_support_fraction_3x3": float(support)})
    split = {a[i]["id"]: [b[j]["id"] for ii, j in candidates if ii == i] for i in range(len(a))}
    merge = {b[j]["id"]: [a[i]["id"] for i, jj in candidates if jj == j] for j in range(len(b))}
    return {"exact_segments_removed_or_changed": sum((ca-cb).values()),
            "exact_segments_added_or_changed": sum((cb-ca).values()),
            "merge_candidates": {k: v for k, v in merge.items() if len(v)>1},
            "split_candidates": {k: v for k, v in split.items() if len(v)>1},
            "unmatched_before": [a[i]["id"] for i in range(len(a)) if not any(ii == i for ii, _ in candidates)],
            "unmatched_after": [b[j]["id"] for j in range(len(b)) if not any(jj == j for _, jj in candidates)],
            "matched_endpoint_changes": matches,
            "max_matched_endpoint_displacement_px": max((max(m["p_displacement_px"],m["q_displacement_px"]) for m in matches), default=0),
            "added_coverage_outside_1px_px": added.length,
            "removed_coverage_outside_1px_px": ga.difference(gb.buffer(1)).length,
            "hausdorff_px": sampled_hausdorff(ga, gb), "added_parts": added_parts}


def run(image, prediction, skip_lines, record=True):
    events, stack = [], []
    def wrap(name, original):
        def wrapped(*args, **kwargs):
            line = inspect.currentframe().f_back.f_lineno
            event = {"sequence": len(events)+1, "function": name, "call_line": line,
                     "depth": len(stack), "before": snapshot(args[0], args[1]), "skipped": line in skip_lines}
            events.append(event)
            stack.append(name)
            if line in skip_lines:
                result = (args[0], args[1])
            else:
                result = original(*args, **kwargs)
            output = result if isinstance(result, tuple) and len(result) == 2 and all(isinstance(x, list) for x in result) else args[:2]
            event["after"] = snapshot(*output)
            stack.pop()
            return result
        return wrapped
    for name, fn in ORIGINAL.items():
        setattr(api, name, wrap(name, fn))
    log = io.StringIO()
    try:
        with contextlib.redirect_stdout(log):
            result = api.build_geometry(image.copy(), prediction, ppm=None, debug_images=None)
    finally:
        for name, fn in ORIGINAL.items():
            setattr(api, name, fn)
    return events, result, log.getvalue()


def state_from_result(result):
    h, v = [], []
    for wall in result["walls"]:
        if wall["y1"] == wall["y2"]:
            h.append({"x1": wall["x1"], "x2": wall["x2"], "y": wall["y1"]})
        else:
            v.append({"x": wall["x1"], "y1": wall["y1"], "y2": wall["y2"]})
    return [h, v]


def synthetic_checks():
    white = np.full((736, 512, 3), 255, dtype=np.uint8)
    cfg = {"snap": 0.025, "merge_gap": 0.04, "connect_gap": 0.05, "thickness": 0.01}
    cases = []
    def case(name, state, fn, meaning):
        before = copy.deepcopy(state)
        with contextlib.redirect_stdout(io.StringIO()):
            after = fn(*copy.deepcopy(state))
        cases.append({"name": name, "fixture_truth": meaning, "before": before, "after": after,
                      "metrics_before": metrics(before,512,736,[]), "metrics_after": metrics(after,512,736,[]),
                      "change": changes(before,after,512,736,white)})
    case("weld_self_candidate", [[{"x1":.1,"x2":.49,"y":.3}], [{"x":.5,"y1":.31,"y2":.7}]],
         lambda h,v: api._weld_near_endpoints(h,v,.025), "Two endpoints 8.97 px apart intended to meet; own values are in snap pools.")
    case("parallel_merge", [[{"x1":.1,"x2":.4,"y":.301},{"x1":.3,"x2":.6,"y":.309}], []],
         lambda h,v: api._merge_collinear_walls(h,v,cfg), "Two distinct parallel segments separated by 5.888 px; not duplicates and must remain separate.")
    case("true_collinear_overlap", [[{"x1":.1,"x2":.4,"y":.3},{"x1":.3,"x2":.6,"y":.3}], []],
         lambda h,v: api._merge_collinear_walls(h,v,cfg), "Overlapping segments on exactly the same axis; union should be preserved and duplication removed.")
    case("short_valid_wall_removed", [[{"x1":.1,"x2":.108,"y":.3}], []],
         lambda h,v: api._merge_collinear_walls(h,v,cfg), "Explicit valid 4.096 px wall; merge function's MIN_SEG/2 filter drops it even without a merge partner.")
    case("blank_corner_false_connection", [[{"x1":.1,"x2":.49,"y":.3}], [{"x":.5,"y1":.31,"y2":.7}]],
         lambda h,v: api._heal_wall_corners(h,v,cfg,image=white), "Explicitly separate objects on blank evidence image; joining them is false in this fixture.")
    case("small_vertical_opening", [[], [{"x":.4,"y1":.1,"y2":.4},{"x":.4,"y1":.42,"y2":.7}]],
         lambda h,v: api._bridge_small_wall_gaps(h,v,gap_tol=.025), "Intentional 14.72 px opening between separate segments. Function receives neither image nor opening metadata.")
    assert cases[0]['before'] == list(cases[0]['after'])
    assert cases[1]['metrics_before']['components'] == 2 and cases[1]['metrics_after']['components'] == 1
    assert abs(cases[2]['metrics_before']['union_span_px'] - cases[2]['metrics_after']['union_span_px']) < 1e-9
    assert len(cases[2]['after'][0]) == 1
    assert cases[3]['metrics_after']['walls'] == 0
    assert cases[4]['metrics_before']['components'] == 2 and cases[4]['metrics_after']['components'] == 1
    assert cases[5]['metrics_before']['components'] == 2 and cases[5]['metrics_after']['components'] == 1
    assert abs(cases[5]['metrics_after']['sum_span_px'] - cases[5]['metrics_before']['sum_span_px'] - 14.72) < 1e-8
    # Property check: for finite coordinates every queried value is in its pool.
    rng = np.random.default_rng(420)
    for _ in range(100):
        hs = [dict(x1=float(x), x2=float(x+.1), y=float(y)) for x,y in rng.uniform(0,.8,(10,2))]
        vs = [dict(x=float(x), y1=float(y), y2=float(y+.1)) for x,y in rng.uniform(0,.8,(10,2))]
        before=copy.deepcopy([hs,vs])
        assert list(api._weld_near_endpoints(hs,vs,.025)) == before
    return cases


def main():
    global ROOM_MASKS_PX
    OUT.mkdir(parents=True, exist_ok=True)
    source = ROOT/"backend"/"floor.png"
    prep = api.preprocess(api.decode_image(source.read_bytes(), source.name))
    image = prep["image"]
    h,w = image.shape[:2]
    if '--reuse-inference' in sys.argv:
        cached=json.loads((OUT/'inference.json').read_text(encoding='utf-8'))
        env=json.loads((OUT/'environment.json').read_text(encoding='utf-8'))
        assert env['source_sha256'] == hashlib.sha256(source.read_bytes()).hexdigest()
        assert env['production_sha256'] == hashlib.sha256(Path(api.__file__).read_bytes()).hexdigest()
        prediction=SimpleNamespace(names={int(k):v for k,v in cached['names'].items()},
            boxes=SimpleNamespace(cls=torch.tensor(cached['classes']),conf=torch.tensor(cached['confidences']),xyxy=torch.tensor(cached['boxes_xyxy'])),
            masks=SimpleNamespace(xy=[np.array(p,dtype=np.float32) for p in cached['masks_xy']]))
    else:
        prediction = api.get_model()(image, imgsz=api.IMG_SIZE, device="cpu", verbose=False)[0]
    # Store input segmentation polygons/confidences, rather than a nonportable torch pickle.
    dump(OUT/"inference.json", {"shape": [h,w], "names": prediction.names, "classes": prediction.boxes.cls.tolist(),
          "confidences": prediction.boxes.conf.tolist(), "boxes_xyxy": prediction.boxes.xyxy.tolist(), "masks_xy": [p.tolist() for p in prediction.masks.xy]})
    from shapely.affinity import scale
    ROOM_MASKS_PX = [scale(m['polygon'], xfact=w, yfact=h, origin=(0,0)) for m in api._extract_room_masks(prediction,w,h)]
    dump(OUT/"environment.json", {"source": str(source.relative_to(ROOT)), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
          "production_sha256": hashlib.sha256(Path(api.__file__).read_bytes()).hexdigest(),
          "model": str(api.MODEL_PATH.relative_to(ROOT)), "model_sha256": hashlib.sha256(api.MODEL_PATH.read_bytes()).hexdigest(),
          "python":platform.python_version(),"torch":torch.__version__,"ultralytics":ultralytics.__version__,
          "preprocessing":{k:v for k,v in prep.items() if k!='image'},"shape":[h,w],"ppm":None,"imgsz":api.IMG_SIZE})
    cases = {"baseline":set(), "repeat_baseline":set(), "no_close_all":{1210}, "no_seal":{1220},
             "no_large_gap_pair":{1210,1220}, "no_corner_first":{1236}, "no_corner_second":{1243},
             "no_corners":{1236,1243}, "no_force":{1239}, "no_extension":{1241},
             "no_extension_second_corner":{1241,1243}, "no_late_merge":{1254}, "no_final_merge":{1274},
             "no_late_merges":{1254,1274}, "no_weld":{1260}, "no_small_bridge":{1267},
             "no_final_split":{1257}, "no_patch_holes":{1225}, "no_close_topology":{1226},
             "no_close_internal_snap":{864}, "no_early_internal_snaps":{864,630},
             "no_topology_internal_snap":{3146}}
    summaries=[]
    baseline=None
    with contextlib.redirect_stdout(io.StringIO()):
        uninstrumented=api.build_geometry(image.copy(),prediction,ppm=None,debug_images=None)
    for name, skip in cases.items():
        events,result,log=run(image,prediction,skip)
        openings=[{**o,"audit_kind":kind} for kind,key in [('door','doors'),('window','windows')] for o in result[key]]
        if baseline is None:
            baseline=result
            assert result == uninstrumented, 'Instrumentation changed production output'
        final=state_from_result(result)
        m=metrics(final,w,h,openings)
        summaries.append({"case":name,"skip_call_lines":sorted(skip),"metrics":m,
                          "same_walls_as_baseline":result['walls']==baseline['walls'],
                          "same_rooms_as_baseline":result['rooms']==baseline['rooms'],
                          "same_openings_as_baseline":all(result[k]==baseline[k] for k in ['doors','windows']),
                          "room_count":len(result['rooms']),"mode":result['meta']['mode'],
                          "delta":changes(state_from_result(baseline),final,w,h,image)})
        (OUT/f"{name}.log").write_text(log,encoding='utf-8')
        if name=='baseline':
            rows=[]
            for event in events:
                event['metrics_before']=metrics(event['before'],w,h,openings)
                event['metrics_after']=metrics(event['after'],w,h,openings)
                event['change']=changes(event['before'],event['after'],w,h,image)
                a,b=event['metrics_before'],event['metrics_after']
                rows.append({'seq':event['sequence'],'step':event['function'],'line':event['call_line'],'depth':event['depth'],
                             **{f'{k}_before':a[k] for k in ['walls','sum_span_px','components','dangling_count','junction_count','cells','closed_area_px2']},
                             **{f'{k}_after':b[k] for k in ['walls','sum_span_px','components','dangling_count','junction_count','cells','closed_area_px2']},
                             **{k:event['change'][k] for k in ['max_matched_endpoint_displacement_px','added_coverage_outside_1px_px','removed_coverage_outside_1px_px']}})
            with (OUT/'stages.csv').open('w',newline='',encoding='utf-8') as f:
                writer=csv.DictWriter(f,fieldnames=rows[0].keys());writer.writeheader();writer.writerows(rows)
        dump(OUT/f'{name}.json',{'events':events,'result':result})
        print(name, 'walls',m['walls'],'components',m['components'],'dangles',m['dangling_count'],'cells',m['cells'],'rooms',len(result['rooms']),flush=True)
    dump(OUT/'ablations.json',summaries)
    ROOM_MASKS_PX=[]
    dump(OUT/'synthetic.json',synthetic_checks())
    dump(OUT/'validation.json',{'instrumented_equals_uninstrumented':True,'weld_random_finite_fixtures_unchanged':100,'synthetic_assertions_passed':True})
    tree=ast.parse(Path(api.__file__).read_text(encoding='utf-8'))
    dump(OUT/'static_calls.json',[{'function':n.name,'line':n.lineno,'calls':[{'name':c.func.id,'line':c.lineno} for c in ast.walk(n) if isinstance(c,ast.Call) and isinstance(c.func,ast.Name) and c.func.id.startswith('_')]} for n in tree.body if isinstance(n,ast.FunctionDef)])
    print('Audit artifacts:',OUT,flush=True)


if __name__=='__main__':
    main()
