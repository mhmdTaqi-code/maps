"""Combine CAD (CADMapper / OSM-surveyed) buildings with the plan-derived buildings.

- plan buildings that are ≥50% covered by a CAD building get its `height_m` / `floors`
- CAD buildings outside the study site become the context layer data/context_buildings.geojson

run after tools/vectorize_plan.py and tools/dxf_to_geojson.py:   python tools/attach_cad.py
"""
import json, math, os
from shapely.geometry import shape, mapping
from shapely.strtree import STRtree
from shapely.ops import transform

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'data')
KX = 111320 * math.cos(math.radians(33.336)); KY = 110950
tom = lambda g: transform(lambda x, y, z=None: ((x - 44.39) * KX, (y - 33.336) * KY), g)
def load(n): return json.load(open(os.path.join(D, n), encoding='utf-8'))
def save(n, obj):
    with open(os.path.join(D, n), 'w', encoding='utf-8') as f: json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))

cad = load('cad_buildings.geojson')['features']
# CADMapper writes 3.0 m for every OSM building without a height tag — that is "unknown", not a measurement
DEFAULT_H = 3.0
for f in cad:
    p = f['properties']
    if p['height_m'] == DEFAULT_H: p['height_m'] = None; p['floors'] = None
site = tom(shape(load('site.geojson')['geometry']))
cg = [tom(shape(f['geometry'])) for f in cad]
tree = STRtree(cg)

matched = 0
for name in ('heritage.geojson', 'buildings.geojson'):
    fc = load(name)
    for f in fc['features']:
        p = f['properties']
        for k in ('height_m', 'floors'): p.pop(k, None)
        g = tom(shape(f['geometry']))
        best, cov = None, 0
        for j in tree.query(g):
            c = g.intersection(cg[j]).area / g.area
            if c > cov: best, cov = j, c
        if best is not None and cov >= 0.5 and cad[best]['properties']['floors']:
            p['height_m'] = cad[best]['properties']['height_m']; p['floors'] = cad[best]['properties']['floors']; matched += 1
    save(name, fc)

ctx = [f for f, g in zip(cad, cg) if not g.centroid.within(site.buffer(-5))]
save('context_buildings.geojson', {'type': 'FeatureCollection', 'features': ctx})
print(f'plan buildings with CAD height: {matched}; context buildings outside site: {len(ctx)} of {len(cad)}')
