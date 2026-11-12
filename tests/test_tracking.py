"""Live tracking, truck simulator and road-geometry tests. Run: python -m pytest -q"""
import os
import tempfile

os.environ.setdefault("NER_DB", os.path.join(tempfile.mkdtemp(), "test.db"))
os.environ["NER_ROADS_FETCH"] = "0"
os.environ["NER_FLEET_SIM"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app, engine, fleet  # noqa: E402
from backend.roads import RoadGeometry, haversine_km  # noqa: E402

c = TestClient(app)


def test_demo_fleet_is_tracked():
    f = c.get("/fleet").json()
    vs = {v["vehicle_id"]: v for v in f["vehicles"]}
    assert len(vs) >= 8
    v = vs["TRK-WB07"]
    assert v["lat"] and v["lon"] and v["source"] == "sim"
    assert 0 <= v["progress"] <= 1 and v["eta_h"] is not None


def test_simulator_moves_trucks_along_route():
    before = fleet.detail("TRK-AS01")["progress"]
    fleet.speedup = 600
    fleet.step(10)                                  # 10 s × 600 = 100 simulated minutes
    after = fleet.detail("TRK-AS01")
    assert after["progress"] > before
    assert len(after["trail"]) >= 1 and len(after["route"]) >= 2


def test_truck_holds_before_blocked_segment_and_alerts():
    fleet.v["TRK-WB11"].update(pos_h=0.0, status="moving", source="sim")
    d = fleet.detail("TRK-WB11")
    ahead = [l for l in d["legs"] if l["kind"] == "edge" and l["t0"] > fleet.v["TRK-WB11"]["pos_h"]]
    target = ahead[0]["edge_id"]
    c.post(f"/edges/{target}/status", json={"status": "blocked", "reason": "test"})
    fleet.speedup = 600
    for _ in range(40):
        fleet.step(10)
    v = fleet.detail("TRK-WB11")
    assert v["status"] == "holding" and v["next_hazard"]["blocked"]
    alerts = [e for e in engine.db.server_events_since(0) if e["kind"] == "alert" and e["payload"].get("vehicle_id") == "TRK-WB11"]
    assert alerts
    c.post(f"/edges/{target}/status", json={"status": "open", "reason": "cleared"})
    fleet.step(10)
    assert fleet.detail("TRK-WB11")["status"] in ("moving", "loading", "arrived")


def test_phone_gps_takes_over_from_simulator():
    v = fleet.detail("TRK-TR03")
    lon, lat = v["lon"], v["lat"]
    r = c.post("/vehicles/TRK-TR03/position", json={"lat": lat, "lon": lon, "speed_kmh": 38}).json()
    assert r["source"] == "gps" and r["offroute_km"] < 1
    p = fleet.detail("TRK-TR03")["progress"]
    fleet.step(10)
    assert fleet.detail("TRK-TR03")["progress"] == p       # simulator no longer drives it


def test_unknown_device_position_is_accepted():
    r = c.post("/vehicles/PHONE-1/position", json={"lat": 26.14, "lon": 91.74, "speed_kmh": 0}).json()
    assert r["vehicle_id"] == "PHONE-1" and r["status"] == "stopped"


def test_road_geometry_updates_lengths_and_rejects_bad_snaps(tmp_path):
    net = engine.network
    rg = RoadGeometry(net, cache=tmp_path / "g.json")
    nodes = {n["id"]: n for n in net["nodes"]}

    def fake(e, client):
        a, b = nodes[e["source"]], nodes[e["target"]]
        mid = [(a["lon"] + b["lon"]) / 2 + 0.03, (a["lat"] + b["lat"]) / 2]
        coords = [[a["lon"], a["lat"]], mid, [b["lon"], b["lat"]]]
        km = haversine_km(coords[0], mid) + haversine_km(mid, coords[2])
        if e["id"] == "SLG-SVK":
            km *= 5                                   # implausible detour -> rejected
        return dict(distance=km * 1000, duration=km / 40 * 3600, geometry=dict(coordinates=coords))

    rg._fetch_one = fake
    assert rg.fetch_missing(delay=0, limit=4) == 4
    assert rg.data["SLG-SVK"].get("rejected")
    ok = [k for k, v in rg.data.items() if v.get("coords")]
    assert len(ok) == 3
    engine.roads = rg
    engine.apply_roads()
    e = engine.edges[ok[0]]
    assert e["geometry_source"] == "osrm" and len(e["geometry"]) == 3
    assert engine.edges["SLG-SVK"]["geometry_source"] == "straight"
    net_json = c.get("/network").json()
    assert any(len(x["geometry"]) == 3 for x in net_json["edges"])
    assert c.get("/roads/status").json()["rejected"] == 1
