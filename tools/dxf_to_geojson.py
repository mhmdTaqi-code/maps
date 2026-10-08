#!/usr/bin/env python3
"""Convert CADMapper ASCII DXF layers to GeoJSON without a DXF library."""

import argparse
from collections import Counter, defaultdict
import json
import math
import os
from pathlib import Path
import statistics
import sys
import tempfile

from shapely import make_valid
from shapely.geometry import LineString, MultiPoint, MultiPolygon, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.ops import unary_union


Z_TOL = 0.03
CLOSE_TOL = 0.01
MIN_BUILDING_AREA = 4.0
KX = 111320.0 * math.cos(math.radians(33.336))
KY = 110950.0

OUTPUT_NAMES = {
    "buildings": "cad_buildings.geojson",
    "streets": "cad_streets.geojson",
    "water": "cad_water.geojson",
    "contours": "cad_contours.geojson",
}


class Report:
    def __init__(self):
        self.entities = Counter()
        self.issues = Counter()
        self.examples = defaultdict(list)
        self.saw_entities = False

    def note(self, category, reason, context=""):
        key = (category, reason)
        self.issues[key] += 1
        if context and len(self.examples[key]) < 3:
            self.examples[key].append(str(context)[:200])

    def guard(self, context, operation, *args):
        try:
            operation(*args)
        except Exception as exc:
            self.note(
                "skipped",
                f"{type(exc).__name__}: {str(exc)[:180]}",
                context,
            )


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("non-finite coordinate or numeric value")
    return result


def first(pairs, code, default=None):
    for pair_code, value in pairs:
        if pair_code == code:
            return value
    return default


def required(pairs, code):
    result = first(pairs, code)
    if result is None:
        raise ValueError(f"missing group code {code}")
    return result


def layer_of(pairs, default="0"):
    return first(pairs, 8, default).strip().casefold()


def pair_stream(handle, report):
    """Read physical code/value line pairs; preserve alignment on bad codes."""
    line_number = 0
    while True:
        code_line = handle.readline()
        if not code_line:
            return
        line_number += 1
        value_line = handle.readline()
        if not value_line:
            report.note("parse", "truncated final group-code/value pair",
                        f"line {line_number}")
            return
        line_number += 1
        code_text = code_line.strip()
        if line_number == 2:
            code_text = code_text.lstrip("\ufeff")
        try:
            code = int(code_text)
        except ValueError:
            report.note("parse", "invalid group-code line",
                        f"line {line_number - 1}: {code_text!r}")
            continue
        yield code, value_line.strip()


def entity_stream(handle, report):
    """Yield only group-0-delimited records from ENTITIES sections."""
    in_entities = False
    expect_section_name = False
    current_type = None
    current_pairs = []

    for code, value in pair_stream(handle, report):
        if code == 0:
            if current_type is not None:
                yield current_type, current_pairs
                current_type = None
                current_pairs = []

            token = value.upper()
            expect_section_name = False

            if token == "SECTION":
                in_entities = False
                expect_section_name = True
            elif token == "ENDSEC":
                in_entities = False
            elif token == "EOF":
                return
            elif in_entities:
                current_type = token
            continue

        if expect_section_name and code == 2:
            in_entities = value.upper() == "ENTITIES"
            report.saw_entities |= in_entities
            expect_section_name = False
        elif current_type is not None:
            current_pairs.append((code, value))

    if current_type is not None:
        report.note("parse", "file ended without a DXF EOF record")
        yield current_type, current_pairs


def load_transform(path):
    with path.open("r", encoding="utf-8-sig") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("cad_georef.json must contain a JSON object")
    coefficients = []
    for key in "abcdef":
        value = data[key]
        if isinstance(value, bool):
            raise ValueError(f"invalid georeference coefficient {key}")
        coefficients.append(number(value))
    a, b, c, d, e, f = coefficients
    determinant = a * e - b * d
    if not math.isfinite(determinant) or determinant == 0:
        raise ValueError("georeference affine transform is singular or non-finite")

    def to_lonlat(x, y):
        """Apply the supplied affine transform to every output position."""
        X = a * x + b * y + c
        Y = d * x + e * y + f
        lon = 44.39 + X / KX
        lat = 33.336 + Y / KY
        if not (math.isfinite(lon) and math.isfinite(lat)):
            raise ValueError("non-finite transformed coordinate")
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("transformed coordinate outside lon/lat bounds")
        return round(lon, 7), round(lat, 7)

    return to_lonlat


