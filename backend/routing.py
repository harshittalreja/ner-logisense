"""
Hazard-aware multimodal route optimiser.

    Route cost = travel time + risk penalty + perishability penalty + reliability penalty

per edge e entered at time τ (hours after departure):
    t_e   = base time × rain slowdown                         (travel time)
    p_e   = H(e, τ)  interpolated from the model's +0/6/12/24 h forecasts
    c_e   = expected hours lost if e is blocked when reached
    d_e   = p_e · c_e                                          (expected delay)
    σ_e   = c_e · sqrt(p_e (1 − p_e))                          (delay spread)

    cost_e = t_e + α·d_e + k·(t_e + α·d_e) + γ·σ_e
             ────   ─────   ─────────────   ──────
             time   risk    perishability   reliability

α (risk aversion) and γ (reliability) come from the routing profile, k from the cargo type.
The graph is expanded to (node, mode) states so road↔rail↔ferry transfers carry their own
handling time. Search is a time-dependent Dijkstra: risk is read at the hour the vehicle is
expected to reach each edge, not at departure.
"""
from __future__ import annotations

import heapq
import math
import uuid
from dataclasses import dataclass

import numpy as np

HORIZONS = (0, 6, 12, 24)

PROFILES = {
    "fastest": dict(label="Fastest", alpha=0.0, gamma=0.0, avoid_p=None, use_k=True,
                    description="Shortest travel time. Respects confirmed closures but ignores hazard forecasts, "
                                "like a standard map router."),
    "balanced": dict(label="Balanced", alpha=1.0, gamma=0.0, avoid_p=None, use_k=True,
                     description="Minimises expected arrival: travel time plus expected blockage delay "
                                 "(risk-neutral), weighted for cargo perishability."),
    "safest": dict(label="Safest", alpha=2.5, gamma=1.5, avoid_p=0.5, use_k=True,
                   description="Strongly risk-averse. Excludes any edge with ≥50% blockage probability."),
    "emergency": dict(label="Emergency priority", alpha=1.0, gamma=0.0, avoid_p=0.75, use_k=False,
                      description="Minimises expected arrival time for relief/medical priority; "
                                  "uses every mode available."),
}

CARGO = {
    "general": dict(label="General freight", k=0.0, max_transit_h=None, temp_range=None, ferry_ok=True),
    "perishable": dict(label="Perishable food", k=0.35, max_transit_h=48, temp_range="0–10 °C", ferry_ok=True),
    "pharma": dict(label="Medicines / vaccines", k=0.6, max_transit_h=36, temp_range="2–8 °C", ferry_ok=True),
    "relief": dict(label="Relief material", k=0.25, max_transit_h=None, temp_range=None, ferry_ok=True),
    "fuel": dict(label="Fuel / LPG (hazmat)", k=0.1, max_transit_h=None, temp_range=None, ferry_ok=False),
}

TRANSFER_H = {("road", "rail"): 4.0, ("rail", "road"): 3.0, ("road", "ferry"): 1.5, ("ferry", "road"): 1.0}


def interp_p(pmap: dict, tau: float) -> float:
    if tau <= 0:
        return pmap[0]
    for a, b in zip(HORIZONS[:-1], HORIZONS[1:]):
        if tau <= b:
            w = (tau - a) / (b - a)
            return pmap[a] * (1 - w) + pmap[b] * w
    return pmap[24]


def travel_time(edge: dict, rain: dict) -> float:
    t = edge["base_time_h"]
    if edge["mode"] == "road":
        heavy = min(rain["rain_24h"], 200)
        factor = 0.0035 if edge["terrain"] != "plain" else 0.0012
        t *= 1 + factor * heavy
    return t


@dataclass
class Leg:
    kind: str          # edge | transfer
    edge_id: str | None
    frm: str
    to: str
    mode: str
    t: float
    p: float
    c: float
    enter_h: float


