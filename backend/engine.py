"""
Engine: owns the network, weather, hazard model, router and database, and implements the
operations behind the API (scoring, route optimisation, incident ingestion, offline sync,
corridor health, shipments).
"""
from __future__ import annotations

import json
import math
import threading
import time
import uuid
from pathlib import Path

from .db import DB
from .roads import RoadGeometry
from .risk.features import shift_rain
from .risk.model import HazardModel, level
from .routing import CARGO, PROFILES, Router, alternatives, recommend, new_route_id, interp_p
from .weather import WeatherState

NETWORK_PATH = Path(__file__).with_name("data") / "network.json"

BLOCKING = {"landslide", "washout", "flood", "accident"}
HAZARD_TYPES = BLOCKING | {"debris", "clear"}
REPORT_WINDOW_H = 6
AUTO_VERIFY_DEVICES = 2



# Field reports seeded with the demo so the alert feed, map markers and "driver reports" factor have
# something to show: (hours ago, uploading phone, reporting phone, type, severity, edge, note).
# A different reporting phone means the report reached the server through the convoy mesh.
DEMO_REPORTS = [
    (4.5, "TRK-NL02", "TRK-NL02", "landslide", "high", "MBG-HRJ", "Slide across both lanes near Jatinga; JCB on site"),
    (3.8, "TRK-AS01", "DRV-AS33", "landslide", "high", "MBG-HRJ", "Same slip near Jatinga, traffic stopped on both sides"),
    (2.6, "TRK-WB11", "TRK-WB11", "debris", "medium", "SVK-TBZ", "Debris on one lane at Chitrey, single-lane traffic"),
    (1.9, "TRK-WB07", "TRK-WB07", "landslide", "medium", "SVK-TBZ", "Fresh slip past 29th Mile, BRO clearing"),
    (1.2, "TRK-AS12", "TRK-AS12", "debris", "low", "KHL-SNP", "Loose rocks on NH6 after overnight rain"),
    (0.8, "TRK-AS01", "TRK-AS01", "flood", "medium", "KLB-KZR", "Water over the road near Kaziranga, slow crossing"),
    (0.5, "TRK-MZ05", "TRK-MZ05", "debris", "low", "KLS-AZL", "Small rockfall pushed to one side near Kolasib"),
    (0.3, "TRK-AR09", "TRK-AR09", "clear", "low", "NGB-NNY", "Road clear, normal traffic"),
]
# reports still queued on a phone that has no signal (created but not yet synced)
DEMO_QUEUED: dict[str, int] = {}

def _now():
    return time.time()


