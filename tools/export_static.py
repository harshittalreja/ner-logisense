"""Export the trained XGBoost model to a compact JSON the browser build evaluates directly
(tree arrays + covers for TreeSHAP), plus test vectors to check the JS port against Python."""
import json, math
from pathlib import Path
import numpy as np, xgboost as xgb

ROOT = Path(__file__).parents[1]
OUT = ROOT / "static-site" / "data"
OUT.mkdir(parents=True, exist_ok=True)
m = json.loads((ROOT / "backend/risk/artifacts/hazard_xgb.json").read_text())
L = m["learner"]
base_score = float(L["learner_model_param"]["base_score"].strip("[]"))
trees = []
for t in L["gradient_booster"]["model"]["trees"]:
    trees.append(dict(l=t["left_children"], r=t["right_children"], f=t["split_indices"],
                      c=[round(v, 7) for v in t["split_conditions"]], h=[round(v, 5) for v in t["sum_hessian"]]))
model = dict(base_margin=math.log(base_score / (1 - base_score)), trees=trees)
(OUT / "model.json").write_text(json.dumps(model, separators=(",", ":")))
(OUT / "metrics.json").write_text((ROOT / "backend/risk/artifacts/metrics.json").read_text())
(OUT / "network.json").write_text(json.dumps(json.loads((ROOT / "backend/data/network.json").read_text()), separators=(",", ":")))
# test vectors
b = xgb.Booster(); b.load_model(ROOT / "backend/risk/artifacts/hazard_xgb.json")
from backend.risk.generator import sample_training_set
X, _, _ = sample_training_set(json.loads((ROOT / "backend/data/network.json").read_text())["edges"], n=300, seed=99)
X = X.astype(np.float32).astype(float)
p = b.predict(xgb.DMatrix(X)); c = b.predict(xgb.DMatrix(X), pred_contribs=True)
(ROOT / "static-site" / "testvec.json").write_text(json.dumps(dict(X=X.tolist(), p=p.tolist(), c=c.tolist())))
print("model trees", len(trees), "size", (OUT / "model.json").stat().st_size, "base_margin", model["base_margin"])