class Router:
    def __init__(self, network: dict):
        self.nodes = {n["id"]: n for n in network["nodes"]}
        self.edges = {e["id"]: e for e in network["edges"]}
        self.detour_extra = self._detours(network)
        self.adj: dict[tuple, list] = {}
        for e in network["edges"]:
            for a, b in ((e["source"], e["target"]), (e["target"], e["source"])):
                self.adj.setdefault((a, e["mode"]), []).append(("edge", e["id"], (b, e["mode"])))
        # transfers between modes at the same node
        modes_at: dict[str, set] = {}
        for (n, m) in list(self.adj):
            modes_at.setdefault(n, set()).add(m)
        for n, ms in modes_at.items():
            for a in ms:
                for b in ms:
                    if a != b and (a, b) in TRANSFER_H:
                        self.adj.setdefault((n, a), []).append(("transfer", None, (n, b)))

    @staticmethod
    def _detours(network) -> dict:
        """Extra hours to get around each road edge if it is closed (static times).

        A driver who finds a blockage can either wait for clearance or detour, so the delay
        a blockage really costs is min(wait, detour). Bridges in the graph (e.g. the Tawang
        spur) have no detour and return inf.
        """
        import networkx as nx
        G = nx.Graph()
        for e in network["edges"]:
            if e["mode"] == "road":
                G.add_edge(e["source"], e["target"], w=e["base_time_h"], id=e["id"])
        out = {}
        for e in network["edges"]:
            if e["mode"] != "road":
                out[e["id"]] = float("inf")
                continue
            a, b = e["source"], e["target"]
            G.remove_edge(a, b)
            try:
                alt = nx.shortest_path_length(G, a, b, weight="w")
                out[e["id"]] = round(alt - e["base_time_h"], 2)
            except nx.NetworkXNoPath:
                out[e["id"]] = float("inf")
            G.add_edge(a, b, w=e["base_time_h"], id=e["id"])
        return out

    def effective_delay(self, edge_id: str, wait_h: float) -> float:
        """Hours lost if the edge is blocked on arrival: wait for clearance or detour (+30 min to turn)."""
        return round(min(wait_h, self.detour_extra.get(edge_id, float("inf")) + 0.5), 2)

    # ------------------------------------------------------------------ search
    def search(self, origin, dest, scores, weather_for_edge, profile="balanced", cargo="general",
               modes=("road", "rail", "ferry"), exclude=frozenset(), knowledge="model", start_h=0.0,
               start_mode="road", penalty=None):
        """Return list[Leg] or None.

        knowledge="model" : uses hazard scores + closure status (risk-aware system)
        knowledge="naive" : static base times only; knows nothing but `exclude` (baseline router)
        """
        prof = PROFILES[profile]
        cg = CARGO[cargo]
        k = cg["k"] if prof["use_k"] else 0.0
        alpha, gamma, avoid_p = prof["alpha"], prof["gamma"], prof["avoid_p"]
        modes = set(modes)
        if not cg["ferry_ok"]:
            modes.discard("ferry")
        start = (origin, start_mode)
        dist = {start: 0.0}
        time_at = {start: start_h}
        prev: dict = {}
        pq = [(0.0, 0, start)]
        tick = 0
        done = set()
        while pq:
            cost, _, s = heapq.heappop(pq)
            if s in done:
                continue
            done.add(s)
            if s[0] == dest and s[1] == "road":
                break
            tau = time_at[s]
            for kind, eid, nxt in self.adj.get(s, []):
                if nxt in done or nxt[1] not in modes:
                    continue
                if kind == "transfer":
                    t = TRANSFER_H[(s[1], nxt[1])]
                    step = t * (1 + k)
                    leg = Leg("transfer", None, s[0], s[0], f"{s[1]}→{nxt[1]}", t, 0.0, 0.0, tau)
                else:
                    if eid in exclude:
                        continue
                    e = self.edges[eid]
                    rain = weather_for_edge(e)
                    if knowledge == "naive":
                        t, p, c = e["base_time_h"], 0.0, 0.0
                    else:
                        sc = scores[eid]
                        if sc["status"] == "blocked":
                            continue
                        t = travel_time(e, rain)
                        p = interp_p(sc["p"], tau)
                        c = self.effective_delay(eid, sc["delay_if_blocked_h"])
                        if avoid_p is not None and p >= avoid_p:
                            continue
                    d = p * c
                    sigma = c * math.sqrt(max(p * (1 - p), 0))
                    step = (t + alpha * d) * (1 + k) + gamma * sigma
                    if penalty and eid in penalty:          # used to find distinct alternative routes
                        step *= penalty[eid]
                    leg = Leg("edge", eid, s[0], nxt[0], e["mode"], t, p, c, tau)
                nc = cost + step
                if nc < dist.get(nxt, float("inf")):
                    dist[nxt] = nc
                    # expected clock time at next state includes expected delay (risk-neutral clock)
                    time_at[nxt] = tau + leg.t + leg.p * leg.c
                    prev[nxt] = (s, leg)
                    tick += 1
                    heapq.heappush(pq, (nc, tick, nxt))
        goal = (dest, "road")
        if goal not in prev and origin != dest:
            return None
        legs = []
        s = goal
        while s in prev:
            s, leg = prev[s]
            legs.append(leg)
        return legs[::-1]

    # ------------------------------------------------------------------ evaluation
    def evaluate(self, legs, profile, cargo, deadline_h=None, n_mc=600, seed=11):
        prof = PROFILES[profile]
        cg = CARGO[cargo]
        k = cg["k"] if prof["use_k"] else 0.0
        alpha, gamma = prof["alpha"], prof["gamma"]
        edges_ = [l for l in legs if l.kind == "edge"]
        travel = sum(l.t for l in legs)
        exp_delay = sum(l.p * l.c for l in edges_)
        risk_pen = alpha * exp_delay
        peri_pen = k * (travel + risk_pen)
        rel_pen = gamma * sum(l.c * math.sqrt(max(l.p * (1 - l.p), 0)) for l in edges_)
        dist_km = sum(self.edges[l.edge_id]["length_km"] for l in edges_)

        rng = np.random.default_rng(seed)
        if edges_:
            P = np.array([l.p for l in edges_])
            C = np.array([l.c for l in edges_])
            hits = rng.random((n_mc, len(edges_))) < P
            sev = rng.uniform(0.5, 1.5, (n_mc, len(edges_)))
            total = travel + (hits * sev * C).sum(axis=1)
        else:
            total = np.full(n_mc, travel)
        p_any = 1 - float(np.prod([1 - l.p for l in edges_])) if edges_ else 0.0
        out = dict(
            distance_km=round(dist_km, 1),
            travel_time_h=round(travel, 2),
            expected_delay_h=round(exp_delay, 2),
            eta_expected_h=round(travel + exp_delay, 2),
            eta_p50_h=round(float(np.percentile(total, 50)), 2),
            eta_p90_h=round(float(np.percentile(total, 90)), 2),
            risk_score=round(p_any, 3),
            max_edge_p=round(max((l.p for l in edges_), default=0.0), 3),
            cost_breakdown=dict(travel_time=round(travel, 2), risk_penalty=round(risk_pen, 2),
                                perishability_penalty=round(peri_pen, 2), reliability_penalty=round(rel_pen, 2)),
            total_cost=round(travel + risk_pen + peri_pen + rel_pen, 2),
            modes=sorted({l.mode for l in edges_}),
            transfers=sum(1 for l in legs if l.kind == "transfer"),
        )
        if deadline_h:
            out["p_late"] = round(float((total > deadline_h).mean()), 3)
        if cg["max_transit_h"]:
            out["p_cold_chain_breach"] = round(float((total > cg["max_transit_h"]).mean()), 3)
            out["max_transit_h"] = cg["max_transit_h"]
        return out

    def edge_coords(self, edge_id: str, frm: str):
        """Edge polyline oriented in the direction of travel (road geometry when available)."""
        e = self.edges[edge_id]
        coords = e["geometry"]
        return coords if frm == e["source"] else coords[::-1]

    def legs_json(self, legs):
        out = []
        for l in legs:
            if l.kind == "transfer":
                out.append(dict(kind="transfer", at=l.frm, at_name=self.nodes[l.frm]["name"], mode=l.mode,
                                t_h=round(l.t, 2), enter_h=round(l.enter_h, 2)))
            else:
                e = self.edges[l.edge_id]
                out.append(dict(kind="edge", edge_id=l.edge_id, frm=l.frm, to=l.to,
                                frm_name=self.nodes[l.frm]["name"], to_name=self.nodes[l.to]["name"],
                                mode=l.mode, route_ref=e["route_ref"], length_km=e["length_km"],
                                t_h=round(l.t, 2), p=round(l.p, 3), delay_if_blocked_h=l.c,
                                detour_extra_h=(None if self.detour_extra[l.edge_id] == float("inf")
                                                else self.detour_extra[l.edge_id]),
                                enter_h=round(l.enter_h, 2), no_network=e["no_network"],
                                coords=self.edge_coords(l.edge_id, l.frm)))
        return out

    def geometry(self, legs):
        coords = []
        for l in legs:
            if l.kind != "edge":
                continue
            c = self.edge_coords(l.edge_id, l.frm)
            coords.extend(c if not coords else c[1:])
        return coords


