"""Approximate heritage locations for field mode: one point per heritage group (no boundaries).

Heritage cells that touch each other in the plan become one group; its point is inside the largest cell.
The group keeps the ids of its plan cells (`members`) so field records link back to analysis mode.

run after enrich_buildings.py:   python tools/heritage_points.py
"""
import json, math, os
from shapely.geometry import shape
from shapely.ops import transform, unary_union

D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
KX = 111320 * math.cos(math.radians(33.336)); KY = 110950
tom = lambda g: transform(lambda x, y, z=None: ((x - 44.39) * KX, (y - 33.336) * KY), g)
toll = lambda x, y: [round(44.39 + x / KX, 6), round(33.336 + y / KY, 6)]

feats = json.load(open(os.path.join(D, 'heritage.geojson'), encoding='utf-8'))['features']
geoms = [tom(shape(f['geometry'])) for f in feats]
groups = unary_union([g.buffer(1.0) for g in geoms])
groups = list(groups.geoms) if hasattr(groups, 'geoms') else [groups]
out = []
for grp in groups:
    idx = [i for i, g in enumerate(geoms) if g.representative_point().within(grp)]
    if not idx: continue
    main = max(idx, key=lambda i: geoms[i].area)
    pt = geoms[main].representative_point()
    names = [feats[i]['properties'].get('name') for i in idx if feats[i]['properties'].get('name')]
    out.append({'members': sorted(feats[i]['properties']['id'] for i in idx), 'pt': pt, 'name': names[0] if names else None,
                'area': round(sum(geoms[i].area for i in idx)), 'courtyard': any(feats[i]['properties'].get('courtyard') for i in idx)})
out.sort(key=lambda o: o['pt'].x * 0.74 - o['pt'].y * 0.67)     # west -> east along the river
fc = {'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'properties': {k: v for k, v in {'id': f'HP{k:02d}', 'members': o['members'], 'name': o['name'], 'area_m2': o['area'],
                                                          'courtyard': o['courtyard'] or None}.items() if v is not None},
     'geometry': {'type': 'Point', 'coordinates': toll(o['pt'].x, o['pt'].y)}} for k, o in enumerate(out, 1)]}
with open(os.path.join(D, 'heritage_points.json'), 'w', encoding='utf-8') as fh: json.dump(fc, fh, ensure_ascii=False, separators=(',', ':'))
print(f'heritage cells: {len(feats)} -> approximate heritage points: {len(out)}')
