"""
Live fleet tracking.

One pipeline for every position source:
    sim   – the built-in truck simulator (demo mode)
    app   – the driver app's pings (sync)
    gps   – a phone's real GPS via POST /vehicles/{id}/position   (next step: navigator.geolocation)

Each vehicle with an approved route is tracked against that route: position along it (in planned
hours), progress, speed, heading, live ETA (remaining planned time + expected blockage delay from
the current hazard scores), the next hazardous or blocked segment ahead, and a breadcrumb trail.

The simulator moves trucks along the real road polylines at the planned speed for each segment,
compressed by a speed-up factor so a 12 h trip is watchable in a few minutes. A truck stops
before a blocked segment, raises an alert and waits; it moves on when the segment reopens.
A vehicle that starts sending its own positions (app / gps) is no longer driven by the simulator.
"""
from __future__ import annotations

import json
import math
import random
import threading
import time
from collections import deque

from .roads import haversine_km
from .routing import interp_p

TRAIL_POINTS = 600


def _bearing(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlon = math.radians(b[0] - a[0])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


class Fleet:
    def __init__(self, engine, speedup: float = 30.0):
        self.E = engine
        engine.fleet = self
        self.v: dict[str, dict] = {}
        self.trails: dict[str, deque] = {}
        self.speedup = speedup
        self.running = True
        self.lock = threading.RLock()
        self._thread = None
        # resume tracking for anything already in transit (e.g. after a restart with a persistent DB)
        for s in engine.db.q("SELECT shipment_id, route_id, vehicle_id FROM shipments WHERE status='in_transit'"):
            if s["route_id"] and s["vehicle_id"]:
                self.attach(s["vehicle_id"], s["route_id"], demo=True, start_fraction=random.random() * 0.8)

    # ------------------------------------------------------------------ route plan
    def _plan(self, legs):
        plan, t = [], 0.0
        for l in legs:
            if l["kind"] == "edge":
                coords = l.get("coords") or []
                if len(coords) < 2:
                    a, b = self.E.nodes[l["frm"]], self.E.nodes[l["to"]]
                    coords = [[a["lon"], a["lat"]], [b["lon"], b["lat"]]]
                cum = [0.0]
                for i in range(len(coords) - 1):
                    cum.append(cum[-1] + haversine_km(coords[i], coords[i + 1]))
                plan.append(dict(kind="edge", edge_id=l["edge_id"], frm=l["frm"], to=l["to"], name=f"{l['frm_name']} → {l['to_name']}",
                                 route_ref=l.get("route_ref"), mode=l["mode"], coords=coords, cum=cum, km=cum[-1] or 0.01,
                                 t_h=max(l["t_h"], 0.01), t0=t, t1=t + max(l["t_h"], 0.01), no_network=l.get("no_network")))
            else:
                n = self.E.nodes[l["at"]]
                plan.append(dict(kind="transfer", at=l["at"], name=f"Transfer {l['mode']} at {l['at_name']}", coords=[[n["lon"], n["lat"]]],
                                 cum=[0.0], km=0.0, t_h=l["t_h"], t0=t, t1=t + l["t_h"]))
            t = plan[-1]["t1"]
        return plan

    def attach(self, vehicle_id, route_id, source="sim", demo=False, start_fraction=0.0):
        rows = self.E.db.q("SELECT * FROM route_decisions WHERE route_id=?", (route_id,))
        if not rows:
            return
        r = rows[0]
        payload = json.loads(r["payload"])
        legs = json.loads(r["edges"])
        plan = self._plan(legs)
        total = plan[-1]["t1"] if plan else 0.0
        st = dict(vehicle_id=vehicle_id, route_id=route_id, shipment_id=r["shipment_id"], legs=plan, total_h=total,
                  pos_h=total * start_fraction, source=source, demo=demo, status="moving", hold_reason=None,
                  cargo_type=payload.get("cargo_type"), origin=payload.get("origin"), destination=payload.get("destination"),
                  profile=r["profile"], lat=None, lon=None, heading=0.0, speed_kmh=0.0, updated=time.time(),
                  arrived_at=None, offroute_km=0.0, alerted_edges=set())
        with self.lock:
            self.v[vehicle_id] = st
            self.trails[vehicle_id] = deque(maxlen=TRAIL_POINTS)
            self._place(st)

    def refresh_geometry(self):
        """Road polylines arrived (or changed): redraw every tracked route, keeping each truck's progress."""
        with self.lock:
            for st in self.v.values():
                for l in st["legs"]:
                    if l["kind"] != "edge":
                        continue
                    c = self.E.router.edge_coords(l["edge_id"], l["frm"])
                    cum = [0.0]
                    for i in range(len(c) - 1):
                        cum.append(cum[-1] + haversine_km(c[i], c[i + 1]))
                    l.update(coords=c, cum=cum, km=cum[-1] or 0.01)
                if st["legs"]:
                    self._place(st)

    # ------------------------------------------------------------------ geometry helpers
    def _leg_at(self, st, pos_h):
        for i, l in enumerate(st["legs"]):
            if pos_h <= l["t1"] or i == len(st["legs"]) - 1:
                return i, l
        return None, None

    def _point_on(self, leg, frac):
        if leg["kind"] != "edge":
            return leg["coords"][0], None
        d = frac * leg["km"]
        cum, c = leg["cum"], leg["coords"]
        for i in range(len(c) - 1):
            if d <= cum[i + 1] or i == len(c) - 2:
                seg = max(cum[i + 1] - cum[i], 1e-9)
                f = max(0.0, min(1.0, (d - cum[i]) / seg))
                p = [c[i][0] + (c[i + 1][0] - c[i][0]) * f, c[i][1] + (c[i + 1][1] - c[i][1]) * f]
                return p, _bearing(c[i], c[i + 1])
        return c[-1], None

    def _place(self, st):
        if not st["legs"]:
            return
        i, leg = self._leg_at(st, st["pos_h"])
        frac = (st["pos_h"] - leg["t0"]) / leg["t_h"] if leg["t_h"] else 1.0
        p, brg = self._point_on(leg, max(0.0, min(1.0, frac)))
        st["lon"], st["lat"] = p
        if brg is not None:
            st["heading"] = brg
        st["leg_index"] = i
        moving = st["status"] == "moving" and leg["kind"] == "edge"
        st["speed_kmh"] = round(leg["km"] / leg["t_h"], 1) if moving else 0.0

    # ------------------------------------------------------------------ simulator
    def step(self, dt_real: float):
        with self.lock:
            sc = self.E.scores()
            for st in self.v.values():
                if st["source"] != "sim" or not st["legs"]:
                    continue
                if st["status"] == "arrived":
                    if st["demo"] and time.time() - (st["arrived_at"] or 0) > 45:
                        st.update(pos_h=0.0, status="moving", arrived_at=None)
                        self.trails[st["vehicle_id"]].clear()
                    continue
                adv = dt_real * self.speedup / 3600.0
                new_pos = min(st["pos_h"] + adv, st["total_h"])
                # never drive into (or keep driving on) a blocked segment
                held = None
                for l in st["legs"]:
                    if l["kind"] != "edge" or l["t1"] <= st["pos_h"]:
                        continue
                    if l["t0"] > new_pos:
                        break
                    if sc[l["edge_id"]]["status"] == "blocked":
                        held = l
                        break
                if held:
                    st["pos_h"] = max(st["pos_h"], min(held["t0"], new_pos)) if held["t0"] > st["pos_h"] else st["pos_h"]
                    st["status"], st["hold_reason"] = "holding", f"Blocked ahead: {held['name']} ({held['route_ref']})"
                    if held["edge_id"] not in st["alerted_edges"]:
                        st["alerted_edges"].add(held["edge_id"])
                        self.E.db.append_server_event("alert", dict(
                            vehicle_id=st["vehicle_id"], route_id=st["route_id"], edge_id=held["edge_id"],
                            message=f"{st['vehicle_id']} holding before {held['name']}: segment blocked. Re-plan or wait for clearance.",
                            created_at=time.time()))
                else:
                    st["pos_h"] = new_pos
                    _, leg = self._leg_at(st, st["pos_h"])
                    st["status"] = "loading" if leg["kind"] == "transfer" else "moving"
                    st["hold_reason"] = leg["name"] if leg["kind"] == "transfer" else None
                    if st["pos_h"] >= st["total_h"] - 1e-9:
                        st["status"], st["arrived_at"] = "arrived", time.time()
                        self.E.db.x("UPDATE shipments SET status='delivered' WHERE shipment_id=? AND status='in_transit'",
                                    (st["shipment_id"],)) if not st["demo"] else None
                self._place(st)
                st["updated"] = time.time()
                self._trail(st)
                self._persist(st, offline=False)

    def _trail(self, st):
        tr = self.trails[st["vehicle_id"]]
        pt = [round(st["lon"], 5), round(st["lat"], 5)]
        if not tr or tr[-1][:2] != pt:
            tr.append(pt + [round(time.time(), 1)])

    def _persist(self, st, offline):
        self.E.db.x("INSERT INTO vehicle_status(vehicle_id, lat, lon, speed, load, offline_flag, last_seen, shipment_id, edge_id, pinged)"
                    " VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT(vehicle_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,"
                    " speed=excluded.speed, offline_flag=excluded.offline_flag, last_seen=excluded.last_seen,"
                    " edge_id=excluded.edge_id, pinged=1",
                    (st["vehicle_id"], st["lat"], st["lon"], st["speed_kmh"], st["cargo_type"], int(offline), time.time(),
                     st["shipment_id"], self._edge_now(st)))

    def _edge_now(self, st):
        i = st.get("leg_index")
        if i is None or not st["legs"]:
            return None
        return st["legs"][i].get("edge_id")

    # ------------------------------------------------------------------ real positions (app / phone GPS)
    def ingest(self, vehicle_id, lat, lon, speed_kmh=None, heading=None, ts=None, source="gps", offline=False):
        with self.lock:
            st = self.v.get(vehicle_id)
            if st is None:
                st = dict(vehicle_id=vehicle_id, route_id=None, shipment_id=None, legs=[], total_h=0.0, pos_h=0.0, source=source,
                          demo=False, status="moving", hold_reason=None, cargo_type=None, origin=None, destination=None, profile=None,
                          heading=0.0, speed_kmh=0.0, arrived_at=None, offroute_km=0.0, alerted_edges=set())
                self.v[vehicle_id] = st
                self.trails[vehicle_id] = deque(maxlen=TRAIL_POINTS)
            prev = (st.get("lon"), st.get("lat"))
            st.update(lat=lat, lon=lon, source=source, updated=ts or time.time())
            if heading is not None:
                st["heading"] = heading
            elif prev[0] is not None and (prev[0], prev[1]) != (lon, lat):
                st["heading"] = _bearing(prev, (lon, lat))
            st["speed_kmh"] = speed_kmh if speed_kmh is not None else st.get("speed_kmh", 0.0)
            st["status"] = "moving" if (st["speed_kmh"] or 0) > 2 else "stopped"
            if st["legs"]:
                self._snap(st, [lon, lat])
            self._trail(st)
            self._persist(st, offline)
            return self.describe(st)

    def _snap(self, st, p):
        """Project a real position onto the planned route to get progress and off-route distance."""
        best = (float("inf"), st["pos_h"], None)
        k = math.cos(math.radians(p[1]))
        window = st["pos_h"] - 1.0 if st["pos_h"] < st["total_h"] - 1e-6 else -1.0   # don't jump far backwards
        for i, l in enumerate(st["legs"]):
            if l["kind"] != "edge" or l["t1"] < window:
                continue
            c = l["coords"]
            for j in range(len(c) - 1):
                ax, ay, bx, by = c[j][0] * k, c[j][1], c[j + 1][0] * k, c[j + 1][1]
                dx, dy = bx - ax, by - ay
                t = max(0, min(1, ((p[0] * k - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy or 1)))
                d = math.hypot(p[0] * k - (ax + t * dx), p[1] - (ay + t * dy)) * 111
                if d < best[0]:
                    along = l["cum"][j] + t * (l["cum"][j + 1] - l["cum"][j])
                    best = (d, l["t0"] + along / l["km"] * l["t_h"], i)
        st["offroute_km"] = round(best[0], 2)
        if best[0] < 3.0:
            st["pos_h"], st["leg_index"] = best[1], best[2]

    # ------------------------------------------------------------------ views
    def describe(self, st, detail=False):
        sc = self.E.scores()
        nodes = self.E.nodes
        remaining_h, exp_delay, hazard = 0.0, 0.0, None
        if st["legs"]:
            remaining_h = max(st["total_h"] - st["pos_h"], 0.0)
            for l in st["legs"]:
                if l["t1"] <= st["pos_h"]:
                    continue
                start_in = max(l["t0"] - st["pos_h"], 0.0)
                if l["kind"] == "edge":
                    s = sc[l["edge_id"]]
                    blocked = s["status"] == "blocked"
                    p = 1.0 if blocked else interp_p(s["p"], start_in)
                    exp_delay += p * s["delay_if_blocked_h"]
                    if hazard is None and (blocked or p >= 0.35):
                        km_ahead = 0.0
                        for x in st["legs"]:
                            lo, hi = max(x["t0"], st["pos_h"]), min(x["t1"], l["t0"])
                            if hi > lo and x["t_h"]:
                                km_ahead += x["km"] * (hi - lo) / x["t_h"]
                        hazard = dict(edge_id=l["edge_id"], name=l["name"], route_ref=l["route_ref"], p=round(p, 3),
                                      blocked=blocked, in_h=round(start_in, 2), in_km=round(km_ahead, 1))
        leg = st["legs"][st.get("leg_index", 0)] if st["legs"] else None
        out = dict(vehicle_id=st["vehicle_id"], shipment_id=st["shipment_id"], route_id=st["route_id"], source=st["source"],
                   lat=st.get("lat"), lon=st.get("lon"), heading=round(st.get("heading") or 0, 1), speed_kmh=st.get("speed_kmh", 0),
                   status=st["status"], hold_reason=st["hold_reason"], cargo_type=st["cargo_type"], profile=st["profile"],
                   origin=st["origin"], destination=st["destination"],
                   origin_name=nodes[st["origin"]]["name"] if st["origin"] else None,
                   destination_name=nodes[st["destination"]]["name"] if st["destination"] else None,
                   progress=round(st["pos_h"] / st["total_h"], 4) if st["total_h"] else None,
                   eta_h=round(remaining_h + exp_delay, 2) if st["legs"] else None, expected_delay_h=round(exp_delay, 2),
                   current=leg["name"] if leg else None, current_edge=leg.get("edge_id") if leg else None,
                   no_network=bool(leg.get("no_network")) if leg else False, offroute_km=st["offroute_km"],
                   next_hazard=hazard, updated=st.get("updated"), stale_s=round(time.time() - (st.get("updated") or 0), 1))
        if detail:
            out["trail"] = list(self.trails.get(st["vehicle_id"], []))
            out["route"] = [c for l in st["legs"] if l["kind"] == "edge" for c in l["coords"]]
            out["legs"] = [dict(kind=l["kind"], name=l["name"], t0=round(l["t0"], 2), t1=round(l["t1"], 2), km=round(l["km"], 1),
                                edge_id=l.get("edge_id")) for l in st["legs"]]
        return out

    def snapshot(self):
        with self.lock:
            return [self.describe(st) for st in self.v.values() if st.get("lat") is not None]

    def detail(self, vehicle_id):
        with self.lock:
            st = self.v.get(vehicle_id)
            return self.describe(st, detail=True) if st else None

    def completed_h(self, vehicle_id):
        st = self.v.get(vehicle_id)
        return st["pos_h"] if st and st["legs"] else None

    def settings(self):
        return dict(speedup=self.speedup, running=self.running, vehicles=len(self.v),
                    simulated=sum(1 for s in self.v.values() if s["source"] == "sim"))

    # ------------------------------------------------------------------ thread
    def start(self, interval=1.0):
        def loop():
            last = time.time()
            while True:
                time.sleep(interval)
                t = time.time()
                if self.running:
                    try:
                        self.step(t - last)
                    except Exception as exc:          # keep the simulator alive
                        print("fleet step error:", exc)
                last = t
        self._thread = threading.Thread(target=loop, daemon=True, name="fleet-sim")
        self._thread.start()
