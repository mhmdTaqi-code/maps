"""Give every plan building its analysis attributes.

name / osm_kind  : from a named OSM feature whose footprint overlaps the building or whose point lies in it
street, street_kind, street_w : the street/alley the building fronts (nearest centre-line within 18 m)
near, near_d     : nearest named landmark (outside the building itself) and distance in metres
block            : urban block number (buildings touching each other, separated from others by streets)
perim_m          : perimeter in metres

run after vectorize_plan.py / attach_cad.py and before pack_data.py:   python tools/enrich_buildings.py
"""
import json, math, os, re
from shapely.geometry import shape, Point
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(os.path.dirname(HERE), 'data')
KX = 111320 * math.cos(math.radians(33.336)); KY = 110950
tom = lambda g: transform(lambda x, y, z=None: ((x - 44.39) * KX, (y - 33.336) * KY), g)
load = lambda p: json.load(open(p, encoding='utf-8'))
# a real place name: Arabic letters, not a block code like "110-55", and not a bridge (bridges are not buildings/streets here)
REAL = lambda n: bool(n) and re.search('[ء-ي]{3,}', n) and not n[0].isdigit() and not n.startswith('جسر')

files = {n: load(os.path.join(D, n + '.geojson')) for n in ('heritage', 'buildings')}
feats = [f for fc in files.values() for f in fc['features']]
geoms = [tom(shape(f['geometry'])) for f in feats]
tree = STRtree(geoms)

# --- names from OSM
osm = [f for f in load(os.path.join(HERE, 'osm_named_features.geojson'))['features'] if REAL(f['properties']['name'])]
for f in feats:
    for k in ('name', 'osm_kind', 'street', 'street_kind', 'street_w', 'near', 'near_d', 'block', 'perim_m'): f['properties'].pop(k, None)
named = 0
for o in osm:
    g = tom(shape(o['geometry']))
    cands = tree.query(g.buffer(2) if g.geom_type == 'Point' else g)
    best, score = None, 0
    for j in cands:
        b = geoms[j]
        if g.geom_type == 'Point':
            s = 1.0 if b.contains(g) else (0.5 if b.distance(g) < 2 else 0)
        else:
            inter = b.intersection(g).area
            s = max(inter / b.area, inter / max(g.area, 1))
        if s > score: best, score = j, s
    if best is not None and score >= 0.3:
        p = feats[best]['properties']
        if 'name' not in p:
            p['name'] = o['properties']['name']; p['osm_kind'] = o['properties']['kind']; named += 1
        elif o['properties']['name'] not in p['name']:
            p['name'] += ' / ' + o['properties']['name']

# --- fronting street
streets = [f for f in load(os.path.join(D, 'streets.geojson'))['features'] if f['properties'].get('type') == 'centerline']
sgeo = [tom(shape(f['geometry'])) for f in streets]
stree = STRtree(sgeo)
KIND_AR = {'street': 'شارع', 'alley': 'درب', 'lane': 'زقاق ضيّق'}
for f, g in zip(feats, geoms):
    idx = stree.query(g.buffer(18))
    if not len(idx): continue
    j = min(idx, key=lambda j: (g.distance(sgeo[j]) - (3 if streets[j]['properties']['kind'] == 'street' else 0)))
    sp = streets[j]['properties']
    p = f['properties']
    p['street_kind'] = KIND_AR.get(sp['kind'], sp['kind']); p['street_w'] = sp.get('width_m')
    if REAL(sp.get('name')): p['street'] = sp['name']

# --- nearest landmark (named OSM places + named buildings), excluding itself
marks = [(o['properties']['name'], tom(shape(o['geometry'])).representative_point()) for o in osm]
for f, g in zip(feats, geoms):
    own = f['properties'].get('name', '')
    c = g.representative_point()
    best = min(((c.distance(pt), n) for n, pt in marks if n not in own), default=None)
    if best and best[0] < 400: f['properties']['near'] = best[1]; f['properties']['near_d'] = round(best[0])

# --- urban blocks: buildings within 1.2 m of each other belong to the same block
blocks = unary_union([g.buffer(0.6) for g in geoms])
blocks = list(blocks.geoms) if hasattr(blocks, 'geoms') else [blocks]
blocks.sort(key=lambda b: (b.centroid.x * 0.74 - b.centroid.y * 0.67))     # roughly west -> east along the river
btree = STRtree(blocks)
for f, g in zip(feats, geoms):
    c = g.representative_point()
    hit = [i for i in btree.query(c) if blocks[i].contains(c)]
    if hit: f['properties']['block'] = int(hit[0]) + 1
    f['properties']['perim_m'] = round(g.length)

for n, fc in files.items():
    with open(os.path.join(D, n + '.geojson'), 'w', encoding='utf-8') as fh: json.dump(fc, fh, ensure_ascii=False, separators=(',', ':'))
print(f'buildings: {len(feats)}  named from OSM: {named}  with street: {sum("street_kind" in f["properties"] for f in feats)}'
      f'  with landmark: {sum("near" in f["properties"] for f in feats)}  blocks: {len(blocks)}')
