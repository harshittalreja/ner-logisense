"""
NER-LogiSense API (FastAPI).

Core endpoints from the proposal:
    POST /route/optimize        best routes + explanation for a cargo and vehicle
    GET  /risk/edge/{id}        current and forecast hazard score for a road segment
    POST /incident/report       offline-safe driver report (idempotent on event_id)
    GET  /dashboard/corridors   corridor health, blockages, ETA variance and alert feed
    POST /sync/events           batch upload/download for offline convoy devices

Supporting endpoints: network, weather, risk layer, shipments, approvals, overrides, vehicles,
KPI replay, model card, audit log. Interactive docs at /docs.

Run:  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import Engine
from .routing import CARGO, PROFILES
from .sim import run_replay
from .tracking import Fleet
from .weather import SCENARIOS

FRONTEND = Path(__file__).parents[1] / "frontend"

engine = Engine(os.environ.get("NER_DB") or None)
if os.environ.get("NER_SEED_DEMO", "1") == "1":
    engine.seed_demo()
fleet = Fleet(engine, speedup=float(os.environ.get("NER_SIM_SPEEDUP", "30")))


@asynccontextmanager
async def lifespan(_app):
    # background work: the truck simulator and the one-off OSRM road-geometry download
    if os.environ.get("NER_FLEET_SIM", "1") == "1":
        fleet.start()
    if os.environ.get("NER_ROADS_FETCH", "1") == "1":
        engine.roads.start_background()
    yield


app = FastAPI(title="NER-LogiSense API", version="0.4.0", lifespan=lifespan,
              description="Hazard-aware logistics for the hill corridors of Northeast India (prototype).")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def clean(o):
    """Make numpy scalars JSON-safe."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    return o


# ============================================================================ schemas
class OptimizeReq(BaseModel):
    origin: str = Field(..., examples=["SLG"])
    destination: str = Field(..., examples=["GTK"])
    cargo_type: Literal["general", "perishable", "pharma", "relief", "fuel"] = "general"
    priority: Literal["normal", "high", "critical"] = "normal"
    deadline_h: float | None = Field(None, description="Hours from now")
    modes: list[Literal["road", "rail", "ferry"]] = ["road", "rail", "ferry"]
    shipment_id: str | None = None


class ApproveReq(BaseModel):
    actor: str = "dispatcher"
    vehicle_id: str | None = None
    override_reason: str | None = None
    shipment_id: str | None = None


class IncidentReq(BaseModel):
    event_id: str | None = None
    type: Literal["landslide", "washout", "flood", "accident", "debris", "clear"]
    lat: float | None = None
    lon: float | None = None
    edge_id: str | None = None
    severity: Literal["low", "medium", "high"] = "medium"
    device_id: str = "dispatcher-console"
    source: Literal["driver", "dispatcher", "authority"] = "driver"
    verified: bool = False
    note: str = ""
    created_at: float | None = None


class SyncEvent(BaseModel):
    event_id: str
    kind: Literal["incident", "ping"]
    origin_device: str | None = None
    created_at: float | None = None
    hops: int = 0
    queued: bool = False
    payload: dict = {}


class SyncReq(BaseModel):
    device_id: str
    cursor: int = 0
    events: list[SyncEvent] = []
    stats: dict | None = None


class ShipmentReq(BaseModel):
    origin: str
    destination: str
    cargo_type: Literal["general", "perishable", "pharma", "relief", "fuel"] = "general"
    priority: Literal["normal", "high", "critical"] = "normal"
    deadline_h: float | None = None
    weight_t: float = 8.0


class OverrideReq(BaseModel):
    status: Literal["open", "blocked"]
    reason: str
    actor: str = "dispatcher"


class ScenarioReq(BaseModel):
    scenario: str


class ReplayReq(BaseModel):
    scenario: str | None = None
    trials: int = Field(300, ge=20, le=2000)
    closures: list[str] = []
    cargo_type: Literal["general", "perishable", "pharma", "relief", "fuel"] = "general"
    seed: int = 42


