# Wall post-processing audit

Production `backend/floorplan_api.py`, calibration, and UI were not edited for this audit. The harness wraps functions in its own Python process, captures deep copies, skips selected call sites for ablations, and restores the original functions. Earlier frontend work remains untouched.

## Inputs, reproduction, and limits

- One source plan is available: `backend/floor.png`, 636 x 820 pixels. Existing debug PNGs are derivatives, not independent test plans. The 12-wall frontend fixture has no associated source image or calibration/reference annotations, so it was not treated as another inference test case.
- Current preprocessing produces 512 x 736 pixels: crop `(67, 15, 512, 736)`, resize factor 1, skew 0 degrees. All reported distances use this processed image, not screenshots or metres.
- Model: `best_v2.pt`, input size 960, CPU, Torch 2.11.0, Ultralytics 8.4.33, Python 3.13.1. Hashes are in `environment.json`. Production SHA256: `8f90dcff86584f76289df52bf303dc2e463025d7e31f51dc1c9560ea7bb7c60c`.
- `ppm=None`, matching the current frontend detection request. No calibration or post-detection UI changes enter the experiment.
- 22 controlled real-plan runs: baseline, repeated baseline, and 20 omission configurations. One frozen set of model boxes, polygons and confidences is reused across configurations. Instrumented and uninstrumented baselines are equal; cached inference replay also reproduces the baseline.
- Six explicit synthetic fixtures plus 100 deterministic randomized finite-coordinate weld checks supplement the real image. These are unit fixtures with specified expected relationships, not additional real floorplans.
- No independently annotated true wall endpoints, junctions, room polygons, or opening hosts are available. Consequently **physical correctness and real-plan false-connection counts remain unverified**. Model-mask agreement and dark-pixel support are diagnostics, not ground truth.

From the repository root:

```powershell
$env:PYTHONIOENCODING='utf-8'
python tools/audit_wall_pipeline.py
# Reuse the exact saved inference instead of invoking the model:
python tools/audit_wall_pipeline.py --reuse-inference
```

## Metrics and interpretation

`baseline.json` contains every before/after normalized segment, per-step pixel measurements, candidate merge/split correspondences, endpoint/span changes, opening metrics, added coverage coordinates and image support. Every ablation JSON also retains the complete call trace and final room/opening output. `stages.csv` is the compact baseline table; `ablations.json` compares final results.

- Sum of segment lengths is distinguished from the length of their geometric union. Duplicate/overlapping walls can inflate the former without repairing anything.
- Connectivity and closed cells are measured on the noded wall-line union, without appending a synthetic outer boundary. Vertices are keyed to 6 decimal pixel places; there is no permissive gap-closing tolerance in this metric.
- The endpoint correspondence matcher is a same-orientation minimum-cost assignment with an 80 px mean-endpoint cutoff. It is **not persistent segment lineage**. In particular, merge/split endpoint changes are changes of representation, not evidence of moved physical walls. Raw coordinates are retained to inspect ambiguity.
- Added/removed coverage is measured outside a 1 px corridor around the other geometry, reducing raster-scale noise. Dark support samples that added coverage against a 3 x 3 dilation of pixels darker than 150. Whitespace, text, furniture, and centerline offsets limit this diagnostic.
- `hausdorff_px` samples line interiors at <=1 px spacing and computes exact point-to-line distances. Sampling can underestimate the continuous maximum by up to 0.5 px. This avoids GEOS's default vertex-only result missing a filled gap. Empty/nonempty comparisons are null.
- Mean best-cell IoU compares each extracted model room mask with its best closed wall cell. It is not an independently labeled accuracy score.
- Opening measurements are center-to-nearest-wall distance and wall-line length inside the detection bbox. A continuous wall through a door/window bbox can be an intended host wall, with a separate opening object; it is **not automatically an occlusion or false connection**. Frontend attachment/cutout behavior is not exercised here.
- Parent events include their nested calls; do not sum their changes twice.

## Exact active order

Line numbers below are call sites in `backend/floorplan_api.py`. Inference wall extraction runs at 1090 and again at 1167; structural classification and `_wall_config` precede repair. `_build_boundary` runs at 1204.

