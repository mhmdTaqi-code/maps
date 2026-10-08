"""Pack the generated GeoJSON layers into the compact .json files the web app loads.

6-decimal coordinates (~10 cm — finer than the source drawing), only the properties the app reads,
and `.json` names so GitHub Pages serves them gzip-compressed.

pipeline:  vectorize_plan.py -> dxf_to_geojson.py -> attach_cad.py -> pack_data.py
"""
import json, os

D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
KEEP = {
    'heritage': ('id', 'area_m2', 'courtyard', 'floors', 'height_m', 'name', 'osm_kind', 'street', 'street_kind', 'street_w', 'near', 'near_d', 'block', 'perim_m'),
    'buildings': ('id', 'area_m2', 'courtyard', 'floors', 'height_m', 'name', 'osm_kind', 'street', 'street_kind', 'street_w', 'near', 'near_d', 'block', 'perim_m'),
    'streets': ('type', 'kind', 'width_m', 'length_m', 'name'),
    'site': ('name',),
    'landmarks': ('name', 'name_en', 'kind'),
    'context_buildings': ('floors', 'height_m'),
    'cad_contours': ('elev_m',),
}

def rnd(c):
    return round(c, 6) if isinstance(c, float) else [rnd(x) for x in c]

from shapely.geometry import shape, mapping
TOL = 0.000003   # ~0.3 m: removes staircase vertices from pixel tracing without changing the outline

def slim(f, keep):
    props = {k: v for k, v in f.get('properties', {}).items() if k in keep and v not in (None, False, '')}
    g = f['geometry']
    if g['type'] in ('Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'):
        sg = shape(g).simplify(TOL, preserve_topology=True)
        if not sg.is_empty: g = mapping(sg)
    return {'type': 'Feature', 'properties': props, 'geometry': {'type': g['type'], 'coordinates': rnd(g['coordinates'])}}

total_in = total_out = 0
for name, keep in KEEP.items():
    src = os.path.join(D, name + '.geojson')
    if not os.path.exists(src): print('missing', src); continue
    obj = json.load(open(src, encoding='utf-8'))
    out = slim(obj, keep) if obj.get('type') == 'Feature' else {'type': 'FeatureCollection', 'features': [slim(f, keep) for f in obj['features']]}
    dst = os.path.join(D, name + '.json')
    with open(dst, 'w', encoding='utf-8') as fh: json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    a, b = os.path.getsize(src), os.path.getsize(dst)
    total_in += a; total_out += b
    print(f'{name:18s} {a/1024:7.0f} KB -> {b/1024:6.0f} KB')
print(f'total {total_in/1024:.0f} KB -> {total_out/1024:.0f} KB')
