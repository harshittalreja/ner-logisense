"""Download real road shapes and distances for every road edge from OSRM and cache them.

    python -m tools.fetch_road_geometry

Run once on a machine with internet access (takes ~2 minutes at the demo server's 1 request/second),
then commit backend/data/road_geometry.json so the server never has to fetch them again.
The deployed server does the same thing automatically in the background on first start.
"""
import json
from pathlib import Path

from backend.roads import RoadGeometry

net = json.loads((Path(__file__).parents[1] / "backend" / "data" / "network.json").read_text())
rg = RoadGeometry(net)
before = rg.summary()
print(f"cached: {before['with_road_geometry']} ok, {before['rejected']} rejected, {before['pending']} to fetch")
n = rg.fetch_missing()
after = rg.summary()
print(f"fetched {n}; now {after['with_road_geometry']} ok, {after['rejected']} rejected, {after['pending']} pending")
if after["error"]:
    print("last error:", after["error"])
for eid, d in rg.data.items():
    if d.get("rejected"):
        print(f"  rejected {eid}: {d['rejected']}")
