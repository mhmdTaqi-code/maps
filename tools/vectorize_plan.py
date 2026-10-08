"""Vectorize the conservation site plan (data/plan.webp) into GIS layers.

Every building is a closed cell of the line drawing; brown-filled cells are heritage buildings;
the big connected white region is the street / alley network. Cells are traced to polygons,
courtyards become holes, the street space is skeletonised into centre-lines, and everything is
georeferenced with the transform in tools/fit.json (fitted against real footprints / satellite).

usage (from the repo root):  python tools/vectorize_plan.py
"""
import json, math, os, re, sys
import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import box, mapping, Polygon, MultiPolygon, LineString, shape
from shapely.ops import unary_union, transform as shp_transform
from shapely.validation import make_valid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
D = os.path.join(ROOT, 'data')

# ------------------------------------------------------------------ georeference
tx, ty, rot, s1, s2, sh = json.load(open(os.path.join(HERE, 'fit.json')))
KX = 111320 * math.cos(math.radians(33.336)); KY = 110950
cr, sr = math.cos(math.radians(rot)), math.sin(math.radians(rot))
def px2ll(x, y, z=None):
    x = np.asarray(x, float); y = np.asarray(y, float)
    u, v = x * s1 + (-y) * sh, -y * s2
    X, Y = tx + u * cr - v * sr, ty + u * sr + v * cr
    return 44.39 + X / KX, 33.336 + Y / KY
PX_AREA = s1 * s2                        # m² per pixel
to_ll = lambda g: shp_transform(px2ll, g)
def metric_area(g): return g.area * PX_AREA

# ------------------------------------------------------------------ masks
a = np.array(Image.open(os.path.join(D, 'plan.webp')).convert('RGB')).astype(int)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
H, W = R.shape
lum = .299 * R + .587 * G + .114 * B
brown = (R > 85) & (R - G > 35) & (R - B > 55) & (G < 120) & (G > 30)
bluish = (B - R > 14) & ~brown            # river + the area outside the study site
bluish[:60, 1150:1320] = True             # north arrow
line = (lum < 175) & ~brown
# thicken outlines by 1 px so hairline gaps do not let a building leak into the street
barrier = ndimage.binary_dilation(line) | bluish
free = ~barrier
lab, n = ndimage.label(free)              # 4-connectivity
sizes = ndimage.sum(free, lab, range(n + 1)); sizes[0] = 0
STREET = int(np.argmax(sizes))

# give outline pixels to the nearest region (cells share walls, streets meet buildings at the line)
dist, (iy, ix) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
grown = lab[iy, ix]
grown[(dist > 2.6) | bluish] = 0

# ------------------------------------------------------------------ classify cells
objs = ndimage.find_objects(grown)
brown_frac = ndimage.mean(brown, grown, range(n + 1))
ring_struct = np.ones((7, 7), bool)
info, dropped = {}, {'tiny': 0, 'outside': 0, 'riverfront': 0}
for i, sl in enumerate(objs, 1):
    if sl is None or i == STREET: continue
    m = grown[sl] == i
    cnt = int(m.sum())
    if cnt * PX_AREA < 8: dropped['tiny'] += 1; continue
    cy, cx = ndimage.center_of_mass(m); cy += sl[0].start; cx += sl[1].start
    if cx < 62 or cx > 1488: dropped['outside'] += 1; continue
    if cy > 596: dropped['riverfront'] += 1; continue
    # neighbours across the wall
    pad = 4
    y0, y1 = max(sl[0].start - pad, 0), min(sl[0].stop + pad, H)
    x0, x1 = max(sl[1].start - pad, 0), min(sl[1].stop + pad, W)
    mm = grown[y0:y1, x0:x1] == i
    ring = ndimage.binary_dilation(mm, ring_struct) & ~mm
    nb = grown[y0:y1, x0:x1][ring]
    blu = bluish[y0:y1, x0:x1][ring].mean()
    if blu > 0.25: dropped['outside'] += 1; continue
    ids, counts = np.unique(nb[nb > 0], return_counts=True)
    info[i] = dict(cnt=cnt, cx=cx, cy=cy, heritage=brown_frac[i] >= 0.5, nb=dict(zip(ids.tolist(), counts.tolist())))