def polygon_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry] if geometry.area > 0 else []
    parts = []
    for child in getattr(geometry, "geoms", ()):
        parts.extend(polygon_parts(child))
    return parts


def polygon_union(geometries):
    """Repair geometries, discard non-area remnants, and dissolve overlaps."""
    parts = []
    for geometry in geometries:
        parts.extend(polygon_parts(make_valid(geometry)))
    if not parts:
        raise ValueError("geometry has no polygonal area")
    result = make_valid(unary_union(parts))
    parts = polygon_parts(result)
    if not parts:
        raise ValueError("union has no polygonal area")
    result = unary_union(parts)
    if not result.is_valid:
        raise ValueError("polygon union remains invalid after repair")
    return result


def dedupe_xy(vertices):
    result = []
    for vertex in vertices:
        point = (vertex[0], vertex[1])
        if not result or result[-1] != point:
            result.append(point)
    return result


def is_closed(vertices, flags):
    return bool(flags & 1) or (
        len(vertices) > 1
        and math.dist(vertices[0], vertices[-1]) < CLOSE_TOL
    )


def polygon_from_path(vertices):
    points = dedupe_xy(vertices)
    if len(points) > 1 and math.dist(points[0], points[-1]) < CLOSE_TOL:
        points.pop()
    if len(set(points)) < 3:
        raise ValueError("polygon has fewer than three distinct XY vertices")
    return polygon_union([Polygon(points)])


def line_from_path(vertices, closed=False):
    points = dedupe_xy(vertices)
    if len(set(points)) < 2:
        raise ValueError("line has fewer than two distinct XY vertices")
    if closed:
        if math.dist(points[0], points[-1]) < CLOSE_TOL:
            points[-1] = points[0]
        else:
            points.append(points[0])
    return LineString(points)


def geographic_geometry(geometry, transform):
    """Transform all rings and vertices, then enforce GeoJSON winding."""
    def ring(coordinates):
        return [transform(x, y) for x, y in coordinates]

    def polygon(source):
        result = Polygon(
            ring(source.exterior.coords),
            [ring(hole.coords) for hole in source.interiors],
        )
        return orient(result, sign=1.0)

    if geometry.geom_type == "Polygon":
        result = polygon(geometry)
    elif geometry.geom_type == "MultiPolygon":
        result = MultiPolygon([polygon(part) for part in geometry.geoms])
    elif geometry.geom_type == "LineString":
        points = []
        for x, y in geometry.coords:
            point = transform(x, y)
            if not points or points[-1] != point:
                points.append(point)
        if len(set(points)) < 2:
            raise ValueError("line collapsed after coordinate rounding")
        result = LineString(points)
    else:
        raise ValueError(f"unsupported output geometry: {geometry.geom_type}")

    if result.is_empty or not result.is_valid:
        raise ValueError("geometry became empty or invalid after coordinate rounding")
    if result.geom_type != "LineString" and result.area <= 0:
        raise ValueError("polygon collapsed after coordinate rounding")
    return mapping(result)


def mesh_vertices(pairs):
    start = next((i for i, (code, _) in enumerate(pairs) if code == 92), None)
    if start is None:
        raise ValueError("MESH missing vertex count (92)")
    count = int(pairs[start][1])
    cursor = start + 1
    if count < 3 or count > (len(pairs) - cursor) // 3:
        raise ValueError("invalid or truncated MESH vertex count")

    vertices = []
    for _ in range(count):
        vertex = []
        for expected in (10, 20, 30):
            code, value = pairs[cursor]
            cursor += 1
            if code != expected:
                raise ValueError(f"MESH vertex expected group {expected}, got {code}")
            vertex.append(number(value))
        vertices.append(tuple(vertex))
    return vertices, cursor


