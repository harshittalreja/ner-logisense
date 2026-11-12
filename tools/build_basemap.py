"""
Build the self-contained basemap for Northeast India (no tile server needed).

Sources (all open data, downloaded once into a working folder, default /tmp/ner-src):
  * National Highways: MoRTH / PM GatiShakti via datta07/INDIAN-SHAPEFILES (INDIA_NATIONAL_HIGHWAY.geojson)
  * Railways: Indian Railways via datta07/INDIAN-SHAPEFILES (INDIAN_RAILWAYS.geojson)
  * State boundaries: datta07/INDIAN-SHAPEFILES (INDIA_STATES.geojson)
  * Neighbouring countries (India point of view), rivers, lakes, towns: Natural Earth 1:10m
  * Label glyphs: OpenMapTiles fonts (Open Sans)

Output (committed, served as static files):
  frontend/basemap/*.geojson   clipped to the region and simplified
  frontend/fonts/<font>/<range>.pbf

    pip install shapely
    python -m tools.build_basemap --src /tmp/ner-src
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).parents[1]
OUT = ROOT / "frontend" / "basemap"
FONTS_OUT = ROOT / "frontend" / "fonts"
BBOX = (87.4, 21.6, 97.6, 29.7)
CLIP = box(*BBOX)
NE_STATES = {"Arunachal Pradesh", "Assam", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Sikkim", "Tripura", "West Bengal", "Bihar"}
FONT_MAP = {"Open Sans Regular": "OpenSans-Regular", "Open Sans Semibold": "OpenSans-Semibold",
            "Open Sans Italic": "OpenSans-Italic", "Open Sans Bold": "OpenSans-Bold"}


def rnd(geom, nd=5):
    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


def write(name, feats):
    fc = {"type": "FeatureCollection", "features": feats}
    p = OUT / f"{name}.geojson"
    p.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"{name:10s} {len(feats):5d} features  {p.stat().st_size / 1024:8.0f} KB")


def clip_simplify(geom, tol):
    g = geom.intersection(CLIP)
    if g.is_empty:
        return None
    g = g.simplify(tol, preserve_topology=True)
    return None if g.is_empty else g


def main(src: Path):
    OUT.mkdir(parents=True, exist_ok=True)
    load = lambda f: json.loads((src / f).read_text())

    # --- neighbouring countries (India drawn from its states)
    feats = []
    for f in load("ne_10m_admin_0_countries_ind.geojson")["features"]:
        name = f["properties"].get("NAME") or f["properties"].get("ADMIN")
        if name == "India":
            continue
        g = clip_simplify(shape(f["geometry"]), 0.01)
        if g:
            c = g.representative_point()
            feats.append({"type": "Feature", "properties": {"name": name, "lx": round(c.x, 3), "ly": round(c.y, 3)}, "geometry": rnd(g, 4)})
    write("countries", feats)

    # --- Indian states
    feats, labels = [], []
    for f in load("INDIA_STATES.geojson")["features"]:
        name = f["properties"].get("STNAME_SH") or f["properties"].get("STNAME", "").title()
        g = clip_simplify(shape(f["geometry"]).buffer(0), 0.004)
        if not g:
            continue
        feats.append({"type": "Feature", "properties": {"name": name}, "geometry": rnd(g, 4)})
        if name in NE_STATES:
            p = g.representative_point()
            labels.append({"type": "Feature", "properties": {"name": name.upper()}, "geometry": {"type": "Point", "coordinates": [round(p.x, 3), round(p.y, 3)]}})
    write("states", feats)
    # country labels: point features
    for f in json.loads((OUT / "countries.geojson").read_text())["features"]:
        labels.append({"type": "Feature", "properties": {"name": f["properties"]["name"].upper(), "country": 1},
                       "geometry": {"type": "Point", "coordinates": [f["properties"]["lx"], f["properties"]["ly"]]}})
    write("regionlabels", labels)

    # --- rivers and lakes
    feats = []
    for f in load("ne_10m_rivers_lake_centerlines.geojson")["features"]:
        g = clip_simplify(shape(f["geometry"]), 0.002)
        if g:
            feats.append({"type": "Feature", "properties": {"name": f["properties"].get("name"), "rank": f["properties"].get("scalerank", 9)}, "geometry": rnd(g, 4)})
    write("rivers", feats)
    feats = []
    for f in load("ne_10m_lakes.geojson")["features"]:
        g = clip_simplify(shape(f["geometry"]), 0.002)
        if g:
            feats.append({"type": "Feature", "properties": {"name": f["properties"].get("name")}, "geometry": rnd(g, 4)})
    write("lakes", feats)

    # --- national highways (MoRTH): merge per NH number, simplify ~30 m
    by_ref: dict[str, list] = {}
    for f in load("INDIA_NATIONAL_HIGHWAY.geojson")["features"]:
        if not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        if not g.intersects(CLIP):
            continue
        ref = (f["properties"].get("Name") or "").strip() or "NH"
        by_ref.setdefault(ref, []).append(g.intersection(CLIP))
    feats = []
    for ref, gs in by_ref.items():
        g = unary_union(gs).simplify(0.0003, preserve_topology=False)
        if g.is_empty:
            continue
        label = ref if ref.upper().startswith("NH") else ""
        feats.append({"type": "Feature", "properties": {"ref": label.replace("NH ", "NH ")}, "geometry": rnd(g, 5)})
    write("highways", feats)

    # --- railways (NE states + North Bengal)
    gs = []
    for f in load("INDIAN_RAILWAYS.geojson")["features"]:
        if f["properties"].get("STT_NME") not in NE_STATES or not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        if g.intersects(CLIP):
            gs.append(g.intersection(CLIP))
    g = unary_union(gs).simplify(0.0005, preserve_topology=False)
    write("railways", [{"type": "Feature", "properties": {}, "geometry": rnd(g, 5)}])

    # --- places: Natural Earth towns + the prototype's own network towns
    places = []
    for f in load("ne_10m_populated_places_simple.geojson")["features"]:
        x, y = f["geometry"]["coordinates"]
        if BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3]:
            p = f["properties"]
            places.append({"name": p["name"], "x": x, "y": y, "rank": 1 if p.get("adm1cap") or p.get("adm0cap") else 2,
                           "pop": p.get("pop_max", 0)})
    net = json.loads((ROOT / "backend" / "data" / "network.json").read_text())
    for n in net["nodes"]:
        if any(abs(p["x"] - n["lon"]) < 0.06 and abs(p["y"] - n["lat"]) < 0.06 for p in places):
            continue
        places.append({"name": n["name"], "x": n["lon"], "y": n["lat"], "rank": 2 if n["kind"] == "hub" else 3, "pop": 0})
    feats = [{"type": "Feature", "properties": {"name": p["name"], "rank": p["rank"]},
              "geometry": {"type": "Point", "coordinates": [round(p["x"], 4), round(p["y"], 4)]}} for p in places]
    write("places", feats)

    # --- fonts
    for src_name, dst_name in FONT_MAP.items():
        s = src / "fonts" / src_name
        if s.exists():
            d = FONTS_OUT / dst_name
            d.mkdir(parents=True, exist_ok=True)
            for pbf in s.glob("*.pbf"):
                shutil.copy(pbf, d / pbf.name)
    print("fonts:", sorted(p.name for p in FONTS_OUT.iterdir()))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/tmp/ner-src")
    main(Path(ap.parse_args().src))
