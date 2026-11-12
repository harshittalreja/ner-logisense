"""
KPI replay: risk-aware routing vs baseline shortest-path routing on the same simulated world.

For each trial:
  1. Pick an origin-destination pair and draw the *true* rainfall = scenario forecast × forecast
     error (lognormal, σ=0.3 per zone), so the model never sees the exact truth.
  2. Draw true blockages from the physical generator (backend/risk/generator.py): each edge fails
     with its true probability, at an onset time U(−6 h, +18 h) around dispatch, for a duration of
     ~2× the expected delay-if-blocked. Blockages that started before dispatch are reported by a
     driver with probability 0.7 (so the risk-aware system may know about them; the baseline never does).
     Injected closures (from the UI) last INJECTED_CLOSURE_H = 96 h (a multi-day closure) and are reported.
  3. BASELINE plans on static travel times (a standard map router). RISK-AWARE plans with the
     hazard model (Balanced profile, or Emergency for critical cargo).
  4. Both vehicles drive their routes through the same true world. On reaching a blocked edge
     the driver either waits for clearance or replans from the current node, whichever its own
     planner thinks is faster. Realised arrival times are recorded.

KPIs follow the proposal's slide "Measuring success".
"""
from __future__ import annotations

import time

import numpy as np

from .risk.features import build_row, delay_if_blocked_h
from .risk.generator import true_block_prob
from .routing import CARGO, PROFILES, recommend, travel_time

OD_PAIRS = [("SLG", "GTK"), ("GHY", "SCR"), ("GHY", "IMP"), ("GHY", "AZL"), ("GHY", "AGT"),
            ("SCR", "IMP"), ("GHY", "TWG"), ("DMR", "IMP"), ("SLG", "SCR"), ("GHY", "SHL"),
            ("SCR", "AGT"), ("GHY", "DBR")]


class _Weather:
    """Minimal stand-in for WeatherState with per-trial values."""

    def __init__(self, values, month):
        self.values, self.month = values, month

    def for_edge(self, zones):
        vals = [self.values[z] for z in zones if z in self.values]
        return {k: max(v[k] for v in vals) for k in vals[0]}


# injected closures clear after 4 days, like the longer NH10 / NH27 closures (a truck stuck behind
# one waits until it clears or finds a detour)
INJECTED_CLOSURE_H = 96.0


