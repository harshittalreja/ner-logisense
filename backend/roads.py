"""
Real road geometry for every road and rail edge.

Primary source (committed in backend/data/road_geometry.json, built by tools/snap_corridors.py):
the official National Highway network (MoRTH / PM GatiShakti) and the Indian Railways track network.
Fallback for the few road edges that data cannot route: OSRM (OpenStreetMap routing), fetched in
the background at server start when internet access is available.

For each road edge we ask OSRM for the driving route between its two towns and keep:
  * the polyline (simplified to ~60 m), so routes on the map follow the actual highway;
  * the OSM road distance, which replaces the haversine × sinuosity estimate.

Guard rails: a result is rejected (and the straight-line estimate kept) if the OSRM distance is
implausible for that pair of towns, which is what happens when a town coordinate snaps onto the
wrong road. Results are cached in backend/data/road_geometry.json, so the public OSRM demo server
(1 request/second, non-commercial) is only hit once per edge. Commit that file after the first run.

    python -m tools.fetch_road_geometry      # fill the cache from a machine with internet access
"""
from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

import httpx

CACHE = Path(__file__).with_name("data") / "road_geometry.json"
SERVERS = [
    "https://router.project-osrm.org/route/v1/driving/",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving/",
]
USER_AGENT = "NER-LogiSense-prototype/0.4 (student research project)"


def haversine_km(a, b):
    r = 6371.0
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def polyline_km(coords):
    return sum(haversine_km(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def simplify(coords, tol_deg=0.0006):
    """Douglas-Peucker in lon/lat degrees (0.0006° ≈ 60 m); keeps endpoints."""
    if len(coords) < 3:
        return coords

    def perp(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        if dx == dy == 0:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, None
        for k in range(i + 1, j):
            d = perp(coords[k], coords[i], coords[j])
            if d > best:
                best, idx = d, k
        if idx is not None and best > tol_deg:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [[round(c[0], 5), round(c[1], 5)] for c, k in zip(coords, keep) if k]


class RoadGeometry:
    def __init__(self, network: dict, cache: Path = CACHE, on_update=None):
        self.nodes = {n["id"]: n for n in network["nodes"]}
        self.road_edges = [e for e in network["edges"] if e["mode"] == "road"]
        self.all_edges = [e for e in network["edges"] if e["mode"] in ("road", "rail")]
        self.cache = cache
        self.on_update = on_update
        self.data: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.status = dict(running=False, error=None, last_server=None)
        if cache.exists():
            try:
                self.data = json.loads(cache.read_text())
            except Exception:
                self.data = {}

    # ------------------------------------------------------------------ query
    def get(self, edge_id: str):
        d = self.data.get(edge_id)
        return d if d and d.get("coords") else None

    def summary(self):
        ok = sum(1 for e in self.all_edges if self.get(e["id"]))
        rejected = sum(1 for e in self.all_edges if not self.get(e["id"]) and self.data.get(e["id"], {}).get("rejected"))
        sources = {}
        for e in self.all_edges:
            if self.get(e["id"]):
                src = self.data[e["id"]].get("source", "osrm")
                sources[src] = sources.get(src, 0) + 1
        pending = sum(1 for e in self.road_edges if e["id"] not in self.data)
        return dict(total=len(self.all_edges), with_road_geometry=ok, rejected=rejected, pending=pending,
                    sources=sources, **self.status)

    # ------------------------------------------------------------------ fetching
    def _fetch_one(self, e, client):
        a, b = self.nodes[e["source"]], self.nodes[e["target"]]
        path = f"{a['lon']},{a['lat']};{b['lon']},{b['lat']}?overview=full&geometries=geojson&alternatives=false"
        last_err = None
        for base in SERVERS:
            try:
                r = client.get(base + path, timeout=20)
                if r.status_code == 429:
                    time.sleep(3)
                    r = client.get(base + path, timeout=20)
                r.raise_for_status()
                j = r.json()
                if j.get("code") != "Ok" or not j.get("routes"):
                    raise ValueError(j.get("code"))
                self.status["last_server"] = base.split("/")[2]
                return j["routes"][0]
            except Exception as exc:          # try the next server
                last_err = exc
        raise RuntimeError(f"{type(last_err).__name__}: {last_err}")

    def fetch_missing(self, delay: float = 1.1, limit: int | None = None):
        # road edges with no geometry yet; also retry edges the official NH data could not route
        todo = [e for e in self.road_edges if not self.get(e["id"]) and self.data.get(e["id"], {}).get("source") != "osrm"]
        if limit:
            todo = todo[:limit]
        if not todo:
            return 0
        self.status.update(running=True, error=None)
        done = 0
        try:
            with httpx.Client(headers={"User-Agent": USER_AGENT}) as client:
                for i, e in enumerate(todo):
                    try:
                        route = self._fetch_one(e, client)
                    except Exception as exc:
                        self.status["error"] = str(exc)[:200]
                        if done == 0 and i >= 2:      # no network at all: stop quietly
                            break
                        continue
                    a, b = self.nodes[e["source"]], self.nodes[e["target"]]
                    straight = haversine_km([a["lon"], a["lat"]], [b["lon"], b["lat"]])
                    km = route["distance"] / 1000
                    entry = dict(km=round(km, 1), source="osrm", osrm_min=round(route["duration"] / 60, 1),
                                 straight_km=round(straight, 1), fetched_at=time.time())
                    if km > 2.6 * straight + 6 or km < 0.85 * straight:
                        entry["rejected"] = f"implausible distance {km:.0f} km for {straight:.0f} km straight-line"
                    else:
                        entry["coords"] = simplify(route["geometry"]["coordinates"])
                    with self.lock:
                        self.data[e["id"]] = entry
                    done += 1
                    if done % 10 == 0:
                        self.save()
                        if self.on_update:
                            self.on_update()
                    time.sleep(delay)
        finally:
            self.status["running"] = False
            self.save()
            if done and self.on_update:
                self.on_update()
        return done

    def save(self):
        with self.lock:
            try:
                self.cache.write_text(json.dumps(self.data, separators=(",", ":")))
            except OSError:
                pass

    def start_background(self):
        t = threading.Thread(target=self.fetch_missing, daemon=True, name="road-geometry")
        t.start()
        return t