def mesh_faces(pairs, cursor, vertex_count):
    if cursor >= len(pairs) or pairs[cursor][0] != 93:
        raise ValueError("MESH missing face-list size (93)")
    size = int(pairs[cursor][1])
    cursor += 1
    if size < 0 or size > len(pairs) - cursor:
        raise ValueError("invalid or truncated MESH face-list size")

    face_data = []
    for code, value in pairs[cursor:cursor + size]:
        if code != 90:
            raise ValueError("MESH face-list entry does not use group 90")
        face_data.append(int(value))

    faces = []
    cursor = 0
    while cursor < size:
        count = face_data[cursor]
        cursor += 1
        if count < 3 or count > size - cursor:
            raise ValueError("invalid MESH face vertex count")
        indices = face_data[cursor:cursor + count]
        cursor += count
        if any(index < 0 or index >= vertex_count for index in indices):
            raise ValueError("MESH face index outside vertex list")
        faces.append(indices)
    return faces


def lwpolyline_data(pairs):
    elevation = number(first(pairs, 38, "0"))
    flags = int(first(pairs, 70, "0"))
    vertices = []
    current = None

    def finish_vertex():
        if current is None or 20 not in current:
            raise ValueError("LWPOLYLINE vertex missing X or Y")
        vertices.append((current[10], current[20], elevation))

    for code, value in pairs:
        if code == 10:
            if current is not None:
                finish_vertex()
            current = {10: number(value)}
        elif code == 20:
            if current is None or 20 in current:
                raise ValueError("misordered LWPOLYLINE Y coordinate")
            current[20] = number(value)
        elif code == 42 and number(value) != 0:
            raise ValueError("curved LWPOLYLINE bulge is unsupported")
    if current is not None:
        finish_vertex()

    declared = int(required(pairs, 90))
    if declared != len(vertices):
        raise ValueError("LWPOLYLINE vertex count does not match group 90")
    return vertices, flags, elevation