```text
1196 _opening_requires_wall
1210 _close_all_gaps
       864 _snap_merge, when the function reaches its final repair path
1220 _seal_wall_gaps
       630 _snap_merge, only when sealing added walls (not invoked in baseline)
1222 _merge_collinear_walls
1225 _patch_wall_holes
1226 _close_topology_gaps
      3146 _snap_merge
1227 _process_wall_graph
      1823 _snap_merge
      1824 _filter_staircase_walls
      1825 _heal
      1826 _snap_to_structural
      1827 _infer_walls_from_openings
      1833 _bridge_openings
      1834 _snap_anchors
      1835 _snap_merge
      1836 _debug_wall_connectivity (diagnostic)
      1841 _clip_to_boundary
      1842 _filter_structural
      1843 _snap_anchors
      1844 _split_at_junctions
1234 _filter_walls_by_rooms
1236 _heal_wall_corners                 first call
1238 _connect_openings_to_walls
1239 _force_connect_broken
      4652 _snap_merge, conditional (not invoked in baseline)
1241 _extend_walls_at_junctions
1243 _heal_wall_corners                 second call
1245 _restore_verified_yolo_walls
1251 _fill_boundary_gaps
1254 _merge_collinear_walls             late merge
1257 _split_at_junctions
1260 _weld_near_endpoints
1267 _bridge_small_wall_gaps            actual gap_tol <= 0.025
1274 _merge_collinear_walls             final re-merge
1281 _quantize_wall_graph               4 normalized decimal places
1287 _find_unclosed_rooms              diagnostic
1294 _debug_wall_connectivity          diagnostic
```

The room pipeline then polygonizes, cleans and merges cells, validates them, assigns rooms, filters area outliers twice, and ensures coverage. On failure it uses mask-direct or graceful fallback. `_wall_output` runs at 1378. `_split_walls_at_junctions` at 1953 is a separate definition, not the splitter invoked in this run. The actual splitter is `_split_at_junctions` at 2814. Static call inventory is in `static_calls.json`.

## Baseline measurements

| Step | Segments | Summed span change, px | Connectivity / closed cells | Interpretation |
|---|---:|---:|---|---|
| Raw repair input | 45 | — | 5 components, 79 dangling nodes, 5 cells | Starting geometry |
| `_close_all_gaps` including nested snap | 45 -> 29 | -1108.364 | components 5 -> 1; dangling 79 -> 11; cells 5 -> 9 | Adds one 3.833 px segment before `_snap_merge` reduces 46 -> 29. Large changes are mainly snapping/merging, not just the new bridge. |
| `_seal_wall_gaps`; first collinear merge | 29 -> 29 | 0 | unchanged | No geometric effect in baseline |
| `_patch_wall_holes` | 29 -> 35 | +933.888 | components 1 -> 6; dangling 11 -> 23; cells 9 -> 10 | Adds six segments; not a connectivity improvement by itself |
| `_close_topology_gaps` including nested snap | 35 -> 30 | +68.211 | components 6 -> 1; dangling 23 -> 3; cells 10 -> 16 | Adds three segments before nested snap reduces 38 -> 30 |
| Graph processing / first split | 30 -> 63 | 0 | same union, connectivity and cells | Splits add 33 segment records, not physical wall coverage |
| First corner healing | 63 -> 63 | +137.521 | unchanged union, 3 dangling nodes, 16 cells | Five endpoint extensions overlap existing collinear walls |
| Opening connection, force connection, extension, second corner healing, restoration, boundary filling | unchanged | 0 | unchanged | No baseline geometry change |
| Late collinear merge at 1254 | 63 -> 30 | -137.521 | unchanged union and cells | Removes overlapping representation introduced by healing and rejoins split pieces |
| Final split at 1257 | 30 -> 63 | 0 | unchanged | Splitting only |
| Weld; small-gap bridge | 63 -> 63 | 0 | unchanged | No geometric effect |
| Final merge at 1274 | 63 -> 30 | 0 | unchanged union and cells | Recombines split representation |
| Quantization | 30 -> 30 | +0.207 | topology unchanged; closed area +9.47 px² | Maximum matched endpoint movement 0.044 px |

