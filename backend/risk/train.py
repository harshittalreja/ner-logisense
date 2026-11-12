"""
Train the edge hazard model H(e,t) = P(segment blocked within 12 h | features).

    python -m backend.risk.train

Outputs (backend/risk/artifacts/):
    hazard_xgb.json   – XGBoost booster
    metrics.json      – hold-out metrics, baselines, calibration table, feature importance
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import xgboost as xgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score, average_precision_score
from sklearn.model_selection import train_test_split

from .features import FEATURES
from .generator import sample_training_set

ART = Path(__file__).with_name("artifacts")
NETWORK = Path(__file__).parents[1] / "data" / "network.json"
MODEL_VERSION = "hazard-xgb-1.0"

# Hazard must never go DOWN when rain, slope, history or reports go UP. Monotone constraints
# keep the model physically sensible and its explanations trustworthy.
MONOTONE = {"slope_deg": 1, "landslide_hist": 1, "rain_24h": 1, "rain_72h": 1, "rain_7d": 1,
            "fcst_24h": 1, "id_ratio": 1, "reports_6h": 1, "river_adjacent": 1}


def calibration_table(y, p, bins=10):
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    edges[0], edges[-1] = 0, 1
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo)
        if m.sum():
            out.append(dict(p_lo=round(float(lo), 4), p_hi=round(float(hi), 4), n=int(m.sum()),
                            mean_pred=round(float(p[m].mean()), 4), observed=round(float(y[m].mean()), 4)))
    return out


def main(n: int = 90_000):
    t0 = time.time()
    network = json.loads(NETWORK.read_text())
    X, y, p_true = sample_training_set(network["edges"], n=n)
    Xtr, Xte, ytr, yte, _, pte_true = train_test_split(X, y, p_true, test_size=0.2, random_state=1, stratify=y)
    Xtr, Xva, ytr, yva = train_test_split(Xtr, ytr, test_size=0.15, random_state=2, stratify=ytr)

    cons = "(" + ",".join(str(MONOTONE.get(f, 0)) for f in FEATURES) + ")"
    clf = xgb.XGBClassifier(
        n_estimators=600, max_depth=5, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9,
        min_child_weight=5, reg_lambda=1.0, monotone_constraints=cons, eval_metric="logloss",
        early_stopping_rounds=40, tree_method="hist",
    )
    clf.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
    p = clf.predict_proba(Xte)[:, 1]

    # Baseline 1: the classic rainfall-threshold rule (alert if I-D threshold exceeded).
    idr = Xte[:, FEATURES.index("id_ratio")]
    rule = np.clip(idr / 3, 0, 1)
    # Baseline 2: logistic regression on the same features.
    lr = LogisticRegression(max_iter=2000).fit(Xtr, ytr)
    p_lr = lr.predict_proba(Xte)[:, 1]

    def scores(pp):
        return dict(auc=round(roc_auc_score(yte, pp), 4), pr_auc=round(average_precision_score(yte, pp), 4),
                    brier=round(brier_score_loss(yte, pp), 5), logloss=round(log_loss(yte, np.clip(pp, 1e-6, 1 - 1e-6)), 4))

    # alert-level confusion at the dispatcher threshold (p >= 0.35 → "medium" alert or higher)
    thr = 0.35
    pred = p >= thr
    tp = int((pred & (yte == 1)).sum()); fp = int((pred & (yte == 0)).sum()); fn = int((~pred & (yte == 1)).sum())
    booster = clf.get_booster()
    gain = booster.get_score(importance_type="total_gain")
    total = sum(gain.values()) or 1
    importance = sorted(((FEATURES[int(k[1:])], round(v / total, 4)) for k, v in gain.items()), key=lambda t: -t[1])

    ART.mkdir(exist_ok=True)
    booster.save_model(ART / "hazard_xgb.json")
    metrics = dict(
        model_version=MODEL_VERSION, trained_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        n_train=len(ytr), n_val=len(yva), n_test=len(yte), positive_rate=round(float(y.mean()), 4),
        best_iteration=int(clf.best_iteration), features=FEATURES, monotone=MONOTONE,
        test=dict(xgboost=scores(p), logistic_regression=scores(p_lr), rainfall_threshold_rule=scores(rule),
                  oracle_generator=scores(pte_true)),
        alert_threshold=thr,
        alert_confusion=dict(tp=tp, fp=fp, fn=fn, precision=round(tp / max(tp + fp, 1), 3),
                             recall=round(tp / max(tp + fn, 1), 3)),
        calibration=calibration_table(yte, p),
        importance=importance,
        train_seconds=round(time.time() - t0, 1),
        data_note="Synthetic labels from backend/risk/generator.py (physically-motivated). "
                  "Replace with real closure logs for a pilot.",
    )
    (ART / "metrics.json").write_text(json.dumps(metrics, indent=1))
    print(json.dumps({k: metrics[k] for k in ("model_version", "test", "alert_confusion", "importance")}, indent=1))


if __name__ == "__main__":
    main()
