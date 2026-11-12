"""
Runtime hazard model: scores every edge, forecasts H(e, t+h), explains each score with
per-feature SHAP contributions (XGBoost TreeSHAP via pred_contribs) and attaches a confidence.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import xgboost as xgb

from .features import FEATURES, build_row, delay_if_blocked_h, id_threshold, shift_rain

ART = Path(__file__).with_name("artifacts")
HORIZONS = (0, 6, 12, 24)

# Features are grouped into the factors a dispatcher understands.
GROUPS = {
    "rain": ("Rainfall", ["rain_24h", "rain_72h", "rain_7d", "fcst_24h", "id_ratio", "monsoon"]),
    "slope": ("Steep terrain", ["slope_deg", "elevation_km"]),
    "history": ("Landslide history", ["landslide_hist"]),
    "river": ("River-bank alignment", ["river_adjacent"]),
    "reports": ("Driver reports", ["reports_6h"]),
    "mode": ("Transport mode", ["mode_code"]),
}


def level(p: float, status: str = "open") -> str:
    if status == "blocked":
        return "blocked"
    if p >= 0.6:
        return "high"
    if p >= 0.35:
        return "medium"
    if p >= 0.15:
        return "elevated"
    return "low"


class HazardModel:
    def __init__(self):
        self.booster = xgb.Booster()
        try:
            self.booster.load_model(ART / "hazard_xgb.json")
            self.metrics = json.loads((ART / "metrics.json").read_text())
        except Exception:
            # missing artifacts or a model file from an incompatible XGBoost version: retrain (~10 s)
            from . import train
            train.main()
            self.booster = xgb.Booster()
            self.booster.load_model(ART / "hazard_xgb.json")
            self.metrics = json.loads((ART / "metrics.json").read_text())
        self.version = self.metrics["model_version"]

    # ------------------------------------------------------------------ scoring
    def _dm(self, rows):
        return xgb.DMatrix(np.asarray(rows, dtype=float), feature_names=None)

    def predict(self, rows) -> np.ndarray:
        return self.booster.predict(self._dm(rows))

    def contributions(self, rows) -> np.ndarray:
        return self.booster.predict(self._dm(rows), pred_contribs=True)

    def score_all(self, edges: list[dict], weather, reports: dict[str, float], status: dict[str, str]):
        """Return {edge_id: {...}} with p at each horizon, delay-if-blocked and level."""
        rows, keys = [], []
        rains = {}
        for e in edges:
            base = weather.for_edge(e["met_zones"])
            rains[e["id"]] = base
            r6 = reports.get(e["id"], 0.0)
            for h in HORIZONS:
                decay = math.exp(-h / 12.0)   # reports age out
                rows.append(build_row(e, shift_rain(base, h), r6 * decay, weather.month))
                keys.append((e["id"], h))
        preds = self.predict(rows)
        out = {}
        for (eid, h), p in zip(keys, preds):
            out.setdefault(eid, {"p": {}})["p"][h] = float(p)
        for e in edges:
            d = out[e["id"]]
            st = status.get(e["id"], "open")
            d["status"] = st
            d["p_now"] = 1.0 if st == "blocked" else d["p"][0]
            d["p_max24"] = 1.0 if st == "blocked" else max(d["p"].values())
            d["delay_if_blocked_h"] = delay_if_blocked_h(e, rains[e["id"]])
            d["level"] = level(d["p_now"], st)
            d["rain"] = rains[e["id"]]
            d["reports_6h"] = reports.get(e["id"], 0.0)
        return out

    # ------------------------------------------------------------------ explanation
    def explain(self, edge: dict, rain: dict, reports_6h: float, month: int, freshness: float,
                status: str = "open", verified: int = 0) -> dict:
        row = build_row(edge, rain, reports_6h, month)
        contrib = self.contributions([row])[0]           # len(FEATURES) + 1 (bias)
        p = float(self.predict([row])[0])
        bias = float(contrib[-1])
        feat = dict(zip(FEATURES, (float(c) for c in contrib[:-1])))
        factors = []
        for key, (label, names) in GROUPS.items():
            v = sum(feat[n] for n in names)
            factors.append(dict(key=key, label=label, logodds=round(v, 3), detail=self._detail(key, edge, rain, reports_6h)))
        factors.sort(key=lambda f: -f["logodds"])
        pushing = [f for f in factors if f["logodds"] > 0.15 and f["detail"]]
        total_pos = sum(f["logodds"] for f in factors if f["logodds"] > 0) or 1.0
        for f in factors:
            f["share"] = round(max(f["logodds"], 0) / total_pos, 3)
        if status == "blocked":
            headline = "Blocked: verified report or authority closure"
        elif pushing:
            headline = f"{level(p).capitalize()}-risk edge: " + " + ".join(f["label"].lower() for f in pushing[:3])
        else:
            headline = "Low risk: no strong hazard drivers"
        conf = self.confidence(p, freshness, reports_6h, verified, status)
        return dict(p=round(p, 4), level=level(p, status), headline=headline, factors=factors,
                    base_logodds=round(bias, 3), confidence=conf,
                    reasons=[f["detail"] for f in pushing[:4]], model_version=self.version)

    @staticmethod
    def _detail(key, e, r, reports):
        if key == "rain":
            thr1, thr3 = id_threshold(1), id_threshold(3) * 3
            ex = max(r["rain_24h"] / thr1, r["rain_72h"] / thr3)
            txt = f"{r['rain_24h']:.0f} mm/24 h, {r['rain_72h']:.0f} mm/72 h"
            if ex >= 1:
                txt += f" ({ex:.1f}× the I-D landslide threshold)"
            if r["fcst_24h"] >= 30:
                txt += f"; {r['fcst_24h']:.0f} mm more forecast"
            return txt
        if key == "slope":
            return f"{e['slope_deg']}° mean slope, {e['terrain']} section" if e["slope_deg"] >= 12 else ""
        if key == "history":
            return f"{e['landslide_hist']} mapped slides within 1 km" if e["landslide_hist"] else ""
        if key == "river":
            return f"road bed along the {e['river']}" if e["river"] else ""
        if key == "reports":
            return f"{reports:.0f} driver report(s) in last 6 h" if reports >= 0.5 else ""
        if key == "mode":
            return {"rail": "rail formation", "ferry": "ferry: suspended in high river stage"}.get(e["mode"], "")
        return ""

    @staticmethod
    def confidence(p: float, freshness: float, reports: float, verified: int, status: str) -> dict:
        """How much a dispatcher should trust this alert (0-1), with the reasons."""
        if status == "blocked":
            return dict(score=0.97 if verified else 0.85, label="High",
                        basis="Closure confirmed" if verified else "Authority / dispatcher override")
        certainty = abs(p - 0.5) * 2                     # far from the decision boundary = surer
        corroboration = min(reports, 2) / 2
        score = 0.45 * freshness + 0.35 * certainty + 0.20 * corroboration
        label = "High" if score >= 0.75 else "Medium" if score >= 0.55 else "Low"
        basis = []
        basis.append("live rainfall" if freshness >= 1 else "scenario rainfall" if freshness >= 0.8 else "stale rainfall")
        if reports >= 1:
            basis.append(f"{reports:.0f} field report(s)")
        if certainty < 0.3:
            basis.append("score near decision boundary")
        return dict(score=round(score, 2), label=label, basis=", ".join(basis))
