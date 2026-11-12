"""
Reproduce every prototype number used in the impact deck (presentation/NER-LogiSense_Impact_Deck.pptx).

    python -m tools.case_studies            # ~40 s; writes analysis/case_studies.json and prints a summary

All runs use the KPI replay (backend/sim.py) with its fixed seed (42), so results are deterministic
for a given model, network and code version. Baseline = shortest path on static travel times that
only learns of a blockage when it reaches it; NER-LogiSense = the recommended profile for the cargo.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from backend.engine import Engine
from backend.sim import run_replay

ROOT = Path(__file__).parents[1]
OUT = ROOT / "analysis" / "case_studies.json"
KEYS = ["trials", "mean_delay_baseline_h", "mean_delay_risk_aware_h", "delay_avoided_pct", "mean_trip_baseline_h",
        "mean_trip_risk_aware_h", "p90_trip_baseline_h", "p90_trip_risk_aware_h", "eta_error_baseline_pct",
        "eta_error_risk_aware_pct", "blockage_encounter_baseline_pct", "blockage_encounter_risk_aware_pct",
        "reroute_success_pct", "trips_exposed_baseline", "decision_latency_ms_p95", "cold_chain_breaches_baseline",
        "cold_chain_breaches_risk_aware", "cold_chain_flagged_before_breach_pct"]
BARAK = [("GHY", "SCR"), ("GHY", "AGT"), ("GHY", "AZL"), ("SLG", "SCR")]
DIMA_CUT = ["MBG-HRJ", "LMD-NHF-rail", "NHF-BDP-rail"]

RUNS = {
    # deck slide 14: all 12 corridor pairs, general freight, one run per rainfall scenario
    **{f"all_{sc}": dict(scenario=sc, trials=600, cargo="general")
       for sc in ["dry_winter", "normal_monsoon", "kameng_extreme", "teesta_extreme", "barak_extreme"]},
    # slide 8, case 1: NH10 closed at Sevoke-Teesta Bazar in a Teesta cloudburst, perishables
    "case1_nh10": dict(scenario="teesta_extreme", trials=300, cargo="perishable", od_pairs=[("SLG", "GTK")], closures=["SVK-TBZ"]),
    # slide 9, case 2: 2022-style Dima Hasao cut (NH27 + hill railway), medicines
    "case2_dima_extreme": dict(scenario="barak_extreme", trials=400, cargo="pharma", od_pairs=BARAK, closures=DIMA_CUT),
    "case2_dima_monsoon": dict(scenario="normal_monsoon", trials=400, cargo="pharma", od_pairs=BARAK, closures=DIMA_CUT),
    # slide 10, case 3: relief to Imphal with NH37 closed at Nungba-Noney
    "case3_manipur": dict(scenario="normal_monsoon", trials=300, cargo="relief", od_pairs=[("SCR", "IMP"), ("GHY", "IMP")], closures=["NGB-NNY"]),
    # slide 11, case 4: medicines on all 12 pairs in a typical July monsoon
    "case4_pharma_monsoon": dict(scenario="normal_monsoon", trials=600, cargo="pharma"),
}


def main():
    eng = Engine(db_path=Path(tempfile.mkdtemp()) / "cases.db")
    out = {}
    for name, kw in RUNS.items():
        k = run_replay(eng, **kw)
        out[name] = {"settings": {**kw, "od_pairs": kw.get("od_pairs", "all 12")}} | {x: k.get(x) for x in KEYS} | {"per_od": k["per_od"]}
        print(f"{name:24s} trip {k['mean_trip_baseline_h']:6.2f} -> {k['mean_trip_risk_aware_h']:6.2f} h | "
              f"P90 {k['p90_trip_baseline_h']:6.2f} -> {k['p90_trip_risk_aware_h']:6.2f} | "
              f"hits {k['blockage_encounter_baseline_pct']:5.1f}% -> {k['blockage_encounter_risk_aware_pct']:5.1f}% | "
              f"cold-chain {k.get('cold_chain_breaches_baseline')} -> {k.get('cold_chain_breaches_risk_aware')}")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1))
    print("written", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
