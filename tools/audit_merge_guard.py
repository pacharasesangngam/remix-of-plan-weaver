"""Evaluate merge proposals in memory; write only audit artifacts."""
import contextlib
import copy
import difflib
import hashlib
import inspect
import io
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from shapely.ops import unary_union
import audit_wall_pipeline as audit

api = audit.api
OUT = audit.ROOT / "audit" / "merge_guard"
original = api._merge_collinear_walls
source = inspect.getsource(original)
# Exact-axis sub-buckets preserve valid merges even when another parallel wall
# lies between two same-axis pieces in longitudinal sort order.
proposed = source.replace('key = round(seg["y"] / snap)', 'key = (round(seg["y"] / snap), seg["y"])').replace(
    'key = round(seg["x"] / snap)', 'key = (round(seg["x"] / snap), seg["x"])')
predicate_only = source.replace('seg["x1"] <= cur["x2"] + 1e-6',
    'seg["x1"] <= cur["x2"] + 1e-6 and seg["y"] == cur["y"]').replace(
    'if seg["y1"] <= cur["y2"] + 1e-6:', 'if seg["y1"] <= cur["y2"] + 1e-6 and seg["x"] == cur["x"]:')


def compile_function(text):
    namespace = dict(vars(api))
    exec(compile(text, "<audit-only merge proposal>", "exec"), namespace)
    return namespace['_merge_collinear_walls']