# courtyard = cell whose only neighbour is one other (non-street) building cell
court_of = {}
for i, c in info.items():
    nbs = [k for k in c['nb'] if k != i]
    if len(nbs) == 1 and nbs[0] != STREET and nbs[0] in info and info[nbs[0]]['cnt'] > c['cnt'] * 1.3:
        court_of[i] = nbs[0]
# a courtyard of a courtyard (nested drawing) belongs to the outer building
for i in list(court_of):
    k = court_of[i]
    while k in court_of: k = court_of[k]
    court_of[i] = k
buildings = [i for i in info if i not in court_of]
print(f'cells: {len(info)}  buildings: {len(buildings)}  courtyards: {len(court_of)}  dropped: {dropped}')

# ------------------------------------------------------------------ trace
def trace(mask, x0, y0, fill_small=12):
    """mask -> shapely polygon(s) in image px; holes smaller than fill_small px are filled."""
    if fill_small:
        holes = ndimage.binary_fill_holes(mask) & ~mask
        hl, hn = ndimage.label(holes)
        if hn:
            hs = ndimage.sum(holes, hl, range(1, hn + 1))
            small = np.isin(hl, np.nonzero(hs < fill_small)[0] + 1)
            mask = mask | small
    boxes = []
    for r in range(mask.shape[0]):
        d = np.diff(np.concatenate([[0], mask[r].astype(np.int8), [0]]))
        for st, en in zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]):
            boxes.append(box(x0 + st, y0 + r, x0 + en, y0 + r + 1))
    g = unary_union(boxes).simplify(0.75, preserve_topology=True)
    g = make_valid(g)
    if g.geom_type == 'GeometryCollection':
        g = unary_union([p for p in g.geoms if p.geom_type in ('Polygon', 'MultiPolygon')])
    return g

children = {}
for i, k in court_of.items(): children.setdefault(k, []).append(i)

feats_h, feats_b = [], []
for i in buildings:
    sl = objs[i - 1]
    m = grown[sl] == i
    # courtyards are excluded from the mask, so they come out as holes; don't fill them
    g = trace(m, sl[1].start, sl[0].start, fill_small=12)
    if g.is_empty: continue
    if isinstance(g, MultiPolygon):        # keep the main part, drop crumbs
        g = max(g.geoms, key=lambda p: p.area)
    area = metric_area(g)
    if area < 8: continue
    court_area = sum(info[c]['cnt'] for c in children.get(i, [])) * PX_AREA
    rec = dict(geom=g, cx=info[i]['cx'], area=round(area), courtyard=court_area > 10, heritage=info[i]['heritage'])
    (feats_h if rec['heritage'] else feats_b).append(rec)

def rnd(o):
    if isinstance(o, float): return round(o, 7)
    if isinstance(o, (list, tuple)): return [rnd(x) for x in o]
    if isinstance(o, dict): return {k: rnd(v) for k, v in o.items()}
    return o
def dump(name, fc):
    with open(os.path.join(D, name), 'w', encoding='utf-8') as f:
        json.dump(rnd(fc), f, ensure_ascii=False, separators=(',', ':'))

def fc_buildings(recs, prefix, width):
    recs.sort(key=lambda r: r['cx'])
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'id': f'{prefix}{k:0{width}d}', 'area_m2': r['area'], 'courtyard': r['courtyard'], 'src': 'plan'},
         'geometry': mapping(to_ll(r['geom']))} for k, r in enumerate(recs, 1)]}
dump('heritage.geojson', fc_buildings(feats_h, 'H', 3))
dump('buildings.geojson', fc_buildings(feats_b, 'B', 4))

# ------------------------------------------------------------------ streets
street = (grown == STREET)
street[597:, :] = False                      # corniche promenade below the riverfront road stays out
street[:, :55] = street[:, 1500:] = False
street = ndimage.binary_opening(street, iterations=1)
street_poly = trace(street, 0, 0, fill_small=40)