class Engine:
    def __init__(self, db_path=None):
        self.network = json.loads(NETWORK_PATH.read_text())
        self.nodes = {n["id"]: n for n in self.network["nodes"]}
        self.edges = {e["id"]: e for e in self.network["edges"]}
        self.db = DB(db_path) if db_path else DB()
        self.db.seed_edges(self.network["edges"])
        self.weather = WeatherState(self.network["met_zones"])
        self.model = HazardModel()
        for e in self.network["edges"]:          # keep the estimates so a rejected OSRM result can fall back
            e["est_length_km"], e["est_base_time_h"] = e["length_km"], e["base_time_h"]
            e["straight_geometry"] = e["geometry"]
            e["geometry_source"] = "straight"
        self.roads = RoadGeometry(self.network, on_update=self.apply_roads)
        self.router = Router(self.network)
        self.fleet = None                         # set by tracking.Fleet
        self._lock = threading.RLock()
        self._scores = None
        self.apply_roads()
        self.road_nodes = sorted({e["source"] for e in self.network["edges"] if e["mode"] == "road"} |
                                 {e["target"] for e in self.network["edges"] if e["mode"] == "road"})

    # ================================================================== road geometry
    def apply_roads(self):
        """Swap in OSRM road polylines and distances wherever we have them, then rebuild the router."""
        changed = 0
        for e in self.network["edges"]:
            if e["mode"] not in ("road", "rail"):
                continue
            g = self.roads.get(e["id"])
            if g:
                km = g.get("km") or g.get("osrm_km")
                e["geometry"] = g["coords"]
                e["length_km"] = km
                e["base_time_h"] = round(km / e["base_speed_kmh"], 2)
                e["geometry_source"] = g.get("source", "osrm")
                changed += 1
            else:
                e["geometry"], e["length_km"], e["base_time_h"] = e["straight_geometry"], e["est_length_km"], e["est_base_time_h"]
                e["geometry_source"] = "straight"
        self.router = Router(self.network)
        self.invalidate()
        if getattr(self, "fleet", None):
            self.fleet.refresh_geometry()
        return changed

    # ================================================================== scoring
    def invalidate(self):
        with self._lock:
            self._scores = None

    def weather_for_edge(self, e):
        return self.weather.for_edge(e["met_zones"])

    def reports_6h(self) -> tuple[dict, dict]:
        """Weighted recent hazard reports per edge and verified counts."""
        since = _now() - REPORT_WINDOW_H * 3600
        rows = self.db.q("SELECT edge_id, type, device_id, verified FROM hazard_events"
                         " WHERE time_start >= ? AND edge_id IS NOT NULL", (since,))
        per_edge: dict[str, dict] = {}
        verified: dict[str, int] = {}
        for r in rows:
            if r["type"] == "clear":
                continue
            w = 0.5 if r["type"] == "debris" else 1.0
            if r["verified"]:
                w *= 2
                verified[r["edge_id"]] = verified.get(r["edge_id"], 0) + 1
            dev = per_edge.setdefault(r["edge_id"], {})
            dev[r["device_id"]] = max(dev.get(r["device_id"], 0), w)   # one vote per device
        return {k: sum(v.values()) for k, v in per_edge.items()}, verified

    def scores(self) -> dict:
        with self._lock:
            if self._scores is None:
                reports, _ = self.reports_6h()
                self._scores = self.model.score_all(self.network["edges"], self.weather, reports,
                                                    self.db.edge_status())
            return self._scores

    def risk_edges(self):
        sc = self.scores()
        return [dict(edge_id=eid, p_now=round(s["p_now"], 4), p_max24=round(s["p_max24"], 4),
                     p={str(h): round(v, 4) for h, v in s["p"].items()}, level=s["level"], status=s["status"],
                     delay_if_blocked_h=s["delay_if_blocked_h"], reports_6h=s["reports_6h"])
                for eid, s in sc.items()]

    def edge_risk(self, edge_id: str) -> dict:
        e = self.edges[edge_id]
        sc = self.scores()[edge_id]
        reports, verified = self.reports_6h()
        fresh = self.weather.freshness()
        forecast = []
        base = self.weather_for_edge(e)
        for h in (0, 6, 12, 24):
            rain_h = shift_rain(base, h)
            forecast.append(dict(h=h, p=round(sc["p"][h], 4), level=level(sc["p"][h]),
                                 rain_24h=round(rain_h["rain_24h"], 1)))
        expl = self.model.explain(e, base, reports.get(edge_id, 0.0), self.weather.month, fresh["score"],
                                  sc["status"], verified.get(edge_id, 0))
        incidents = self.db.q("SELECT event_id, type, severity, device_id, verified, note, time_start, via"
                              " FROM hazard_events WHERE edge_id=? ORDER BY time_start DESC LIMIT 10", (edge_id,))
        return dict(edge=self._edge_public(e), status=sc["status"], p_now=round(sc["p_now"], 4),
                    level=sc["level"], delay_if_blocked_h=sc["delay_if_blocked_h"], forecast=forecast,
                    explanation=expl, rain=base, data_freshness=fresh, incidents=incidents,
                    model_version=self.model.version)

    def _edge_public(self, e):
        return {k: e[k] for k in ("id", "source", "target", "mode", "route_ref", "road_class", "terrain",
                                  "length_km", "base_time_h", "slope_deg", "elevation_m", "landslide_hist",
                                  "river", "no_network", "note")} | dict(
            source_name=self.nodes[e["source"]]["name"], target_name=self.nodes[e["target"]]["name"])

    # ================================================================== routing
    def optimize(self, origin, destination, cargo_type="general", priority="normal", deadline_h=None,
                 modes=("road", "rail", "ferry"), shipment_id=None, actor="dispatcher"):
        t0 = time.perf_counter()
        if origin not in self.nodes or destination not in self.nodes:
            raise ValueError("unknown origin/destination")
        if cargo_type not in CARGO:
            raise ValueError("unknown cargo type")
        sc = self.scores()
        results = {}
        for prof, (legs, note) in alternatives(self.router, origin, destination, sc, self.weather_for_edge,
                                               cargo_type, modes, deadline_h).items():
            metrics = self.router.evaluate(legs, prof, cargo_type, deadline_h)
            results[prof] = dict(profile=prof, label=PROFILES[prof]["label"],
                                 description=PROFILES[prof]["description"], metrics=metrics, note=note,
                                 legs=self.router.legs_json(legs), geometry=self.router.geometry(legs),
                                 _legs=legs)
        if not results:
            raise LookupError("No open route between these points with the selected modes.")

        rec, reason = recommend(results, priority, cargo_type)
        # mark identical routes so the UI can say "same as Balanced"
        sigs = {}
        for name, r in results.items():
            sig = tuple(l.get("edge_id") or l.get("mode") for l in r["legs"])
            r["same_as"] = sigs.get(sig)
            sigs.setdefault(sig, name)

        fresh = self.weather.freshness()
        reports, verified = self.reports_6h()
        # explained alerts along every candidate route (deduplicated)
        alerts, seen = [], set()
        for name, r in results.items():
            for l in r["_legs"]:
                if l.kind != "edge" or l.edge_id in seen:
                    continue
                s = sc[l.edge_id]
                if l.p >= 0.15 or s["status"] == "blocked":
                    seen.add(l.edge_id)
                    e = self.edges[l.edge_id]
                    ex = self.model.explain(e, self.weather_for_edge(e), reports.get(l.edge_id, 0.0),
                                            self.weather.month, fresh["score"], s["status"],
                                            verified.get(l.edge_id, 0))
                    alerts.append(dict(edge_id=l.edge_id, name=f"{self.nodes[e['source']]['name']} – "
                                       f"{self.nodes[e['target']]['name']} ({e['route_ref']})",
                                       p_at_arrival=round(l.p, 3), enter_h=round(l.enter_h, 1),
                                       level=level(l.p), headline=ex["headline"], reasons=ex["reasons"],
                                       confidence=ex["confidence"], on_profiles=[n for n, rr in results.items()
                                       if any(x.edge_id == l.edge_id for x in rr["_legs"])],
                                       delay_if_blocked_h=l.c, note=e["note"]))
        alerts.sort(key=lambda a: -a["p_at_arrival"])

        # comparison: what the recommended route avoids vs the fastest
        compare = None
        if "fastest" in results and rec != "fastest":
            f_edges = {l.edge_id for l in results["fastest"]["_legs"] if l.kind == "edge"}
            r_edges = {l.edge_id for l in results[rec]["_legs"] if l.kind == "edge"}
            avoided = sorted((a for a in alerts if a["edge_id"] in f_edges - r_edges),
                             key=lambda a: -a["p_at_arrival"])
            fm, rm = results["fastest"]["metrics"], results[rec]["metrics"]
            compare = dict(vs="fastest", avoided=[a["name"] for a in avoided[:3]],
                           extra_travel_h=round(rm["travel_time_h"] - fm["travel_time_h"], 2),
                           delay_saved_h=round(fm["expected_delay_h"] - rm["expected_delay_h"], 2),
                           p90_saved_h=round(fm["eta_p90_h"] - rm["eta_p90_h"], 2))

        request_id = "Q-" + uuid.uuid4().hex[:8].upper()
        now = _now()
        for name, r in results.items():
            r["route_id"] = new_route_id()
            m = r["metrics"]
            self.db.x("INSERT INTO route_decisions(route_id, shipment_id, profile, recommended_profile, edges,"
                      " cost_breakdown, risk_score, eta, eta_p90, model_version, data_freshness, decision,"
                      " created_at, payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (r["route_id"], shipment_id, name, rec, json.dumps(r["legs"]),
                       json.dumps(m["cost_breakdown"]), m["risk_score"], m["eta_expected_h"], m["eta_p90_h"],
                       self.model.version, json.dumps(fresh), "proposed", now,
                       json.dumps(dict(request_id=request_id, origin=origin, destination=destination,
                                       cargo_type=cargo_type, priority=priority, deadline_h=deadline_h,
                                       geometry=r["geometry"], metrics=m))))
            del r["_legs"]
        latency_ms = round((time.perf_counter() - t0) * 1000, 1)
        return dict(request_id=request_id, origin=origin, destination=destination, cargo_type=cargo_type,
                    cargo=CARGO[cargo_type], priority=priority, deadline_h=deadline_h,
                    recommended=rec, recommendation_reason=reason, routes=results, alerts=alerts,
                    comparison=compare, data_freshness=fresh, model_version=self.model.version,
                    latency_ms=latency_ms,
                    human_in_the_loop="Recommendation only. A dispatcher must approve before a vehicle is sent.")

    def approve(self, route_id, actor="dispatcher", vehicle_id=None, override_reason=None, shipment_id=None):
        rows = self.db.q("SELECT * FROM route_decisions WHERE route_id=?", (route_id,))
        if not rows:
            raise LookupError("route not found")
        r = rows[0]
        payload = json.loads(r["payload"])
        if r["profile"] != r["recommended_profile"] and not override_reason:
            raise ValueError("Choosing a non-recommended route needs an override reason (logged for audit).")
        now = _now()
        req = payload["request_id"]
        # reject sibling options from the same request
        for sib in self.db.q("SELECT route_id, payload FROM route_decisions WHERE decision='proposed'"):
            if json.loads(sib["payload"]).get("request_id") == req and sib["route_id"] != route_id:
                self.db.x("UPDATE route_decisions SET decision='rejected', decided_at=? WHERE route_id=?",
                          (now, sib["route_id"]))
        shipment_id = shipment_id or r["shipment_id"]
        if not shipment_id:
            shipment_id = self.create_shipment(payload["origin"], payload["destination"], payload["cargo_type"],
                                               payload["priority"], payload.get("deadline_h"))["shipment_id"]
        vehicle_id = vehicle_id or "TRK-" + uuid.uuid4().hex[:4].upper()
        self.db.x("UPDATE route_decisions SET decision='approved', decided_by=?, override_reason=?, decided_at=?,"
                  " shipment_id=? WHERE route_id=?", (actor, override_reason, now, shipment_id, route_id))
        self.db.x("UPDATE shipments SET status='in_transit', route_id=?, vehicle_id=? WHERE shipment_id=?",
                  (route_id, vehicle_id, shipment_id))
        o = self.nodes[payload["origin"]]
        self.db.x("INSERT OR REPLACE INTO vehicle_status(vehicle_id, lat, lon, speed, load, offline_flag, last_sync,"
                  " last_seen, shipment_id, edge_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (vehicle_id, o["lat"], o["lon"], 0, payload["cargo_type"], 0, now, now, shipment_id, None))
        self.db.audit(actor, "route.approve", dict(route_id=route_id, profile=r["profile"],
                                                   recommended=r["recommended_profile"],
                                                   override_reason=override_reason, shipment_id=shipment_id,
                                                   vehicle_id=vehicle_id, model_version=r["model_version"],
                                                   data_freshness=json.loads(r["data_freshness"])))
        if self.fleet:
            self.fleet.attach(vehicle_id, route_id, source="sim", demo=(actor == "seed"))
        # push the assignment into the sync log so an offline driver app receives it on next contact
        self.db.append_server_event("assignment", dict(
            vehicle_id=vehicle_id, shipment_id=shipment_id, route_id=route_id, profile=r["profile"],
            legs=json.loads(r["edges"]), geometry=payload["geometry"], origin=payload["origin"],
            destination=payload["destination"], cargo_type=payload["cargo_type"], created_at=now))
        return dict(route_id=route_id, shipment_id=shipment_id, vehicle_id=vehicle_id, decision="approved")

    # ================================================================== shipments
    def create_shipment(self, origin, destination, cargo_type="general", priority="normal", deadline_h=None,
                        weight_t=8.0):
        sid = "SHP-" + uuid.uuid4().hex[:6].upper()
        now = _now()
        self.db.x("INSERT INTO shipments(shipment_id, priority, origin, destination, cargo_type, temp_range,"
                  " deadline, weight_t, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (sid, priority, origin, destination, cargo_type, CARGO[cargo_type]["temp_range"],
                   now + deadline_h * 3600 if deadline_h else None, weight_t, "planning", now))
        return dict(shipment_id=sid)

    def shipments(self):
        sc = self.scores()
        out = []
        for s in self.db.q("SELECT * FROM shipments ORDER BY created_at DESC"):
            item = dict(s, origin_name=self.nodes[s["origin"]]["name"],
                        destination_name=self.nodes[s["destination"]]["name"],
                        cargo_label=CARGO[s["cargo_type"]]["label"])
            if s["route_id"]:
                r = self.db.q("SELECT * FROM route_decisions WHERE route_id=?", (s["route_id"],))[0]
                legs = json.loads(r["edges"])
                tracked = self.fleet.completed_h(s["vehicle_id"]) if self.fleet and s["vehicle_id"] else None
                elapsed = tracked if tracked is not None else (_now() - (r["decided_at"] or r["created_at"])) / 3600
                remaining, exp_delay, worst, hold = 0.0, 0.0, None, None
                clock = 0.0
                for l in legs:
                    clock += l["t_h"]
                    if clock <= elapsed:
                        continue
                    remaining += min(l["t_h"], clock - elapsed)
                    if l["kind"] == "edge":
                        st = sc[l["edge_id"]]
                        p = 1.0 if st["status"] == "blocked" else interp_p(st["p"], max(clock - elapsed, 0))
                        exp_delay += p * st["delay_if_blocked_h"]
                        if worst is None or p > worst["p"]:
                            worst = dict(edge_id=l["edge_id"], p=round(p, 3), name=f"{l['frm_name']} – {l['to_name']}")
                        if p >= 0.35 and hold is None:
                            hold = l["frm"]
                eta_h = remaining + exp_delay
                item.update(route_profile=r["profile"], progress=round(min(elapsed / max(clock, 0.01), 1), 3),
                            eta_remaining_h=round(eta_h, 1), expected_delay_h=round(exp_delay, 1),
                            worst_edge=worst, risk_level=level(worst["p"]) if worst else "low")
                if s["deadline"]:
                    item["slack_h"] = round((s["deadline"] - _now()) / 3600 - eta_h, 1)
                mt = CARGO[s["cargo_type"]]["max_transit_h"]
                if mt:
                    item["cold_chain_margin_h"] = round(mt - (elapsed + eta_h), 1)
                if hold:
                    item["handover_suggestion"] = dict(
                        node=hold, name=self.nodes[hold]["name"],
                        reason=f"Hold or hand over at {self.nodes[hold]['name']} before {worst['name']} "
                               f"(p={worst['p']:.0%}); cold storage / reroute from there.")
            out.append(item)
        return out

    # ================================================================== incidents & sync
    def snap_to_edge(self, lat, lon, max_km=20.0):
        best, best_d = None, float("inf")
        k = math.cos(math.radians(lat))
        px, py = lon * k, lat
        for e in self.network["edges"]:
            if e["mode"] != "road":
                continue
            g = e["geometry"]
            for (x1, y1), (x2, y2) in zip(g[:-1], g[1:]):
                ax, ay, bx, by = x1 * k, y1, x2 * k, y2
                dx, dy = bx - ax, by - ay
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111
                if d < best_d:
                    best, best_d = e["id"], d
        return best if best_d <= max_km else None

    def ingest_incident(self, ev: dict, via="direct", uploader=None) -> dict:
        if ev.get("type") not in HAZARD_TYPES:
            raise ValueError(f"type must be one of {sorted(HAZARD_TYPES)}")
        ev = dict(ev)
        ev.setdefault("event_id", str(uuid.uuid4()))
        if not ev.get("created_at"):
            ev["created_at"] = _now()
        if not ev.get("edge_id") and ev.get("lat") is not None:
            ev["edge_id"] = self.snap_to_edge(ev["lat"], ev["lon"])
        if ev.get("edge_id") and ev["edge_id"] not in self.edges:
            raise ValueError("unknown edge_id")
        ev["via"] = via
        new = self.db.insert_hazard(ev)
        status_change = None
        if new:
            self.db.append_server_event("incident", ev, device_id=ev.get("device_id"), event_id=ev["event_id"])
            status_change = self._auto_verify(ev["edge_id"]) if ev.get("edge_id") else None
            self.invalidate()
            self._alert_vehicles(ev.get("edge_id"))
        return dict(event_id=ev["event_id"], new=new, edge_id=ev.get("edge_id"), status_change=status_change)

    def _auto_verify(self, edge_id):
        since = _now() - REPORT_WINDOW_H * 3600
        rows = self.db.q("SELECT type, device_id, verified, time_start FROM hazard_events WHERE edge_id=?"
                         " AND time_start>=? ORDER BY time_start", (edge_id, since))
        cur = self.db.edge_status().get(edge_id, "open")
        block_devs = {r["device_id"] for r in rows if r["type"] in BLOCKING}
        last_block = max((r["time_start"] for r in rows if r["type"] in BLOCKING), default=0)
        clear_devs = {r["device_id"] for r in rows if r["type"] == "clear" and r["time_start"] >= last_block}
        if cur != "blocked" and len(block_devs) >= AUTO_VERIFY_DEVICES:
            reason = f"{len(block_devs)} independent driver reports within {REPORT_WINDOW_H} h"
            self._set_status(edge_id, "blocked", reason, actor="auto-verify")
            self.db.x("UPDATE hazard_events SET verified=1 WHERE edge_id=? AND time_start>=? AND type IN"
                      " ('landslide','washout','flood','accident')", (edge_id, since))
            return dict(status="blocked", reason=reason)
        if cur == "blocked" and len(clear_devs) >= AUTO_VERIFY_DEVICES:
            reason = f"{len(clear_devs)} drivers report the road clear"
            self._set_status(edge_id, "open", reason, actor="auto-verify")
            return dict(status="open", reason=reason)
        return None

    def _set_status(self, edge_id, status, reason, actor):
        self.db.set_edge_status(edge_id, status, reason)
        self.db.audit(actor, "edge.status", dict(edge_id=edge_id, status=status, reason=reason))
        self.db.append_server_event("edge_status", dict(edge_id=edge_id, status=status, reason=reason,
                                                        created_at=_now()))
        self.invalidate()

    def override_edge(self, edge_id, status, reason, actor="dispatcher"):
        if edge_id not in self.edges:
            raise LookupError("unknown edge")
        if status not in ("open", "blocked"):
            raise ValueError("status must be open or blocked")
        if not reason:
            raise ValueError("a reason is required for a manual override")
        self._set_status(edge_id, status, reason, actor)
        self._alert_vehicles(edge_id)
        return dict(edge_id=edge_id, status=status)

    def _alert_vehicles(self, edge_id):
        if not edge_id:
            return
        sc = self.scores()[edge_id]
        if sc["status"] != "blocked" and sc["p_now"] < 0.35:
            return
        for r in self.db.q("SELECT route_id, shipment_id, edges FROM route_decisions WHERE decision='approved'"):
            if any(l.get("edge_id") == edge_id for l in json.loads(r["edges"])):
                v = self.db.q("SELECT vehicle_id FROM shipments WHERE shipment_id=?", (r["shipment_id"],))
                if not v:
                    continue
                e = self.edges[edge_id]
                msg = (f"{'BLOCKED' if sc['status'] == 'blocked' else 'High risk'} ahead: "
                       f"{self.nodes[e['source']]['name']} – {self.nodes[e['target']]['name']} ({e['route_ref']}). "
                       "Await dispatcher reroute.")
                self.db.append_server_event("alert", dict(vehicle_id=v[0]["vehicle_id"], route_id=r["route_id"],
                                                          edge_id=edge_id, message=msg, p=round(sc["p_now"], 3),
                                                          created_at=_now()))

    def sync(self, device_id: str, cursor: int, events: list[dict], stats: dict | None = None):
        accepted, dup, new_incidents = [], 0, 0
        mesh = 0
        for ev in events:
            kind = ev.get("kind")
            eid = ev.get("event_id")
            if not eid:
                continue
            origin = ev.get("origin_device", device_id)
            via = "mesh" if origin != device_id else "direct"
            if kind == "incident":
                payload = dict(ev.get("payload", {}), event_id=eid, device_id=origin,
                               created_at=ev.get("created_at") or _now(), hops=ev.get("hops", 0))
                try:
                    res = self.ingest_incident(payload, via=via, uploader=device_id)
                except ValueError:
                    continue
                if res["new"]:
                    new_incidents += 1
                    mesh += via == "mesh"
                else:
                    dup += 1
            elif kind == "ping":
                p = ev.get("payload", {})
                self._ping(origin, p, ev.get("created_at") or _now(), offline=bool(ev.get("queued")))
            accepted.append(eid)
        if stats and "created_total" in stats:
            received = self.db.q("SELECT COUNT(*) AS n FROM hazard_events WHERE device_id=?", (device_id,))[0]["n"]
            self.db.x("INSERT OR REPLACE INTO device_stats(device_id, created_total, received_total, via_mesh,"
                      " last_sync) VALUES (?,?,?,?,?)", (device_id, int(stats["created_total"]), received,
                                                          mesh, _now()))
        self.db.x("UPDATE vehicle_status SET last_sync=?, offline_flag=0 WHERE vehicle_id=?", (_now(), device_id))
        return dict(accepted=accepted, duplicates=dup, new_incidents=new_incidents,
                    events=self.db.server_events_since(cursor), cursor=self.db.max_seq())

    def _ping(self, vehicle_id, p, ts, offline=False):
        if self.fleet and p.get("lat") is not None:
            self.fleet.ingest(vehicle_id, p["lat"], p["lon"], speed_kmh=p.get("speed"), ts=ts, source="app", offline=offline)
            return
        row = self.db.q("SELECT last_seen FROM vehicle_status WHERE vehicle_id=?", (vehicle_id,))
        if row and row[0]["last_seen"] and row[0]["last_seen"] > ts:
            return   # older than what we already have (queued ping arriving late)
        self.db.x("INSERT INTO vehicle_status(vehicle_id, lat, lon, speed, load, offline_flag, last_seen, shipment_id,"
                  " edge_id, pinged) VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT(vehicle_id) DO UPDATE SET pinged=1, lat=excluded.lat,"
                  " lon=excluded.lon, speed=excluded.speed, offline_flag=excluded.offline_flag,"
                  " last_seen=excluded.last_seen, edge_id=excluded.edge_id,"
                  " shipment_id=COALESCE(excluded.shipment_id, vehicle_status.shipment_id)",
                  (vehicle_id, p.get("lat"), p.get("lon"), p.get("speed", 0), p.get("load"), int(offline), ts,
                   p.get("shipment_id"), p.get("edge_id")))

    def vehicles(self):
        if self.fleet:
            return self.fleet.snapshot()
        out = []
        for v in self.db.q("SELECT * FROM vehicle_status"):
            v["stale_min"] = round((_now() - (v["last_seen"] or 0)) / 60, 1)
            v["estimated"] = False
            if v["shipment_id"] and not v["pinged"]:
                est = self._estimate_position(v["shipment_id"])
                if est:
                    v.update(est, estimated=True)
            out.append(v)
        return out

    def _estimate_position(self, shipment_id):
        """Dead-reckon a vehicle that has not pinged yet along its approved route."""
        s = self.db.q("SELECT route_id FROM shipments WHERE shipment_id=?", (shipment_id,))
        if not s or not s[0]["route_id"]:
            return None
        r = self.db.q("SELECT edges, decided_at FROM route_decisions WHERE route_id=?", (s[0]["route_id"],))[0]
        elapsed = (_now() - (r["decided_at"] or _now())) / 3600
        clock = 0.0
        for l in json.loads(r["edges"]):
            if clock + l["t_h"] >= elapsed and l["kind"] == "edge":
                f = (elapsed - clock) / max(l["t_h"], 1e-6)
                a, b = self.nodes[l["frm"]], self.nodes[l["to"]]
                f = max(0.0, min(1.0, f))
                return dict(lat=a["lat"] + (b["lat"] - a["lat"]) * f, lon=a["lon"] + (b["lon"] - a["lon"]) * f,
                            edge_id=l["edge_id"])
            clock += l["t_h"]
        return None

    def sync_stats(self):
        rows = self.db.q("SELECT * FROM device_stats")
        created = sum(r["created_total"] or 0 for r in rows)
        received = sum(min(r["received_total"] or 0, r["created_total"] or 0) for r in rows)
        mesh = self.db.q("SELECT COUNT(*) AS n FROM hazard_events WHERE via='mesh'")[0]["n"]
        total = self.db.q("SELECT COUNT(*) AS n FROM hazard_events WHERE source='driver'")[0]["n"]
        lag = self.db.q("SELECT AVG(received_at - created_at) AS l FROM hazard_events WHERE source='driver'")[0]["l"]
        return dict(devices=len(rows), created=created, received=received,
                    sync_rate=round(received / created, 3) if created else None,
                    via_mesh=mesh, driver_reports=total, mean_sync_lag_min=round((lag or 0) / 60, 1))

    # ================================================================== dashboard
    def corridors(self):
        sc = self.scores()
        out = []
        for c in self.network["corridors"]:
            eds = [sc[e] for e in c["edges"]]
            blocked = [e for e in c["edges"] if sc[e]["status"] == "blocked"]
            p_any = 1 - math.prod(1 - s["p_now"] for s in eds)
            p_any24 = 1 - math.prod(1 - s["p_max24"] for s in eds)
            base_t = sum(self.edges[e]["base_time_h"] for e in c["edges"])
            exp_delay = sum(s["p_now"] * s["delay_if_blocked_h"] for s in eds)
            var = sum((s["delay_if_blocked_h"] ** 2) * s["p_now"] * (1 - s["p_now"]) for s in eds)
            worst = max(c["edges"], key=lambda e: sc[e]["p_now"])
            health = "blocked" if blocked else level(p_any)
            out.append(dict(id=c["id"], name=c["name"], edges=c["edges"], nodes=c["nodes"],
                            health=health, p_disruption_now=round(p_any, 3), p_disruption_24h=round(p_any24, 3),
                            blocked_edges=blocked, base_time_h=round(base_t, 1),
                            expected_delay_h=round(exp_delay, 1), eta_std_h=round(math.sqrt(var), 1),
                            worst_edge=dict(edge_id=worst, p=round(sc[worst]["p_now"], 3),
                                            name=f"{self.nodes[self.edges[worst]['source']]['name']} – "
                                                 f"{self.nodes[self.edges[worst]['target']]['name']}")))
        order = {"blocked": 0, "high": 1, "medium": 2, "elevated": 3, "low": 4}
        out.sort(key=lambda c: (order[c["health"]], -c["p_disruption_now"]))
        feed = []
        for r in self.db.q("SELECT seq, kind, payload, received_at FROM server_events WHERE kind IN"
                           " ('incident','edge_status','alert') ORDER BY seq DESC LIMIT 30"):
            p = json.loads(r["payload"])
            feed.append(dict(seq=r["seq"], kind=r["kind"], at=r["received_at"], **{k: p.get(k) for k in
                             ("edge_id", "type", "status", "reason", "message", "device_id", "via", "note")}))
        return dict(corridors=out, feed=feed, data_freshness=self.weather.freshness(),
                    model_version=self.model.version, sync=self.sync_stats(),
                    counts=dict(blocked=sum(1 for s in sc.values() if s["status"] == "blocked"),
                                high=sum(1 for s in sc.values() if s["level"] == "high"),
                                medium=sum(1 for s in sc.values() if s["level"] == "medium")))

    # ================================================================== demo seed
    def seed_demo(self):
        if self.db.q("SELECT COUNT(*) AS n FROM shipments")[0]["n"]:
            return
        demo = [("GHY", "IMP", "pharma", "high", 30, "TRK-AS01"),
                ("SLG", "GTK", "perishable", "normal", 12, "TRK-WB07"),
                ("GHY", "SCR", "relief", "critical", 20, "TRK-AS12"),
                ("GHY", "AGT", "general", "normal", 36, "TRK-TR03"),
                ("SLG", "GTK", "general", "normal", None, "TRK-WB11"),
                ("DMR", "IMP", "relief", "high", 24, "TRK-NL02"),
                ("SCR", "AZL", "perishable", "normal", 20, "TRK-MZ05"),
                ("GHY", "TWG", "fuel", "normal", None, "TRK-AR09")]
        for o, d, cargo, prio, dl, veh in demo:
            sid = self.create_shipment(o, d, cargo, prio, dl)["shipment_id"]
            res = self.optimize(o, d, cargo, prio, dl, shipment_id=sid)
            rid = res["routes"][res["recommended"]]["route_id"]
            self.approve(rid, actor="seed", vehicle_id=veh, shipment_id=sid)
        self.seed_reports()
        self.db.audit("system", "seed.demo", dict(shipments=len(demo), reports=len(DEMO_REPORTS)))

    def seed_reports(self):
        """Replay DEMO_REPORTS in time order, as if the phones had synced them when they were made."""
        own_count: dict[str, int] = {}
        for ago, up, dev, typ, sev, eid, note in DEMO_REPORTS:
            own_count[up] = own_count.get(up, 0) + (dev == up)
        for ago, up, dev, typ, sev, eid, note in DEMO_REPORTS:
            g = self.edges[eid]["geometry"]
            lon, lat = g[len(g) // 2]
            made = _now() - ago * 3600
            got = made + (25 if dev != up else 3 if ago < 4 else 40) * 60     # mesh relays and dead zones sync later
            last = self.db.q("SELECT COALESCE(MAX(seq), 0) AS s FROM server_events")[0]["s"]
            ev = dict(kind="incident", event_id=str(uuid.uuid4()), origin_device=dev, created_at=made,
                      hops=0 if dev == up else 1,
                      payload=dict(type=typ, severity=sev, edge_id=eid, lat=lat, lon=lon, note=note, source="driver"))
            self.sync(up, 0, [ev], stats=dict(created_total=own_count[up] + DEMO_QUEUED.get(up, 0)))
            self.db.x("UPDATE hazard_events SET received_at=? WHERE event_id=?", (got, ev["event_id"]))
            self.db.x("UPDATE server_events SET received_at=?, created_at=MIN(created_at, ?) WHERE seq>?", (got, got, last))