# ============================================================================ core (proposal) endpoints
@app.post("/route/optimize", tags=["core"])
def route_optimize(req: OptimizeReq):
    try:
        return clean(engine.optimize(req.origin, req.destination, req.cargo_type, req.priority, req.deadline_h,
                                     tuple(req.modes), req.shipment_id))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))


@app.get("/risk/edge/{edge_id}", tags=["core"])
def risk_edge(edge_id: str):
    if edge_id not in engine.edges:
        raise HTTPException(404, "unknown edge")
    return clean(engine.edge_risk(edge_id))


@app.post("/incident/report", tags=["core"])
def incident_report(req: IncidentReq):
    if req.edge_id is None and (req.lat is None or req.lon is None):
        raise HTTPException(400, "give edge_id or lat/lon")
    ev = req.model_dump()
    if ev["created_at"] is None:
        ev["created_at"] = time.time()
    if ev["event_id"] is None:
        ev.pop("event_id")
    try:
        res = engine.ingest_incident(ev, via="direct")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if res["edge_id"] is None:
        res["warning"] = "Could not snap the report to a corridor edge (more than 20 km away)."
    return res


@app.get("/dashboard/corridors", tags=["core"])
def dashboard_corridors():
    return clean(engine.corridors())


@app.post("/sync/events", tags=["core"])
def sync_events(req: SyncReq):
    return clean(engine.sync(req.device_id, req.cursor, [e.model_dump() for e in req.events], req.stats))


# ============================================================================ supporting endpoints
@app.get("/network", tags=["data"])
def network():
    n = engine.network
    return dict(version=n["version"], note=n["note"], nodes=n["nodes"], corridors=n["corridors"],
                met_zones=n["met_zones"], road_nodes=engine.road_nodes,
                edges=[{k: v for k, v in e.items()} | dict(detour_extra_h=clean(engine.router.detour_extra[e["id"]]))
                       for e in n["edges"]],
                cargo=CARGO, profiles={k: dict(label=v["label"], description=v["description"])
                                       for k, v in PROFILES.items()})


@app.get("/risk/edges", tags=["data"])
def risk_edges():
    return dict(edges=clean(engine.risk_edges()), data_freshness=engine.weather.freshness(),
                model_version=engine.model.version)


@app.get("/weather", tags=["data"])
def weather():
    return engine.weather.snapshot()


@app.post("/weather/scenario", tags=["data"])
def weather_scenario(req: ScenarioReq):
    if req.scenario not in SCENARIOS:
        raise HTTPException(400, f"scenario must be one of {list(SCENARIOS)}")
    engine.weather.set_scenario(req.scenario)
    engine.invalidate()
    engine.db.audit("dispatcher", "weather.scenario", dict(scenario=req.scenario))
    return engine.weather.snapshot()


@app.post("/weather/live", tags=["data"])
def weather_live():
    ok = engine.weather.fetch_live()
    engine.invalidate()
    snap = engine.weather.snapshot()
    snap["ok"] = ok
    if not ok:
        return JSONResponse(snap, status_code=502)
    engine.db.audit("dispatcher", "weather.live", dict(source="open-meteo"))
    return snap


@app.post("/shipments", tags=["operations"])
def create_shipment(req: ShipmentReq):
    return engine.create_shipment(req.origin, req.destination, req.cargo_type, req.priority, req.deadline_h,
                                  req.weight_t)


@app.get("/shipments", tags=["operations"])
def shipments():
    return clean(engine.shipments())