def run_replay(engine, scenario: str | None = None, trials: int = 120, closures=(), seed: int = 42,
               cargo: str = "general", od_pairs=None, profile: str | None = None):
    from .weather import SCENARIOS

    rng = np.random.default_rng(seed)
    base_weather = engine.weather
    if scenario and scenario != "current":
        sc = SCENARIOS[scenario]
        forecast = {z["id"]: dict(sc["zones"].get(z["id"], sc["default"])) for z in engine.network["met_zones"]}
        month = sc["month"]
    else:
        forecast = {k: dict(v) for k, v in base_weather.values.items()}
        month = base_weather.month
    edges = engine.network["edges"]
    eids = [e["id"] for e in edges]
    router = engine.router
    closures = set(closures)
    pairs = od_pairs or OD_PAIRS
    rows_out = []
    latencies = []

    for trial in range(trials):
        o, d = pairs[trial % len(pairs)]
        # --- true world -----------------------------------------------------------------------
        truth_vals = {}
        for z, v in forecast.items():
            f = float(rng.lognormal(0, 0.3))
            truth_vals[z] = {k: v[k] * f for k in v}
        true_w = _Weather(truth_vals, month)
        X = np.array([build_row(e, true_w.for_edge(e["met_zones"]), 0, month) for e in edges])
        p_true = true_block_prob(X)
        blocked = rng.random(len(edges)) < p_true
        # closure lasts ~2x the expected remaining wait; onset spread so that P(blocked at a given
        # moment in the next 12 h) stays close to the generator's probability
        dur = np.array([delay_if_blocked_h(e, true_w.for_edge(e["met_zones"])) for e in edges]) * 2 \
            * rng.uniform(0.5, 1.5, len(edges))
        onset = rng.uniform(-dur, 12.0)
        windows = {}
        known_reports = {}
        for i, eid in enumerate(eids):
            if eid in closures:
                windows[eid] = (-24.0, INJECTED_CLOSURE_H)   # a multi-day closure, not a permanent one
                known_reports[eid] = 2.0
            elif blocked[i]:
                windows[eid] = (onset[i], onset[i] + dur[i])
                if onset[i] < -0.5 and rng.random() < 0.7:     # already happened and a driver reported it
                    known_reports[eid] = float(1 + rng.poisson(0.8))

        # --- what the risk-aware system believes ---------------------------------------------
        fc_w = _Weather(forecast, month)
        status = {eid: ("blocked" if eid in closures else "open") for eid in eids}
        scores = engine.model.score_all(edges, fc_w, known_reports, status)

        def wfe(e, _w=fc_w):
            return _w.for_edge(e["met_zones"])

        # the risk-aware system proposes all four profiles and the dispatcher takes the recommendation
        t0 = time.perf_counter()
        options = {}
        for prof in PROFILES:
            legs_p = router.search(o, d, scores, wfe, prof, cargo)
            if legs_p is not None:
                options[prof] = dict(legs=legs_p, metrics=router.evaluate(legs_p, prof, cargo, n_mc=200))
        latencies.append((time.perf_counter() - t0) * 1000)
        if not options:
            continue
        chosen = profile if profile in options else \
            recommend(options, "critical" if cargo == "relief" else "normal", cargo)[0]
        aware_legs = options[chosen]["legs"]
        naive_legs = router.search(o, d, scores, wfe, "fastest", cargo, knowledge="naive")
        if aware_legs is None or naive_legs is None:
            continue
        aware_eval = options[chosen]["metrics"]
        true_t = {e["id"]: travel_time(e, true_w.for_edge(e["met_zones"])) for e in edges}
        free_flow = sum(true_t[l.edge_id] if l.kind == "edge" else l.t for l in naive_legs)
        static_eta = sum(l.t for l in naive_legs)

        mt = CARGO[cargo]["max_transit_h"]

        def drive(legs, knowledge, prof):
            """Returns (arrival_h, blockages_hit, replans, first_time_breach_was_foreseeable)."""
            clock, hits, replans, excl = 0.0, 0, 0, set()
            flag_at = None
            i = 0
            planned = list(legs)
            node = o
            while i < len(planned):
                l = planned[i]
                if l.kind == "edge":
                    w = windows.get(l.edge_id)
                    if w and w[0] <= clock < w[1]:
                        hits += 1
                        excl.add(l.edge_id)
                        wait = w[1] - clock
                        rest_old = sum(x.t for x in planned[i:])
                        alt = None
                        if replans < 4:
                            alt = router.search(node, d, scores, wfe, prof, cargo, knowledge=knowledge,
                                                exclude=frozenset(excl), start_h=clock)
                        alt_t = sum(x.t + (x.p * x.c if knowledge == "model" else 0) for x in alt) if alt else 1e9
                        best = min(alt_t, wait + rest_old)
                        if mt and flag_at is None and clock + best > mt:
                            flag_at = clock          # driver report tells the dispatcher now
                        if alt and alt_t < wait + rest_old:
                            planned, i, replans = alt, 0, replans + 1
                            continue
                        clock += wait
                    clock += true_t[l.edge_id]
                    node = l.to
                else:
                    clock += l.t
                i += 1
            return clock, hits, replans, flag_at

        t_base, hits_b, rp_b, _ = drive(naive_legs, "naive", "fastest")
        t_aware, hits_a, rp_a, flag_a = drive(aware_legs, "model", chosen)
        if mt and aware_eval.get("p_cold_chain_breach", 0) >= 0.2:
            flag_a = 0.0                     # flagged at dispatch
        rows_out.append(dict(
            od=f"{o}-{d}", free_flow_h=free_flow,
            base_t=t_base, aware_t=t_aware, base_hits=hits_b, aware_hits=hits_a,
            base_eta_pred=static_eta, aware_eta_pred=aware_eval["eta_expected_h"],
            base_delay=t_base - free_flow, aware_delay=t_aware - free_flow,
            aware_breach_flag=(flag_a is not None and flag_a < mt) if mt else None,
            aware_breach=(t_aware > mt) if mt else None, base_breach=(t_base > mt) if mt else None,
        ))

    if not rows_out:
        return dict(error="no routable trials")
    R = rows_out
    n = len(R)
    mean = lambda k: float(np.mean([r[k] for r in R]))
    base_delay, aware_delay = mean("base_delay"), mean("aware_delay")
    # ETA accuracy: mean absolute percentage error of the ETA promised at dispatch
    mape = lambda pred, act: float(np.mean([abs(r[pred] - r[act]) / r[act] for r in R]))
    exposed = [r for r in R if r["base_hits"] > 0]
    reroute_success = (np.mean([r["aware_hits"] == 0 for r in exposed]) if exposed else None)
    kpis = dict(
        trials=n,
        mean_delay_baseline_h=round(base_delay, 2), mean_delay_risk_aware_h=round(aware_delay, 2),
        delay_avoided_pct=round(100 * (base_delay - aware_delay) / base_delay, 1) if base_delay > 0 else 0.0,
        mean_trip_baseline_h=round(mean("base_t"), 2), mean_trip_risk_aware_h=round(mean("aware_t"), 2),
        p90_trip_baseline_h=round(float(np.percentile([r["base_t"] for r in R], 90)), 2),
        p90_trip_risk_aware_h=round(float(np.percentile([r["aware_t"] for r in R], 90)), 2),
        eta_error_baseline_pct=round(100 * mape("base_eta_pred", "base_t"), 1),
        eta_error_risk_aware_pct=round(100 * mape("aware_eta_pred", "aware_t"), 1),
        blockage_encounter_baseline_pct=round(100 * np.mean([r["base_hits"] > 0 for r in R]), 1),
        blockage_encounter_risk_aware_pct=round(100 * np.mean([r["aware_hits"] > 0 for r in R]), 1),
        reroute_success_pct=round(100 * float(reroute_success), 1) if reroute_success is not None else None,
        trips_exposed_baseline=len(exposed),
        decision_latency_ms_mean=round(float(np.mean(latencies)), 1),
        decision_latency_ms_p95=round(float(np.percentile(latencies, 95)), 1),
    )
    if CARGO[cargo]["max_transit_h"]:
        breaches = [r for r in R if r["aware_breach"]]
        kpis["cold_chain_breaches_baseline"] = sum(1 for r in R if r["base_breach"])
        kpis["cold_chain_breaches_risk_aware"] = len(breaches)
        kpis["cold_chain_flagged_before_breach_pct"] = (
            round(100 * np.mean([r["aware_breach_flag"] for r in breaches]), 1) if breaches else None)
    # distribution for the chart
    kpis["delay_hist"] = _hist([r["base_delay"] for r in R], [r["aware_delay"] for r in R])
    per_od = {}
    for r in R:
        s = per_od.setdefault(r["od"], dict(od=r["od"], n=0, base=0.0, aware=0.0))
        s["n"] += 1
        s["base"] += r["base_delay"]
        s["aware"] += r["aware_delay"]
    kpis["per_od"] = [dict(od=v["od"], n=v["n"], base_delay_h=round(v["base"] / v["n"], 2),
                           aware_delay_h=round(v["aware"] / v["n"], 2)) for v in per_od.values()]
    kpis["scenario"] = scenario or "current"
    kpis["cargo"] = cargo
    kpis["closures"] = sorted(closures)
    return kpis


def _hist(a, b):
    bins = [0, 0.5, 2, 6, 12, 24, 48, 1e9]
    labels = ["<0.5 h", "0.5–2 h", "2–6 h", "6–12 h", "12–24 h", "24–48 h", ">48 h"]
    ha = np.histogram(np.clip(a, 0, None), bins)[0].tolist()
    hb = np.histogram(np.clip(b, 0, None), bins)[0].tolist()
    return [dict(bin=l, baseline=x, risk_aware=y) for l, x, y in zip(labels, ha, hb)]