The first healing pass changes exactly these stage-local segments:

| Segment | Moved endpoint | Displacement / span increase, px |
|---|---|---:|
| h25 | end | 22.80835 |
| v0 | end | 33.25417 |
| v2 | start | 33.25417 |
| v10 | start | 33.25417 |
| v16 | end | 14.94998 |

These are confirmed unnecessary **intermediate span increases on this input**: no new union coverage, node repair, room closure, or opening-host improvement accompanies them. Later merging cancels their effect on final geometry. They do not establish that the displayed final wall lengths are wrong.

The closed-cell mask-overlap score increases from 0.186 to 0.544 after early bridge/snap, to 0.590 after hole patching, and to 0.872 after topology repair. This supports their combined topological role but is not independent correctness evidence. The hole-patching addition has 930.30 px outside the prior 1 px corridor and zero dark support under the stated test: that is a review flag, not proof that all those additions are false walls.

## Controlled ablations

Baseline: 30 walls; 1 component; 3 dangling nodes; 31 junctions; 16 closed cells; 293877.46 px² closed area; 9 emitted rooms via polygonize. All 15 door and 7 window detection objects remain identical in every ablation.

| Omission | Final effect versus baseline |
|---|---|
| Weld | Entire wall and room output identical |
| Final merge only | 63 segments instead of 30; same line union, openings, closed cells and emitted rooms |
| Both late merges | 68 segments; same line union, openings and emitted rooms; extra overlaps/segmentation remain |
| Late merge at 1254 only | Entire wall and room output identical; final merge still runs |
| First corner, second corner, or both | Entire wall and room output identical for each ablation |
| Extension; extension plus second corner | Entire wall and room output identical |
| Force connection; small-gap bridge; final split | Entire wall and room output identical for each omission |
| `_close_all_gaps` alone; `_seal_wall_gaps` alone | Entire wall and room output identical for each omission; the other path compensates |
| Both early gap functions | Same wall/cell count, but 5 dangling nodes; sampled Hausdorff 14.94 px; room union symmetric difference 1290.11 px² |
| Nested snap in `_close_all_gaps` only | Same topology but wall/room arrays differ; sampled Hausdorff 0.102 px; closed area +9.03 px² |
| Both early functions' nested snaps | 5 dangling nodes; sampled Hausdorff 14.94 px; room union difference 1178.35 px² |
| Hole patching | 28 walls, 5 dangling nodes, 14 cells; sampled Hausdorff 166.65 px; room pipeline falls back to mask-direct and emits 14 rooms; mask-cell IoU 0.752 |
| Topology-gap repair | 31 walls, 4 dangling nodes, 14 cells, 8 rooms; sampled Hausdorff 21.79 px; mask-cell IoU 0.822 |
| Its nested snap only | Entire wall and room output identical; later graph snapping compensates |

The no-hole-patching result actually has *more* emitted rooms (14 versus 9), despite fewer closed cells and worse model-mask agreement. This is a fallback-mode change, not evidence of improvement. Likewise, preserving wall count when both early gap functions are removed does not preserve geometry or junction quality.

## Openings and closed boundaries

- No tested step changes door/window detection coordinates. Geometry around their bboxes does change.
- Early gap/snap moves `door-30`'s nearest wall from 0 to 5.111 px away and removes all centerline overlap within its narrow bbox. This is a host-alignment regression under this diagnostic, not a confirmed blocked opening.
- Hole patching moves the nearest wall to `window-64` from 59.800 to 4.940 px; following topology repair moves it to 2.470 px and supplies 54.433 px of wall inside its bbox. This supports improved host connectivity locally.
- The same topology repair moves `door-42`'s nearest line from 0.383 to 3.611 px and its bbox line overlap from 42.167 px to zero. Final host alignment needs review; correctness cannot be decided from a bbox alone.
- Removing hole patching improves those particular final opening-center distances while degrading room topology. The tradeoff rules out approving the whole pipeline solely from a single score.
- Corner healing and final re-merging leave the opening-host union measurements unchanged on this plan. Removing final merge still changes wall IDs, segmentation, and potentially per-segment thickness/attachment behavior; no frontend cutout-equivalence claim is made.
- Room-output boundary changes were measured, not inferred visually: removing hole patching changes the emitted room union by 30982.09 px²; removing topology repair by 5265.44 px². Model masks are not physical boundary truth.