@app.post("/route/{route_id}/approve", tags=["operations"])
def approve(route_id: str, req: ApproveReq):
    try:
        return engine.approve(route_id, req.actor, req.vehicle_id, req.override_reason, req.shipment_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/edges/{edge_id}/status", tags=["operations"])
def override_edge(edge_id: str, req: OverrideReq):
    try:
        return engine.override_edge(edge_id, req.status, req.reason, req.actor)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/vehicles", tags=["operations"])
def vehicles():
    return engine.vehicles()


# ============================================================================ live tracking
class PositionReq(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    speed_kmh: float | None = None
    heading: float | None = None
    accuracy_m: float | None = None
    ts: float | None = None


class FleetSimReq(BaseModel):
    speedup: float | None = Field(None, ge=1, le=600)
    running: bool | None = None


@app.get("/fleet", tags=["tracking"])
def fleet_all():
    return clean(dict(vehicles=fleet.snapshot(), sim=fleet.settings(), t=time.time()))


@app.get("/fleet/{vehicle_id}", tags=["tracking"])
def fleet_one(vehicle_id: str):
    d = fleet.detail(vehicle_id)
    if not d:
        raise HTTPException(404, "unknown vehicle")
    return clean(d)


@app.post("/fleet/sim", tags=["tracking"])
def fleet_sim(req: FleetSimReq):
    if req.speedup is not None:
        fleet.speedup = req.speedup
    if req.running is not None:
        fleet.running = req.running
    return fleet.settings()


@app.post("/vehicles/{vehicle_id}/position", tags=["tracking"])
def vehicle_position(vehicle_id: str, req: PositionReq):
    """Live position from a device (phone GPS). The same pipeline feeds the simulator's trucks."""
    return clean(fleet.ingest(vehicle_id, req.lat, req.lon, speed_kmh=req.speed_kmh, heading=req.heading,
                              ts=req.ts or time.time(), source="gps"))


@app.get("/stream/fleet", tags=["tracking"])
async def stream_fleet(request: Request):
    """Server-sent events: the whole fleet once a second."""
    async def gen():
        while not await request.is_disconnected():
            data = json.dumps(clean(dict(vehicles=fleet.snapshot(), sim=fleet.settings(), t=time.time())))
            yield f"data: {data}\n\n"
            await asyncio.sleep(1.0)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/roads/status", tags=["data"])
def roads_status():
    return engine.roads.summary()


@app.get("/roads/export", tags=["data"])
def roads_export():
    """Download the cached OSRM geometry; commit it as backend/data/road_geometry.json."""
    return JSONResponse(engine.roads.data, headers={"Content-Disposition": "attachment; filename=road_geometry.json"})


@app.get("/incidents", tags=["operations"])
def incidents(hours: float = 24):
    import json as _j
    rows = engine.db.q("SELECT event_id, type, severity, geometry, edge_id, time_start, source, device_id, verified,"
                       " note, via, hops, received_at FROM hazard_events WHERE time_start >= ? ORDER BY time_start DESC",
                       (time.time() - hours * 3600,))
    for r in rows:
        g = _j.loads(r.pop("geometry"))["coordinates"]
        if g[0] is None and r["edge_id"]:
            e = engine.edges[r["edge_id"]]["geometry"]
            g = e[len(e) // 2]
        r["lon"], r["lat"] = g
    return rows


@app.post("/sim/replay", tags=["evaluation"])
def sim_replay(req: ReplayReq):
    bad = [c for c in req.closures if c not in engine.edges]
    if bad:
        raise HTTPException(400, f"unknown edges: {bad}")
    if req.scenario and req.scenario not in SCENARIOS and req.scenario != "current":
        raise HTTPException(400, "unknown scenario")
    t0 = time.time()
    k = run_replay(engine, req.scenario, req.trials, req.closures, req.seed, req.cargo_type)
    k["runtime_s"] = round(time.time() - t0, 2)
    k["offline_sync"] = engine.sync_stats()
    engine.db.audit("analyst", "sim.replay", dict(scenario=req.scenario, trials=req.trials,
                                                  closures=req.closures, cargo=req.cargo_type))
    return clean(k)


@app.get("/model", tags=["evaluation"])
def model_card():
    return engine.model.metrics


@app.get("/audit", tags=["operations"])
def audit(limit: int = 100):
    import json as _j
    rows = engine.db.q("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        r["detail"] = _j.loads(r["detail"])
    return rows


@app.get("/health", tags=["ops"])
def health():
    return dict(ok=True, model_version=engine.model.version, weather=engine.weather.freshness(),
                edges=len(engine.edges), time=time.time())


# ============================================================================ frontend
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/driver", include_in_schema=False)
def driver():
    return FileResponse(FRONTEND / "driver.html")


@app.get("/sw.js", include_in_schema=False)
def sw():
    # service worker must be served from the root to control /driver
    return FileResponse(FRONTEND / "sw.js", media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/"})


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
