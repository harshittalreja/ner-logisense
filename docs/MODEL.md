# Model card: hazard model H(e,t)

**What it predicts:** the probability that network segment *e* (road, rail or ferry) is impassable within the next 12 hours.
**Version:** `hazard-xgb-1.0`. The router reads it at +0/6/12/24 h by rolling the rainfall window forward with the 24 h forecast.

## Inputs (12 features)
| Feature | Meaning | Source in prototype | Production source |
|---|---|---|---|
| slope_deg | mean hillside slope along the segment | estimate | CartoDEM / SRTM 30 m, sampled along the OSM polyline |
| elevation_km | max elevation | estimate | DEM |
| landslide_hist | mapped slides within 1 km, 1998–2022 | estimate | NRSC Landslide Atlas / GSI Bhukosh inventory, NASA COOLR |
| river_adjacent | road bed follows a river bank | manual | OSM waterways + buffer |
| mode_code | road / rail / ferry | graph | graph |
| rain_24h, rain_72h, rain_7d | observed rainfall | scenario / Open-Meteo | IMD gridded rainfall, AWS network |
| fcst_24h | forecast next 24 h | scenario / Open-Meteo | IMD / NCMRWF forecasts |
| id_ratio | rain ÷ Sikkim I-D threshold *I = 43.26·D^-0.78* (max over D = 1, 3 days) | derived | derived (regional thresholds per GSI/NLFC) |
| reports_6h | weighted driver reports in the last 6 h (1 vote per device; verified = 2; debris = 0.5) | sync feed | sync feed |
| monsoon | June–September | clock | clock |

## Model
XGBoost (`hist`, depth 5, early stopping) with **monotone constraints**: hazard can never fall when rain, slope, history, reports or river exposure rise. This keeps the model physically sensible, and it makes the TreeSHAP explanations safe to show to a dispatcher.

## Training data: synthetic, and why
There is no public segment-level, time-stamped record of NER road closures. `backend/risk/generator.py` generates 90,000 labelled rows from a physically motivated process:
- failure odds rise with I-D threshold exceedance × slope, antecedent saturation, forecast rain, landslide density, river-bank erosion and elevation;
- rail formations fail less often than hill roads, and ferries suspend at high river stage;
- driver reports are generated *after* the latent state, and only for blockages that have already happened.

Half the rows use the attributes of real graph edges (jittered); half use random terrain.

## Hold-out results (on synthetic labels)
| Model | ROC-AUC | PR-AUC | Brier |
|---|---|---|---|
| **XGBoost (monotone)** | **0.958** | **0.666** | **0.0178** |
| Logistic regression | 0.941 | 0.611 | 0.0194 |
| Rainfall-threshold rule only | 0.811 | 0.114 | 0.2496 |

The model beats the generator's own physical probability (AUC 0.933) because it also sees driver reports. At the "medium" alert threshold (p ≥ 0.35), precision is 0.69 and recall is 0.55. Calibration by decile is in `backend/risk/artifacts/metrics.json` and in the notebook.

**These numbers show that the pipeline learns the intended structure. They are not evidence of field accuracy.**

## Explanations
- Per-feature TreeSHAP contributions (`pred_contribs=True`) are grouped into six factors a dispatcher recognises: rainfall, steep terrain, landslide history, river bank, driver reports and mode.
- The headline lists the top positive factors, for example "High-risk edge: rainfall + steep terrain + landslide history". Reasons carry the actual values ("175 mm/24 h … 7.4× the I-D threshold").
- **Confidence** = 0.45 × data freshness (live 1.0, scenario 0.8, stale 0.6) + 0.35 × distance from the decision boundary + 0.20 × field corroboration.

## From probability to routing cost
- **Delay if blocked** = min(clearance wait, detour + 30 min).
  - The clearance wait grows with slope, landslide history and river washout, and is doubled for rail.
  - The detour is the cheapest way around the segment on the road graph.
- The router prices each segment at the hour the vehicle is expected to reach it: expected delay p·c and delay spread c·√(p(1−p)).

## Known limitations and next steps
1. Replace the synthetic labels with real closures from NHIDCL/PWD/BRO logs, news-scraped closures (NH10, NH6, NH27, NH37 are well covered) and COOLR/GSI events joined to segments. Then retrain and re-report.
2. Use region-specific I-D thresholds; the Sikkim threshold is used everywhere for now.
3. **GNN (deck slide 6):** network effects, meaning spill-over between adjacent segments and shared slopes, are not learned yet. A GraphSAGE layer over the edge-adjacency graph is the planned upgrade once real labels exist. With synthetic, per-edge independent labels there is nothing for it to learn.
4. Blockages are drawn independently per segment in the replay; real events are spatially clustered.