class Converter:
    def __init__(self, transform, report, derive_street_space=True):
        self.transform = transform
        self.report = report
        self.derive_street_space = derive_street_space
        self.features = {name: [] for name in OUTPUT_NAMES}
        self.street_polygons = []
        self.heights = []
        self.building_number = 0

    def add(self, output, geometry, properties):
        geographic = geographic_geometry(geometry, self.transform)
        self.features[output].append({
            "type": "Feature",
            "properties": properties,
            "geometry": geographic,
        })

    def building(self, pairs, cid):
        vertices, cursor = mesh_vertices(pairs)
        z_values = [vertex[2] for vertex in vertices]
        ground = min(z_values)
        height = round(max(z_values) - ground, 1)

        try:
            faces = mesh_faces(pairs, cursor, len(vertices))
        except Exception as exc:
            self.report.note("warning", "invalid face list; trying bottom hull",
                             f"{cid}: {exc}")
            faces = []

        caps = []
        for indices in faces:
            face = [vertices[index] for index in indices]
            face_z = [vertex[2] for vertex in face]
            if max(face_z) - min(face_z) <= Z_TOL:
                caps.append(Polygon([(x, y) for x, y, _ in face]))

        try:
            footprint = polygon_union(caps)
            if footprint.geom_type != "Polygon":
                raise ValueError("cap union has disconnected polygon components")
        except Exception as exc:
            bottom = [
                (x, y) for x, y, z in vertices
                if abs(z - ground) <= Z_TOL
            ]
            footprint = MultiPoint(bottom).convex_hull
            if footprint.geom_type != "Polygon" or not footprint.is_valid:
                raise ValueError("cap union and bottom-ring hull both failed") from exc
            self.report.note("fallback", "building used bottom-ring convex hull",
                             f"{cid}: {exc}")

        if footprint.area < MIN_BUILDING_AREA:
            self.report.note("skipped", "building footprint below 4 m²",
                             f"{cid}: {footprint.area:.3f} m²")
            return

        self.add("buildings", footprint, {
            "cid": cid,
            "height_m": height,
            "floors": max(1, round(height / 3.2)),
            "ground_z": round(ground, 1),
            "area_m2": int(round(footprint.area)),
        })
        self.heights.append(height)

    def path(self, layer, vertices, flags, elevation=None):
        if not vertices:
            raise ValueError("path has no vertices")
        closed = is_closed(vertices, flags)

        if layer == "outline":
            if closed:
                geometry = polygon_from_path(vertices)
                parts = polygon_parts(geometry)
                if len(parts) > 1:
                    self.report.note(
                        "repair", "closed outline split into multiple polygons"
                    )
                for part in parts:
                    self.add("streets", part, {"kind": "street_edge_area"})
                    self.street_polygons.append(part)
            else:
                self.add(
                    "streets",
                    line_from_path(vertices),
                    {"kind": "street_edge"},
                )

        elif layer in ("water", "parks"):
            if not closed:
                self.report.note(
                    "assumption", "open water/parks boundary explicitly closed", layer
                )
            geometry = polygon_from_path(vertices)
            for part in polygon_parts(geometry):
                self.add("water", part, {"layer": layer})

        elif layer == "contours":
            if elevation is None:
                values = [vertex[2] for vertex in vertices]
                if max(values) - min(values) > Z_TOL:
                    raise ValueError("contour has inconsistent vertex elevations")
                elevation = statistics.median(values)
            self.add(
                "contours",
                line_from_path(vertices, closed),
                {"elev_m": elevation},
            )
        else:
            self.report.note("ignored", "path layer not requested", layer)

    def finish_polyline(self, pending, terminated):
        pairs, vertex_records = pending
        layer = layer_of(pairs)
        if not terminated:
            self.report.note("warning", "POLYLINE missing SEQEND", layer)

        if layer not in ("outline", "water", "parks", "contours"):
            self.report.note("ignored", "POLYLINE layer not requested", layer)
            return

        flags = int(first(pairs, 70, "0"))
        if flags & (16 | 64):
            raise ValueError("polygon-mesh/polyface POLYLINE is unsupported")

        vertices = []
        for record in vertex_records:
            # The POLYLINE header's dummy 10/20/30 is deliberately unused.
            if number(first(record, 42, "0")) != 0:
                raise ValueError("curved POLYLINE bulge is unsupported")
            vertices.append(tuple(number(required(record, code))
                                  for code in (10, 20, 30)))
        self.path(layer, vertices, flags)

    def handle_mesh(self, pairs):
        layer = layer_of(pairs)
        if layer != "buildings":
            self.report.note("ignored", "MESH layer not requested", layer)
            return
        self.building_number += 1
        cid = f"C{self.building_number:04d}"
        self.report.guard(cid, self.building, pairs, cid)

    def handle_lwpolyline(self, pairs):
        layer = layer_of(pairs)
        if layer not in ("outline", "water", "parks", "contours"):
            self.report.note("ignored", "LWPOLYLINE layer not requested", layer)
            return
        vertices, flags, elevation = lwpolyline_data(pairs)
        self.path(layer, vertices, flags, elevation)

    def read(self, handle):
        pending = None
        record_number = 0

        for entity_type, pairs in entity_stream(handle, self.report):
            record_number += 1
            inherited_layer = (
                layer_of(pending[0])
                if pending is not None and entity_type in ("VERTEX", "SEQEND")
                else "0"
            )
            layer = layer_of(pairs, inherited_layer)
            self.report.entities[(layer, entity_type)] += 1
            context = f"record {record_number}, {entity_type}, layer {layer}"

            if pending is not None:
                if entity_type == "VERTEX":
                    pending[1].append(pairs)
                    continue
                self.report.guard(
                    f"POLYLINE on {layer_of(pending[0])}",
                    self.finish_polyline,
                    pending,
                    entity_type == "SEQEND",
                )
                pending = None
                if entity_type == "SEQEND":
                    continue

            if entity_type == "POLYLINE":
                pending = (pairs, [])
            elif entity_type == "MESH":
                self.report.guard(context, self.handle_mesh, pairs)
            elif entity_type == "LWPOLYLINE":
                self.report.guard(context, self.handle_lwpolyline, pairs)
            elif entity_type in ("VERTEX", "SEQEND"):
                self.report.note("skipped", f"orphan {entity_type}", context)
            else:
                self.report.note("unknown", f"unsupported entity {entity_type}",
                                 context)

        if pending is not None:
            self.report.guard(
                f"POLYLINE on {layer_of(pending[0])}",
                self.finish_polyline,
                pending,
                False,
            )
        if not self.report.saw_entities:
            raise ValueError("no ENTITIES section found")

    def build_street_space(self):
        if not self.derive_street_space:
            return
        if not self.street_polygons:
            self.report.note("skipped", "street_space: no usable closed outlines")
            return
        geometry = polygon_union(self.street_polygons)
        multi = MultiPolygon(polygon_parts(geometry))
        self.add("streets", multi, {
            "kind": "street_space",
            "assumption": "closed_outlines_are_road_surfaces",
        })

    def summary(self, destination):
        print("Input ENTITIES counts:")
        layers = sorted({layer for layer, _ in self.report.entities})
        for layer in layers:
            counts = {
                entity_type: count
                for (record_layer, entity_type), count
                in self.report.entities.items()
                if record_layer == layer
            }
            detail = ", ".join(f"{name}={count}"
                               for name, count in sorted(counts.items()))
            print(f"  {layer}: {sum(counts.values())} records ({detail})")

        print(f"Outputs: {destination}")
        for output, filename in OUTPUT_NAMES.items():
            features = self.features[output]
            types = Counter(feature["geometry"]["type"] for feature in features)
            labels = Counter(
                feature["properties"].get(
                    "kind", feature["properties"].get("layer", output)
                )
                for feature in features
            )
            print(f"  {filename}: {len(features)} features; "
                  f"geometry={dict(types)}; layers/kinds={dict(labels)}")

        if self.heights:
            print(
                "Building heights, exported features (m): "
                f"min={min(self.heights):.1f}, "
                f"median={statistics.median(self.heights):.1f}, "
                f"max={max(self.heights):.1f}"
            )
        else:
            print("Building heights: no buildings exported")

        if self.derive_street_space:
            print("Street-space assumption: closed outline rings describe road "
                  "surfaces; street_space is their dissolved union.")
        else:
            print("Derived street_space disabled.")

        print("Diagnostics (counts are events; one entity may have several):")
        if not self.report.issues:
            print("  none")
        for key, count in sorted(self.report.issues.items()):
            category, reason = key
            print(f"  [{category}] {count}: {reason}")
            for example in self.report.examples[key]:
                print(f"    example: {example}")


def write_collection(path, features):
    """Atomically replace each completed output file."""
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(
                {"type": "FeatureCollection", "features": features},
                handle,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            handle.write("\n")
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dxf", type=Path, help="CADMapper ASCII DXF file")
    parser.add_argument(
        "--no-street-space",
        action="store_true",
        help="omit the derived street_space union when outlines are not road surfaces",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    georef_path = repo_root / "tools" / "cad_georef.json"
    output_directory = repo_root / "data"

    try:
        transform = load_transform(georef_path)
        report = Report()
        converter = Converter(transform, report, not args.no_street_space)

        # UTF-8 also reads ASCII; replacement tolerates irrelevant legacy text.
        # Universal-newline mode handles CRLF and LF.
        with args.dxf.open("r", encoding="utf-8-sig", errors="replace") as handle:
            converter.read(handle)

        report.guard("derived street_space", converter.build_street_space)
        output_directory.mkdir(parents=True, exist_ok=True)
        for output, filename in OUTPUT_NAMES.items():
            write_collection(
                output_directory / filename, converter.features[output]
            )
        converter.summary(output_directory)
        return 0
    except (OSError, ValueError, KeyError, TypeError, OverflowError) as exc:
        print(f"Fatal: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
