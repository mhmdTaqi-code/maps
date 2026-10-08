"""Build data/places.json: OSM-located places + knowledge base (gpt-6-astra) + connection axes / triangle.

usage: python tools/build_places.py <places_input.json> <astra_knowledge.json> [<geocoded_missing.json>]
  places_input.json   : [{name, name_en, kind, lat, lon, inside_site, distance_from_site_m, ...}] (from OSM)
  astra_knowledge.json: {"places": [...], "axes": [...], "triangle": {...}, "missing_places": [...]}
  geocoded_missing    : optional [{name, lat, lon}] for missing_places that were located (e.g. via Nominatim)
Walking time = straight distance × 1.25 (street detour) at 75 m/min.
"""
import json, math, os, sys
from shapely.geometry import shape, Point, Polygon
from shapely.ops import transform, nearest_points

HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(os.path.dirname(HERE), 'data')
KX = 111320 * math.cos(math.radians(33.336)); KY = 110950
tom = lambda g: transform(lambda x, y, z=None: ((x - 44.39) * KX, (y - 33.336) * KY), g)
toll = lambda x, y: (33.336 + y / KY, 44.39 + x / KX)                      # metric -> (lat, lon)
walk = lambda d: round(d * 1.25 / 75, 1)

inp = json.load(open(sys.argv[1], encoding='utf-8'))
kb = json.load(open(sys.argv[2], encoding='utf-8'))
extra = json.load(open(sys.argv[3], encoding='utf-8')) if len(sys.argv) > 3 else []
site = tom(shape(json.load(open(os.path.join(D, 'site.json'), encoding='utf-8'))['geometry']))
know = {k['name']: k for k in kb['places']}

places = []
def add(name, lat, lon, base):
    pt = tom(Point(lon, lat)); d = 0 if pt.within(site) else round(site.exterior.distance(pt))
    k = know.get(name, {})
    places.append({'name': name, 'name_en': base.get('name_en'), 'lat': lat, 'lon': lon, 'inside': d == 0, 'dist_m': d, 'walk_min': walk(d),
                   'category': k.get('category', 'other'), 'era': k.get('era') if k.get('era') not in (None, 'null') else None,
                   'built': k.get('built'), 'summary_ar': k.get('summary_ar'), 'site_relevance_ar': k.get('site_relevance_ar'),
                   'analysis_value': k.get('analysis_value', 'low'), 'confidence': k.get('confidence', 'low'), 'osm': base.get('osm'),
                   'sources': k.get('sources') or None})
for p in inp: add(p['name'], p['lat'], p['lon'], p)
missing_kb = {m['name']: m for m in kb.get('missing_places', [])}
for e in extra:
    m = missing_kb.get(e['name'], {})
    know.setdefault(e['name'], {'category': e.get('category', 'other'), 'summary_ar': m.get('why_ar'), 'site_relevance_ar': m.get('where_ar'),
                                'analysis_value': 'high', 'confidence': m.get('confidence', 'low')})
    add(e['name'], e['lat'], e['lon'], {'osm': e.get('osm')})
by = {p['name']: p for p in places}
unknown = [k for k in know if k not in by]

def pt_of(name, toward=None):
    """coordinates (lat, lon) of a named place; 'السايت' = the site edge point nearest to `toward`."""
    if name in by: return (by[name]['lat'], by[name]['lon'])
    if 'السايت' in name or 'الموقع' in name:
        ref = tom(Point(toward[1], toward[0])) if toward else site.centroid
        q = nearest_points(site.exterior, ref)[0]; return toll(q.x, q.y)
    return None
def mdist(a, b): return tom(Point(a[1], a[0])).distance(tom(Point(b[1], b[0])))

axes, dropped = [], []
for a in kb.get('axes', []):
    to = pt_of(a['to']); fr = pt_of(a['from'], toward=to)
    vias = [v for v in (pt_of(x) for x in a.get('via', [])) if v]
    if not (fr and to): dropped.append(a['name_ar']); continue
    coords = [fr, *vias, to]
    L = sum(mdist(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
    axes.append({**a, 'coords': [[round(c[0], 6), round(c[1], 6)] for c in coords], 'length_m': round(L), 'walk_min': walk(L)})

tri = kb.get('triangle')
if tri:
    others = [pt_of(v) for v in tri['vertices'] if pt_of(v) and 'السايت' not in v]
    ref = (sum(o[0] for o in others) / len(others), sum(o[1] for o in others) / len(others)) if others else None
    coords = [pt_of(v, toward=ref) for v in tri['vertices']]
    if all(coords) and len(coords) == 3:
        mp = Polygon([tom(Point(c[1], c[0])).coords[0] for c in coords])
        tri = {**tri, 'coords': [[round(c[0], 6), round(c[1], 6)] for c in coords], 'perimeter_m': round(mp.length), 'area_m2': round(mp.area)}
    else:
        dropped.append('triangle'); tri = None

out = {'places': places, 'axes': axes, 'triangle': tri, 'source': 'locations: OpenStreetMap (ODbL); descriptions: gpt-6-astra knowledge base, unverified'}
with open(os.path.join(D, 'places.json'), 'w', encoding='utf-8') as f: json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print(f"places: {len(places)} (with description: {sum(1 for p in places if p['summary_ar'])}, high value: {sum(p['analysis_value'] == 'high' for p in places)})"
      f"  axes: {len(axes)}  triangle: {'yes' if tri else 'no'}  dropped: {dropped}  kb names not located: {unknown[:10]}")