def zhang_suen(img):
    img = img.copy().astype(np.uint8)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2, p3, p4, p5 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:]
            p6, p7, p8, p9 = P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2]
            nbrs = [p2, p3, p4, p5, p6, p7, p8, p9]
            Bn = sum(x.astype(int) for x in nbrs)
            seq = nbrs + [p2]
            A = sum(((seq[k] == 0) & (seq[k + 1] == 1)).astype(int) for k in range(8))
            if step == 0: c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:         c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            rm = (img == 1) & (Bn >= 2) & (Bn <= 6) & (A == 1) & c
            if rm.any(): img[rm] = 0; changed = True
    return img.astype(bool)

# fill small islands (parked cars, kiosks, text) so the skeleton does not loop around them
islands = ndimage.binary_fill_holes(street) & ~street
il, inn = ndimage.label(islands)
small = np.isin(il, np.nonzero(ndimage.sum(islands, il, range(1, inn + 1)) < 150)[0] + 1) if inn else islands
skel = zhang_suen(street | small)
dt = ndimage.distance_transform_edt(street, sampling=(s2, s1))   # metres to nearest building

# skeleton -> line network. Link 4-neighbours always, diagonals only where no orthogonal step
# exists, so staircase pixels do not create fake junctions; then merge and prune dangling spurs.
from shapely.ops import linemerge
sk = skel
segs = []
ys, xs = np.nonzero(sk)
on = lambda y, x: 0 <= y < H and 0 <= x < W and sk[y, x]
for y, x in zip(ys.tolist(), xs.tolist()):
    if on(y, x + 1): segs.append(((x, y), (x + 1, y)))
    if on(y + 1, x): segs.append(((x, y), (x, y + 1)))
    if on(y + 1, x + 1) and not on(y, x + 1) and not on(y + 1, x): segs.append(((x, y), (x + 1, y + 1)))
    if on(y + 1, x - 1) and not on(y, x - 1) and not on(y + 1, x): segs.append(((x, y), (x - 1, y + 1)))
def mlen(ls):
    c = ls.coords
    return sum(math.hypot((b[0] - a_[0]) * s1, (b[1] - a_[1]) * s2) for a_, b in zip(c[:-1], c[1:]))
net = [LineString(sg) for sg in segs]
for _ in range(8):
    m = linemerge(net); net = list(m.geoms) if hasattr(m, 'geoms') else [m]
    ends = {}
    for ls in net:
        for e in (ls.coords[0], ls.coords[-1]): ends[e] = ends.get(e, 0) + 1
    keep = []
    for ls in net:
        d0, d1 = ends[ls.coords[0]] == 1, ends[ls.coords[-1]] == 1
        if (d0 or d1) and not (d0 and d1) and mlen(ls) < 7: continue   # spur off a junction
        if d0 and d1 and mlen(ls) < 6: continue                       # isolated crumb
        keep.append(ls)
    if len(keep) == len(net): break
    net = keep
m = linemerge(net); net = list(m.geoms) if hasattr(m, 'geoms') else [m]
lines = []
for ls in net:
    L = mlen(ls)
    if L < 3: continue
    w = float(np.median([dt[min(int(y), H - 1), min(int(x), W - 1)] for x, y in ls.coords])) * 2
    lines.append((LineString([(x + .5, y + .5) for x, y in ls.coords]).simplify(1.0), w, L))

# name from OSM: nearest roughly-parallel named way
osm = [f for f in json.load(open(os.path.join(HERE, 'osm_named_streets.geojson'), encoding='utf-8'))['features'] if re.search('[ء-ي]{3,}', f['properties'].get('name') or '') and not f['properties']['name'][0].isdigit()]
def ll2px_metric(lon, lat):  # lon/lat -> local metric
    return ((lon - 44.39) * KX, (lat - 33.336) * KY)
