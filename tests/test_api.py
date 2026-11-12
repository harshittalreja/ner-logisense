"""End-to-end API tests. Run: pytest -q"""
import os
import tempfile
import time
import uuid

import pytest

os.environ["NER_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["NER_SEED_DEMO"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app, engine  # noqa: E402

c = TestClient(app)


def set_scenario(name):
    assert c.post("/weather/scenario", json={"scenario": name}).status_code == 200


def test_health_and_network():
    assert c.get("/health").json()["ok"]
    n = c.get("/network").json()
    assert len(n["nodes"]) > 80 and len(n["edges"]) > 100
    assert {"fastest", "balanced", "safest", "emergency"} <= set(n["profiles"])


def test_seeded_demo_shipments():
    s = c.get("/shipments").json()
    assert len(s) >= 4
    assert all(x["status"] == "in_transit" for x in s)


def test_hazard_rises_with_rain():
    set_scenario("dry_winter")
    dry = c.get("/risk/edge/SVK-TBZ").json()["p_now"]
    set_scenario("teesta_extreme")
    wet = c.get("/risk/edge/SVK-TBZ").json()
    assert wet["p_now"] > dry * 5
    assert wet["level"] == "high"
    assert any("threshold" in r for r in wet["explanation"]["reasons"])
    assert [f["h"] for f in wet["forecast"]] == [0, 6, 12, 24]


def test_route_avoids_teesta_in_cloudburst():
    set_scenario("teesta_extreme")
    r = c.post("/route/optimize", json={"origin": "SLG", "destination": "GTK", "cargo_type": "pharma",
                                        "deadline_h": 10}).json()
    assert r["recommended"] != "fastest"
    rec_edges = {l.get("edge_id") for l in r["routes"][r["recommended"]]["legs"]}
    assert "SVK-TBZ" not in rec_edges
    assert "SVK-TBZ" in {l.get("edge_id") for l in r["routes"]["fastest"]["legs"]}
    assert r["alerts"] and r["alerts"][0]["reasons"]
    assert r["latency_ms"] < 2000                       # KPI: decision latency under 2 s
    cb = r["routes"]["balanced"]["metrics"]["cost_breakdown"]
    assert set(cb) == {"travel_time", "risk_penalty", "perishability_penalty", "reliability_penalty"}


def test_blocked_edge_is_never_routed():
    set_scenario("dry_winter")
    c.post("/edges/SNG-GTK/status", json={"status": "blocked", "reason": "test closure"})
    r = c.post("/route/optimize", json={"origin": "SLG", "destination": "GTK"}).json()
    for prof in r["routes"].values():
        assert "SNG-GTK" not in {l.get("edge_id") for l in prof["legs"]}
    c.post("/edges/SNG-GTK/status", json={"status": "open", "reason": "test reopen"})


def test_override_requires_reason():
    assert c.post("/edges/SNG-GTK/status", json={"status": "blocked", "reason": ""}).status_code == 400


def test_non_recommended_approval_needs_reason():
    set_scenario("teesta_extreme")
    r = c.post("/route/optimize", json={"origin": "SLG", "destination": "GTK"}).json()
    rid = r["routes"]["fastest"]["route_id"]
    assert c.post(f"/route/{rid}/approve", json={}).status_code == 400
    ok = c.post(f"/route/{rid}/approve", json={"override_reason": "convoy escort arranged"})
    assert ok.status_code == 200
    assert any(a["action"] == "route.approve" for a in c.get("/audit").json())


def test_sync_is_idempotent_and_auto_verifies():
    set_scenario("normal_monsoon")
    e1 = dict(event_id=str(uuid.uuid4()), kind="incident", origin_device="DEV-1",
              created_at=time.time() - 600, payload=dict(type="landslide", lat=25.25, lon=92.40))
    e2 = dict(event_id=str(uuid.uuid4()), kind="incident", origin_device="DEV-2",
              created_at=time.time() - 300, payload=dict(type="landslide", edge_id="KHL-SNP"))
    # DEV-1 uploads its own report plus one it received from DEV-2 over the convoy mesh
    r1 = c.post("/sync/events", json=dict(device_id="DEV-1", cursor=0, events=[e1, e2],
                                          stats=dict(created_total=1))).json()
    assert r1["new_incidents"] == 2
    # DEV-2 later reaches coverage and uploads the same event: duplicate, not double-counted
    r2 = c.post("/sync/events", json=dict(device_id="DEV-2", cursor=r1["cursor"], events=[e2],
                                          stats=dict(created_total=1))).json()
    assert r2["duplicates"] == 1 and r2["new_incidents"] == 0
    risk = c.get("/risk/edge/KHL-SNP").json()
    assert risk["status"] == "blocked"                   # 2 independent devices → auto-verified
    stats = c.get("/dashboard/corridors").json()["sync"]
    assert stats["received"] <= stats["created"] and stats["via_mesh"] >= 2   # seeded relay + this one
    # two clear reports reopen it
    for d in ("DEV-3", "DEV-4"):
        c.post("/incident/report", json=dict(type="clear", edge_id="KHL-SNP", device_id=d))
    assert c.get("/risk/edge/KHL-SNP").json()["status"] == "open"


def test_sync_returns_server_events_since_cursor():
    r = c.post("/sync/events", json=dict(device_id="DEV-X", cursor=0, events=[])).json()
    kinds = {e["kind"] for e in r["events"]}
    assert "assignment" in kinds
    r2 = c.post("/sync/events", json=dict(device_id="DEV-X", cursor=r["cursor"], events=[])).json()
    assert r2["events"] == []


def test_kpi_replay_runs():
    k = c.post("/sim/replay", json={"scenario": "teesta_extreme", "trials": 60,
                                    "closures": ["SVK-TBZ"]}).json()
    for key in ("delay_avoided_pct", "eta_error_risk_aware_pct", "reroute_success_pct",
                "decision_latency_ms_p95", "delay_hist"):
        assert key in k
    assert k["decision_latency_ms_p95"] < 2000


def test_unknown_inputs_rejected():
    assert c.get("/risk/edge/NOPE").status_code == 404
    assert c.post("/route/optimize", json={"origin": "XXX", "destination": "GTK"}).status_code == 400
    assert c.post("/incident/report", json={"type": "landslide"}).status_code == 400


def test_seeded_field_reports_show_up():
    d = c.get("/dashboard/corridors").json()
    assert any(f["kind"] == "incident" for f in d["feed"])
    assert d["counts"]["blocked"] >= 1                     # two seeded reports auto-verify a closure
    assert d["sync"]["driver_reports"] >= 8


def test_route_options_differ():
    set_scenario("normal_monsoon")
    r = c.post("/route/optimize", json={"origin": "GHY", "destination": "IMP"}).json()
    sigs = {tuple(l.get("edge_id") or l["mode"] for l in x["legs"]) for x in r["routes"].values()}
    assert len(sigs) >= 3
    assert any(x.get("note") for x in r["routes"].values())