## Synthetic findings: confirmed mechanisms

1. **Weld is an identity operation for finite coordinates.** At 2869–2875 every queried coordinate is inserted into its search pool. At 2884–2888 its own candidate gives distance zero; no later candidate can beat it. The intended near-corner fixture does not move. All 100 randomized fixtures (20 segments each) remain unchanged. The real-plan weld omission also produces identical output. This is stronger than merely observing a no-op on one image.
2. **Merge can collapse distinct parallel walls.** Inputs `y=.301` and `.309`, separated by 5.888 px, both fall into the same `round(y / .025)` bucket. Overlapping x-spans `[.1,.4]` and `[.3,.6]` become one `[.1,.6]` segment on `.301`. Two components become one; 153.6 px of the displaced original line lie outside the result's 1 px corridor. This is a confirmed false connection in the explicitly distinct-wall fixture. No evidence yet establishes its frequency in actual plans.
3. **True collinear merging works in its intended case.** With both segments at `y=.3`, their overlap is removed, summed length falls by 51.2 px, and geometric union and topology are exactly preserved. Removing merge altogether would discard this useful behavior.
4. **Merge also performs length filtering.** An isolated, explicitly valid 4.096 px horizontal segment is dropped because its normalized length `.008` is below `MIN_SEG/2 = .009`, despite having no merge partner. The corresponding vertical cutoff is 6.624 px on this image. This behavior should not be confused with duplicate removal.
5. **Corner healing can connect unsupported nearby objects.** With a blank image and explicitly separate H/V segments, the zero-tolerance branch at 3959 accepts the snap without pixel evidence. Endpoints extend by 5.12 and 7.36 px; components fall from 2 to 1. This proves the mechanism, not a real-plan false-connection count.
6. **Small-gap bridging can span an intentional opening.** Two vertical pieces separated by `.02` (14.72 px) acquire a third bridge under the production `.025` bound, joining two components. The function receives neither opening metadata nor an image; the vertical branch lacks the horizontal branch's perpendicular-support checks. This demonstrates loss of the intentional line gap, not necessarily a rendered door occlusion when a separate door cutout exists.

## Ranked conclusions and smallest safe follow-ups

1. **Strongest candidate for a behavior-preserving cleanup:** remove the currently ineffective weld call in a separate change, guarded by identical normalized output and room/opening regression checks. Do not “fix” its nearest-neighbor search at the same time: that would activate previously absent geometry movement.
2. **Smallest targeted behavior fix to evaluate:** require actual collinearity before merging, with the parallel and true-collinear fixtures locked in. Treat short-segment filtering as a separate decision. Validate on annotated plans before changing tolerances or accepting dimensional changes.
3. **Do not remove final merge wholesale.** It currently deduplicates/recombines segments and preserves the real-plan line union, while omission changes identities and wall ownership. First test any proposed change against opening attachment, per-wall thickness, selection, and junction mesh behavior.
4. **Corner/extension redundancy is input-specific.** First corner healing is demonstrably wasteful on this plan; second healing and extension are inactive here. A future targeted guard against extending into already-covered collinear spans is worth testing. This single image does not justify deleting them globally.
5. **Retain early repair pending better evidence.** Individual early-function omissions hide compensation; paired ablations change endpoints and leave two more dangling nodes. Hole patching and topology repair improve closed-cell/model-mask agreement together, but introduce host-alignment tradeoffs and unsupported-centerline candidates.

Before approving broader geometry changes, obtain the additional intended test-plan files and annotations for true centerline endpoints, intended junctions versus close-but-separate walls, opening host spans, and room boundaries. Printed 13.20 m calibration clicks are not needed for this pixel audit, but are needed to connect it to the earlier physical-length report.

The next safe action is to retain these audit fixtures and metrics as a baseline and make only the isolated weld-call cleanup proposal. No production changes were made here.