osm_m = [(f['properties']['name'], LineString([ll2px_metric(*c) for c in f['geometry']['coordinates']])) for f in osm]
def to_metric(g): return shp_transform(lambda x, y, z=None: ll2px_metric(*px2ll(x, y)), g)
cl_feats = []
for ls, w, L in lines:
    lm = to_metric(ls)
    name = None
    if L > 15:
        mid = lm.interpolate(.5, normalized=True)
        cand = [(o.distance(mid), nm) for nm, o in osm_m if o.distance(mid) < 10]
        if cand: name = min(cand)[1]
    kind = 'street' if w >= 8 else 'alley' if w >= 3 else 'lane'
    cl_feats.append({'type': 'Feature', 'properties': {'type': 'centerline', 'kind': kind, 'width_m': round(w, 1), 'length_m': round(L), 'name': name},
                     'geometry': mapping(to_ll(ls))})
area_feats = []
for p in (street_poly.geoms if hasattr(street_poly, 'geoms') else [street_poly]):
    if metric_area(p) > 30:
        area_feats.append({'type': 'Feature', 'properties': {'type': 'area'}, 'geometry': mapping(to_ll(p))})
dump('streets.geojson', {'type': 'FeatureCollection', 'features': area_feats + cl_feats})

# ------------------------------------------------------------------ site outline
allg = unary_union([r['geom'] for r in feats_h + feats_b] + [street_poly])
site = allg.buffer(3).buffer(-3).simplify(2)
if isinstance(site, MultiPolygon): site = max(site.geoms, key=lambda p: p.area)
site = Polygon(site.exterior)
dump('site.geojson', {'type': 'Feature', 'properties': {'name': 'حدود السايت'}, 'geometry': mapping(to_ll(site))})

# ------------------------------------------------------------------ self-checks + summary
allpolys = [r['geom'] for r in feats_h + feats_b]
invalid = sum(not p.is_valid for p in allpolys)
from shapely.strtree import STRtree
tree = STRtree(allpolys)
overlap = 0.0
for k, p in enumerate(allpolys):
    for j in tree.query(p):
        if j > k: overlap += p.intersection(allpolys[j]).area
uncovered = site.difference(unary_union(allpolys + [street_poly]))
kinds = {}
for f in cl_feats: kinds[f['properties']['kind']] = kinds.get(f['properties']['kind'], 0) + 1
print(f"heritage: {len(feats_h)} ({sum(r['area'] for r in feats_h)} m²)  buildings: {len(feats_b)} ({sum(r['area'] for r in feats_b)} m²)")
print(f"buildings with courtyard: {sum(r['courtyard'] for r in feats_h + feats_b)}  centre-lines: {len(cl_feats)} {kinds}  named: {sum(1 for f in cl_feats if f['properties']['name'])}")
print(f"street area: {round(metric_area(street_poly))} m²  site area: {round(metric_area(site))} m²")
print(f"invalid polygons: {invalid}  overlap between buildings: {overlap * PX_AREA:.1f} m²  uncovered inside site: {metric_area(uncovered):.0f} m²")

# ------------------------------------------------------------------ diagnostic render
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(W / 50, H / 50), dpi=100)
ax.imshow(np.array(Image.open(os.path.join(D, 'plan.webp')).convert('L')), cmap='gray', alpha=.45)
def draw(g, **kw):
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        ax.plot(*p.exterior.xy, **kw)
        for r in p.interiors: ax.plot(*r.xy, color='#00b050', lw=1.1)
for r in feats_b: draw(r['geom'], color='#1f5fd6', lw=.7)
for r in feats_h: draw(r['geom'], color='#e0201a', lw=1.1)
for ls, w, L in lines:
    ax.plot(*ls.xy, color='#d000d0' if w >= 3 else '#ff7ad9', lw=1.3 if w >= 8 else .9)
ax.plot(*site.exterior.xy, color='orange', lw=1.2, ls='--')
ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis('off')
plt.savefig(os.path.join(HERE, 'check_vectorize.png'), bbox_inches='tight', dpi=100)
print('wrote data/heritage.geojson, data/buildings.geojson, data/streets.geojson, data/site.geojson, tools/check_vectorize.png')