PROFILE_ORDER = ("fastest", "safest", "balanced", "emergency")


def signature(legs):
    return tuple(l.edge_id or l.mode for l in legs)


# how much slower (expected arrival) than the quickest option a substitute route may be, per profile
ALT_TOLERANCE = {"safest": 1.5, "balanced": 1.35, "emergency": 1.2}


def alternatives(router, origin, dest, scores, wfe, cargo, modes, deadline_h=None, max_cands=6, rounds=12):
    """Four route options that differ whenever the network allows it.

    Each profile first gets its own optimum. Extra candidate paths come from the penalty method
    (edges already used get more expensive each round), like the "alternative routes" of a maps app;
    candidates that mostly overlap one already found are dropped. When two profiles land on the same
    path, the later one takes the best remaining candidate by its own criterion, provided its expected
    arrival is within ALT_TOLERANCE of the quickest option, and says so in `note`. Otherwise both keep
    the same path (the UI shows "same path as ...").
    Returns {profile: (legs, note)}.
    """
    own = {}
    for prof in PROFILE_ORDER:
        legs = router.search(origin, dest, scores, wfe, prof, cargo, modes)
        if legs is not None:
            own[prof] = legs
    if not own:
        return {}

    def km_of(legs):
        return {l.edge_id: router.edges[l.edge_id]["length_km"] for l in legs if l.kind == "edge"}

    def mostly_same(legs, others, limit=0.8):
        a = km_of(legs)
        tot = sum(a.values()) or 1.0
        return any(sum(v for k, v in a.items() if k in km_of(o)) / tot >= limit for o in others)

    cands, sigs = [], set()
    for legs in own.values():
        if signature(legs) not in sigs:
            sigs.add(signature(legs)); cands.append(legs)
    extra, penalty = [], {}
    for _ in range(rounds):
        if len(cands) + len(extra) >= max_cands:
            break
        for legs in cands + extra:
            for l in legs:
                if l.kind == "edge":
                    penalty[l.edge_id] = penalty.get(l.edge_id, 1.0) + 0.4
        legs = router.search(origin, dest, scores, wfe, "balanced", cargo, modes, penalty=penalty)
        if legs is None:
            break
        if signature(legs) not in sigs:
            sigs.add(signature(legs))
            if not mostly_same(legs, cands + extra):
                extra.append(legs)

    metrics = {}
    def m_of(prof, legs):
        k = (prof, signature(legs))
        if k not in metrics:
            metrics[k] = router.evaluate(legs, prof, cargo, deadline_h, n_mc=300)
        return metrics[k]

    def key(prof, legs):
        m = m_of(prof, legs)
        if prof == "fastest":
            return m["travel_time_h"]
        if prof == "safest":
            return (m["risk_score"], m["eta_p90_h"])
        if prof == "balanced":
            return m["eta_expected_h"] + 0.3 * max(m["eta_p90_h"] - m["eta_expected_h"], 0)
        return m["eta_expected_h"]

    best_eta = min(m_of("balanced", c)["eta_expected_h"] for c in cands + extra)
    chosen, used = {}, {}
    for prof in PROFILE_ORDER:
        if prof not in own:
            continue
        sig = signature(own[prof])
        if sig not in used:
            chosen[prof], used[sig] = (own[prof], None), prof
            continue
        tol = ALT_TOLERANCE.get(prof, 1.0) * best_eta
        rest = [c for c in cands + extra if signature(c) not in used and m_of(prof, c)["eta_expected_h"] <= tol
                and not mostly_same(c, [chosen[p][0] for p in chosen])]
        if rest:
            best = min(rest, key=lambda c: key(prof, c))
            chosen[prof] = (best, f"The {PROFILES[prof]['label'].lower()} path is the same as the "
                                  f"{PROFILES[used[sig]]['label']} route; this is the best different route by the same measure.")
            used[signature(best)] = prof
        else:
            chosen[prof] = (own[prof], None)
    return chosen


def recommend(results: dict, priority: str, cargo: str) -> tuple[str, str]:
    """Pick the profile a dispatcher should start from, with a one-line reason."""
    if priority == "critical" and "emergency" in results:
        return "emergency", "Critical priority: minimise expected arrival across all modes."
    best, best_score = None, float("inf")
    for name, r in results.items():
        m = r["metrics"]
        spread = max(m["eta_p90_h"] - m["eta_expected_h"], 0.0)
        weight = 0.8 if cargo in ("pharma", "perishable") else 0.0
        score = m["eta_expected_h"] + weight * spread + 12 * m.get("p_late", 0) + 12 * m.get("p_cold_chain_breach", 0)
        if score < best_score:
            best, best_score = name, score
    reason = {
        "fastest": "Hazard is low on the fast route; no penalty for taking it.",
        "balanced": "Lowest expected arrival once blockage risk is priced in.",
        "safest": "Risk on faster routes outweighs the extra distance.",
        "emergency": "Lowest expected arrival time once blockage risk is priced in.",
    }[best]
    return best, reason


def new_route_id() -> str:
    return "R-" + uuid.uuid4().hex[:8].upper()