def quiet_call(fn, state, cfg):
    with contextlib.redirect_stdout(io.StringIO()):
        return list(fn(*copy.deepcopy(state), cfg))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    production = Path(api.__file__)
    before_hash = hashlib.sha256(production.read_bytes()).hexdigest()
    guarded = compile_function(proposed)
    predicate = compile_function(predicate_only)
    production_text=production.read_text(encoding='utf-8')
    proposal_text=production_text.replace(source,proposed)
    assert proposal_text != production_text
    (OUT/'proposed.diff').write_text(''.join(difflib.unified_diff(production_text.splitlines(True),proposal_text.splitlines(True),
        fromfile='a/backend/floorplan_api.py',tofile='b/backend/floorplan_api.py')),encoding='utf-8')
    cfg = {'snap':.025, 'merge_gap':.04, 'connect_gap':.05, 'thickness':.01}
    white = np.full((736,512,3),255,dtype=np.uint8)
    fixtures=[]
    def test(name,state,expected):
        old=quiet_call(original,state,cfg);new=quiet_call(guarded,state,cfg);pred=quiet_call(predicate,state,cfg)
        assert sum(map(len,new)) == expected,(name,new)
        assert unary_union(audit.lines(state,512,736)).equals(unary_union(audit.lines(new,512,736))),name
        fixtures.append({'name':name,'input':state,'baseline':old,'proposed':new,'predicate_only':pred,
            'baseline_metrics':audit.metrics(old,512,736,[]),'proposed_metrics':audit.metrics(new,512,736,[]),
            'delta':audit.changes(old,new,512,736,white)})
    for axis in ['h','v']:
        def state(items):
            ss=[dict(x1=a,x2=b,y=c) if axis=='h' else dict(y1=a,y2=b,x=c) for a,b,c in items]
            return [ss,[]] if axis=='h' else [[],ss]
        for name,items,expected in [
            ('parallel',[(.1,.4,.301),(.3,.6,.309)],2),
            ('overlap',[(.1,.4,.3),(.3,.6,.3)],1),
            ('touch',[(.1,.4,.3),(.4,.6,.3)],1),
            ('duplicate',[(.1,.4,.3),(.1,.4,.3)],1),
            ('gap',[(.1,.4,.3),(.41,.6,.3)],2),
            ('interleaved',[(.1,.4,.301),(.2,.3,.309),(.35,.6,.301)],2),
            ('tiny_distinct_axis',[(.1,.4,.3),(.3,.6,.30000001)],2),
        ]:
            test(axis+'_'+name,state(items),expected)
    # Preserve existing metadata aggregation and gap_bridge orientation asymmetry.
    metadata_checks=[]
    for axis in ['h','v']:
        a={'x1':.1,'x2':.4,'y':.3} if axis=='h' else {'y1':.1,'y2':.4,'x':.3}
        b={'x1':.3,'x2':.6,'y':.3} if axis=='h' else {'y1':.3,'y2':.6,'x':.3}
        for bridge in [False,True]:
            a.update(t=.01,conf=.4,source='gap_bridge' if bridge else 'inferred')
            b.update(t=.02,conf=.8,source='yolo',is_structural=True)
            s=[[a,b],[]] if axis=='h' else [[],[a,b]]
            assert quiet_call(original,s,cfg)==quiet_call(guarded,s,cfg)
            metadata_checks.append({'axis':axis,'gap_bridge':bridge,'equal':True})
    audit.dump(OUT/'fixtures.json',fixtures)
    # Re-run every original synthetic audit, changing only the runtime function.
    with contextlib.redirect_stdout(io.StringIO()):
        originals=audit.synthetic_checks()
    replay=[]
    for case in originals:
        if case['name'] in ['parallel_merge','true_collinear_overlap','short_valid_wall_removed']:
            updated=quiet_call(guarded,case['before'],cfg)
        else:
            hs,vs=copy.deepcopy(case['before'])
            with contextlib.redirect_stdout(io.StringIO()):
                if case['name']=='weld_self_candidate':
                    updated=api._weld_near_endpoints(hs,vs,.025)
                elif case['name']=='blank_corner_false_connection':
                    updated=api._heal_wall_corners(hs,vs,cfg,image=white)
                else:
                    updated=api._bridge_small_wall_gaps(hs,vs,gap_tol=.025)
            assert list(updated)==list(case['after'])
        replay.append({'name':case['name'],'baseline':case['after'],'proposed':updated,
                       'delta':audit.changes(case['after'],updated,512,736,white)})
    audit.dump(OUT/'audit_fixture_comparison.json',replay)
    p=audit.OUT
    cached=json.loads((p/'inference.json').read_text())
    env=json.loads((p/'environment.json').read_text())
    assert before_hash==env['production_sha256']
    assert hashlib.sha256((audit.ROOT/'backend/floor.png').read_bytes()).hexdigest()==env['source_sha256']
    prediction=SimpleNamespace(names={int(k):v for k,v in cached['names'].items()},
        boxes=SimpleNamespace(cls=torch.tensor(cached['classes']),conf=torch.tensor(cached['confidences']),xyxy=torch.tensor(cached['boxes_xyxy'])),
        masks=SimpleNamespace(xy=[np.array(x,dtype=np.float32) for x in cached['masks_xy']]))
    image=api.preprocess(api.decode_image((audit.ROOT/'backend/floor.png').read_bytes()))['image']
    h,w=image.shape[:2]
    from shapely.affinity import scale
    audit.ROOM_MASKS_PX=[scale(m['polygon'],xfact=w,yfact=h,origin=(0,0)) for m in api._extract_room_masks(prediction,w,h)]
    runs={}
    try:
        for name,fn in [('baseline',original),('proposed',guarded)]:
            # audit.run wraps/restores functions using this registry.
            audit.ORIGINAL['_merge_collinear_walls']=fn
            events,result,log=audit.run(image,prediction,set())
            runs[name]={'events':events,'result':result}
            audit.dump(OUT/(name+'.json'),runs[name])
            (OUT/(name+'.log')).write_text(log,encoding='utf-8')
    finally:
        audit.ORIGINAL['_merge_collinear_walls']=original
        api._merge_collinear_walls=original
    baseline=runs['baseline']['result'];new=runs['proposed']['result']
    assert baseline==json.loads((p/'baseline.json').read_text())['result']
    openings=[{**o,'audit_kind':kind} for kind,key in [('door','doors'),('window','windows')] for o in baseline[key]]
    sa,sb=audit.state_from_result(baseline),audit.state_from_result(new)
    summary={'production_hash_unchanged':before_hash==hashlib.sha256(production.read_bytes()).hexdigest(),
        'fixture_assertions_passed':len(fixtures),'metadata_checks':metadata_checks,
        'walls_identical':baseline['walls']==new['walls'],'rooms_identical':baseline['rooms']==new['rooms'],
        'openings_identical':all(baseline[k]==new[k] for k in ['doors','windows']),
        'baseline_metrics':audit.metrics(sa,w,h,openings),'proposed_metrics':audit.metrics(sb,w,h,openings),
        'geometry_delta':audit.changes(sa,sb,w,h,image),
        'merge_calls':[]}
    old_calls=[e for e in runs['baseline']['events'] if e['function']=='_merge_collinear_walls']
    new_calls=[e for e in runs['proposed']['events'] if e['function']=='_merge_collinear_walls']
    for a,b in zip(old_calls,new_calls):
        summary['merge_calls'].append({'call_line':a['call_line'],'inputs_identical':a['before']==b['before'],
            'outputs_identical':a['after']==b['after'],'before_count':sum(map(len,a['before'])),
            'baseline_after_count':sum(map(len,a['after'])),'proposed_after_count':sum(map(len,b['after']))})
    audit.dump(OUT/'comparison.json',summary)
    print(json.dumps({k:summary[k] for k in ['production_hash_unchanged','fixture_assertions_passed','walls_identical','rooms_identical','openings_identical','merge_calls']},indent=2))
    print('Artifacts:',OUT)


if __name__=='__main__':
    main()
