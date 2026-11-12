"""
Put every corridor segment on the real road or rail line.

Road edges are routed along the official National Highway network (MoRTH / PM GatiShakti data),
preferring the NH number the edge is labelled with (e.g. NH10 for Sevoke – Teesta Bazar).
Rail edges are routed along the Indian Railways track network. The resulting polylines and
their true lengths go into backend/data/road_geometry.json, which the server and the web build
use instead of straight town-to-town lines. A result is rejected (straight line kept) if its
length is implausible for the pair of towns.

    python -m tools.snap_corridors --src /tmp/ner-src
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
from collections import defaultdict
from pathlib import Path

from backend.roads import CACHE, haversine_km, simplify

ROOT = Path(__file__).parents[1]
BBOX = (87.4, 21.6, 97.6, 29.7)
NE_STATES = {"Arunachal Pradesh", "Assam", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Sikkim", "Tripura", "West Bengal"}


def norm_ref(r):
    return (r or "").upper().replace(" ", "").replace("-", "")


class LineGraph:
    """Graph of polyline vertices; nearby loose ends are stitched together."""

    def __init__(self, stitch_m=120):
        self.adj = defaultdict(list)     # key -> [(key, km, ref)]
        self.xy = {}
        self.ref_of = defaultdict(set)
        self.ends = []
        self.stitch_km = stitch_m / 1000

    def key(self, c):
        k = (round(c[0], 5), round(c[1], 5))
        self.xy[k] = k
        return k

    def add_line(self, coords, ref=""):
        if len(coords) < 2:
            return
        prev = self.key(coords[0])
        self.ends.append(prev)
        self.ref_of[prev].add(ref)
        for c in coords[1:]:
            k = self.key(c)
            if k != prev:
                d = haversine_km(prev, k)
                self.adj[prev].append((k, d, ref))
                self.adj[k].append((prev, d, ref))
                self.ref_of[k].add(ref)
            prev = k
        self.ends.append(prev)

    def build_index(self, cell=0.02):
        self.cell = cell
        self.grid = defaultdict(list)
        for k in self.xy:
            self.grid[(int(k[0] / cell), int(k[1] / cell))].append(k)
        # stitch loose ends to the nearest other vertex
        for e in self.ends:
            best, bd = None, self.stitch_km
            for k in self.near(e, self.stitch_km):
                if k == e or any(n == k for n, _, _ in self.adj[e]):
                    continue
                d = haversine_km(e, k)
                if d < bd:
                    best, bd = k, d
            if best:
                self.adj[e].append((best, bd, "link"))
                self.adj[best].append((e, bd, "link"))

    def near(self, p, radius_km):
        r = int(radius_km / 111 / self.cell) + 1
        cx, cy = int(p[0] / self.cell), int(p[1] / self.cell)
        for i in range(cx - r, cx + r + 1):
            for j in range(cy - r, cy + r + 1):
                yield from self.grid.get((i, j), ())

    def snap(self, p, radius_km, ref=None):
        """Nearest vertex; if ref is given prefer vertices on that route."""
        best, bd, best_any, bda = None, radius_km, None, radius_km
        for k in self.near(p, radius_km):
            d = haversine_km(p, k)
            if ref and any(norm_ref(r) == ref for r in self.ref_of[k]) and d < bd:
                best, bd = k, d
            if d < bda:
                best_any, bda = k, d
        return (best, bd) if best else (best_any, bda)

    def route(self, a, b, prefer_ref=None, off_ref_penalty=1.6):
        """A* shortest path; edges not on prefer_ref cost more."""
        h = lambda k: haversine_km(k, b)
        dist = {a: 0.0}
        prev = {}
        pq = [(h(a), 0.0, a)]
        seen = set()
        while pq:
            _, g, u = heapq.heappop(pq)
            if u in seen:
                continue
            seen.add(u)
            if u == b:
                break
            for v, km, ref in self.adj[u]:
                w = km if (not prefer_ref or norm_ref(ref) == prefer_ref or ref == "link") else km * off_ref_penalty
                ng = g + w
                if ng < dist.get(v, 1e18):
                    dist[v] = ng
                    prev[v] = u
                    heapq.heappush(pq, (ng + h(v), ng, v))
        if b not in prev and a != b:
            return None
        path = [b]
        while path[-1] != a:
            path.append(prev[path[-1]])
        return [list(p) for p in path[::-1]]


def lines_of(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def inside(c):
    return BBOX[0] <= c[0] <= BBOX[2] and BBOX[1] <= c[1] <= BBOX[3]


def main(src: Path):
    net = json.loads((ROOT / "backend" / "data" / "network.json").read_text())
    nodes = {n["id"]: n for n in net["nodes"]}

    print("building national-highway graph …")
    roads = LineGraph(stitch_m=400)
    for f in json.loads((src / "INDIA_NATIONAL_HIGHWAY.geojson").read_text())["features"]:
        if not f.get("geometry"):
            continue
        ref = (f["properties"].get("Name") or "").strip()
        for line in lines_of(f["geometry"]):
            if any(inside(c) for c in line):
                roads.add_line(line, ref)
    roads.build_index()
    print(f"  {len(roads.xy):,} vertices")

    print("building railway graph …")
    rail = LineGraph(stitch_m=400)
    for f in json.loads((src / "INDIAN_RAILWAYS.geojson").read_text())["features"]:
        if f["properties"].get("STT_NME") not in NE_STATES or not f.get("geometry"):
            continue
        for line in lines_of(f["geometry"]):
            rail.add_line(line, "rail")
    rail.build_index()
    print(f"  {len(rail.xy):,} vertices")

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    ok = rej = 0
    for e in net["edges"]:
        if e["mode"] == "ferry":
            continue
        a, b = nodes[e["source"]], nodes[e["target"]]
        pa, pb = (a["lon"], a["lat"]), (b["lon"], b["lat"])
        straight = haversine_km(pa, pb)
        g = roads if e["mode"] == "road" else rail
        ref = norm_ref(e["route_ref"]) if e["mode"] == "road" and e["route_ref"].startswith("NH") else None
        sa, da = g.snap(pa, 12, ref)
        sb, db = g.snap(pb, 12, ref)
        entry = dict(straight_km=round(straight, 1), source="morth-nh" if e["mode"] == "road" else "indian-railways")
        path = g.route(sa, sb, ref) if sa and sb else None
        if not path:
            entry["rejected"] = f"no connected {'highway' if e['mode'] == 'road' else 'rail'} path near both towns"
        else:
            coords = [[pa[0], pa[1]]] + path + [[pb[0], pb[1]]]      # start and end at the town points
            km = sum(haversine_km(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
            on_ref = None
            if ref:
                on = sum(haversine_km(path[i], path[i + 1]) for i in range(len(path) - 1)
                         if any(norm_ref(r) == ref for r in g.ref_of[tuple(path[i])] & g.ref_of[tuple(path[i + 1])]))
                on_ref = round(on / max(km, 0.01), 2)
            if km > 2.6 * straight + 6 or km < 0.9 * straight:
                entry["rejected"] = f"implausible length {km:.0f} km for {straight:.0f} km straight-line"
            else:
                entry.update(coords=simplify(coords, 0.0003), km=round(km, 1), on_named_route=on_ref,
                             snap_km=[round(da, 2), round(db, 2)])
        # keep an earlier good OSRM result for edges this data can't route
        if entry.get("rejected") and cache.get(e["id"], {}).get("coords"):
            continue
        cache[e["id"]] = entry
        if entry.get("rejected"):
            rej += 1
            print(f"  ✕ {e['id']:16s} {e['route_ref']:12s} {entry['rejected']}")
        else:
            ok += 1
            share = "" if entry["on_named_route"] is None else f"  on {e['route_ref']}: {entry['on_named_route']:.0%}"
            print(f"  ✓ {e['id']:16s} {e['route_ref']:12s} {entry['km']:6.1f} km (est {e['length_km']:5.1f}, straight {straight:5.1f}){share}")
    CACHE.write_text(json.dumps(cache, separators=(",", ":")))
    print(f"\n{ok} snapped, {rej} kept as straight lines → {CACHE} ({CACHE.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/tmp/ner-src")
    main(Path(ap.parse_args().src))
