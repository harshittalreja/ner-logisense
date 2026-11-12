# NER-LogiSense: working prototype

Hazard-aware logistics for the hill corridors of Northeast India. This is a runnable prototype of the system in the *NER-LogiSense* proposal. It covers:

- **An edge-level hazard model H(e,t).** For every road, rail and ferry segment it gives the probability that the segment is blocked. It uses rainfall (observed and forecast), slope, landslide history, river-bank alignment and live driver reports. Forecasts are given for +0, +6, +12 and +24 h. Every score is explained with TreeSHAP factor contributions and carries a confidence score.
- **A hazard-aware multimodal route optimiser.** It implements the proposal's cost function, *route cost = travel time + risk penalty + perishability penalty + reliability penalty*. It offers four profiles (Fastest, Balanced, Safest, Emergency) across road, rail and ferry, and runs in about 5–20 ms per query.
- **A dispatcher web app on a real street map.** It uses OpenStreetMap maps via MapLibre and OpenFreeMap, with no API key, and offers Streets, Light, Dark and Satellite map types. If the online tiles cannot load, it falls back to a built-in basemap (national highways, railways, rivers, towns) that needs no tile server. Routes follow the actual highways: 97 of 100 road and rail segments are snapped to the official MoRTH National Highway and Indian Railways lines, with OSRM as a fallback. The display works like a maps app: a blue recommended route, grey alternatives you can click, travel-time bubbles, A/B pins, and risky stretches coloured along the route like a traffic layer. It has six tabs:
  - **Directions:** plan a shipment, compare routes, read explained alerts, then approve (a human decision that is audited).
  - **Live fleet:** trucks move on the map in real time, with a trail, speed, progress, live ETA, the next hazard ahead and a Follow button.
  - **Corridors:** the district-authority view of 12 NH corridors, with an alert feed and manual overrides.
  - **Shipments:** the warehouse and cold-chain view, with deadline slack, cold-chain margin and hand-over suggestions.
  - **KPI replay:** risk-aware routing against shortest-path routing on simulated events.
  - **Audit:** a log of every approval, override and scenario change.
- **Live tracking pipeline.** For now, simulated trucks drive the approved routes along the real road shapes. They stop before a blocked segment and raise an alert. Their positions stream to the map once a second over server-sent events.
  - Real phone GPS will use the same endpoint (`POST /vehicles/{id}/position`), with the same route snapping, ETA and trail.
  - A vehicle that sends its own positions takes over from the simulator.
- **An offline-first driver app (PWA).** A service worker keeps it working with no signal. Drivers report hazards with one tap. Reports are queued on the device (IndexedDB) and passed to nearby vehicles over a simulated convoy mesh. Whichever device reaches signal first syncs them, and duplicates are ignored.
- **All five API endpoints from the proposal** (`/route/optimize`, `/risk/edge/{id}`, `/incident/report`, `/dashboard/corridors`, `/sync/events`) plus supporting ones, with interactive docs at `/docs`.

---

## Quick start

**Needs:** Python 3.10+ and a modern browser (Chrome or Edge recommended for the PWA and mesh demo).

```bash
# macOS / Linux
./run.sh
# Windows
run.bat
# or by hand
pip install -r requirements.txt
uvicorn backend.main:app --port 8000
```

| Open | What it is |
|---|---|
| http://localhost:8000/ | Dispatcher console |
| http://localhost:8000/driver?vehicle=TRK-AS01 | Driver app for a seeded vehicle |
| http://localhost:8000/docs | Interactive API docs (Swagger) |

On first start the server seeds eight demo shipments that are already in transit, plus eight driver field reports (two of which auto-verify a closure of NH27 near Jatinga). Delete `ner_logisense.db` to reset everything.

With Docker: `docker build -t ner-logisense . && docker run -p 8000:8000 -v $(pwd)/data:/data ner-logisense`

**Deploy for a public link** (free, Render): see [docs/DEPLOY.md](docs/DEPLOY.md). `render.yaml` is already set up; push to GitHub, then **New → Blueprint** on Render.

**Internet is optional.** Online map tiles come from OpenFreeMap; without them the built-in basemap is used. Real road shapes are already committed in `backend/data/road_geometry.json`, so nothing needs downloading.

**Browser-only build (no Python server).** `python -m tools.build_static` writes `static-site/`, in which the whole backend runs as JavaScript inside the page (`frontend/js/localserver.js`). `python -m tools.build_static --vercel` writes `vercel-site/`, ready for Vercel or any static host. See `HANDOFF.md`.

Tests: `pip install -r requirements-dev.txt && python -m pytest -q`. There are 19 tests. They cover distinct route alternatives, the seeded field reports, blocked-edge avoidance, idempotent sync, auto-verification, the < 2 s latency KPI, the truck simulator (including holding at blocked segments), GPS takeover and road-geometry validation.

---

## A 5-minute demo (follows slide 9 of the deck)

The full script is in [docs/DEMO.md](docs/DEMO.md). The short version:

1. **Create a shipment.** In *Dispatch*, choose Siliguri → Gangtok, *Medicines / vaccines*, deadline 10 h.
2. **Compare routes.** In the top bar, switch the rainfall to *Replay: Teesta valley cloudburst*. NH10 turns red. The recommendation moves to the NH717A bypass via Lava and states what it avoids and what that costs.
3. **Receive an explained alert.** Click the NH10 alert: *"High-risk edge: rainfall + steep terrain + landslide history"*. It shows 175 mm/24 h (7.4× the I-D landslide threshold), a 33° slope, 26 mapped slides and the Teesta bank, plus a +6/12/24 h forecast and a confidence score.
4. **Approve.** Choosing Fastest instead of the recommended route forces you to give an override reason, which lands in the *Audit* log.
5. **Sync offline reports.** Open `/driver?vehicle=TRK-AS01` and `/driver?vehicle=TRK-WB07` in two tabs. Put both in airplane mode, report a landslide in one tab, and watch it arrive in the other over the mesh. Take the second vehicle back online: the report reaches the server marked *via mesh*. Two independent reports on the same segment auto-verify it as **blocked**, and every router avoids it from then on.
6. **Prove the impact.** In *KPI replay*, pick a scenario and cargo, optionally click road segments to inject closures, and run 400 trials of risk-aware routing against shortest-path routing.

---

## Architecture

```
┌──────────────────────── Data ingestion ────────────────────────┐
│ Open-Meteo rainfall (IMD stand-in) · scenario replays ·        │
│ corridor graph (OSM-style) · driver incident feed (sync)       │
└──────────────┬─────────────────────────────────────────────────┘
               ▼
┌──────────── Spatial data store ─────────────┐   ┌────────────── AI services ──────────────────────┐
│ SQLite (prototype) / PostGIS (production):  │   │ Feature builder → H(e,t) XGBoost (monotone)     │
│ road_edges · hazard_events · shipments ·    │──▶│ TreeSHAP explanations + confidence              │
│ vehicle_status · route_decisions ·          │   │ Time-dependent multimodal Dijkstra (4 profiles) │
│ server_events (sync log) · audit_log        │   │ Monte-Carlo ETA / P90 / P(late) / cold chain    │
└─────────────────────────────────────────────┘   │ KPI replay simulator                            │
                                                  └───────────────┬─────────────────────────────────┘
                                                                  ▼
             ┌─────────────────────────── Applications (FastAPI + static) ───────────────────────────┐
             │ Dispatcher web app (MapLibre) · Driver PWA (service worker, IndexedDB, mesh) · REST API │
             └────────────────────────────────────────────────────────────────────────────────────────┘
      Cross-cutting: idempotent offline sync (G-Set of UUID events + server cursor) · audit trail ·
                     human approval for every dispatch · model version + data freshness on every decision
```

| Proposal (deck) | Prototype | File |
|---|---|---|
| OpenStreetMap road graph | Real corridor graph of 85 nodes and 102 edges (road, rail, ferry) along the actual NH corridors | `backend/data/build_network.py` |
| IMD rainfall API | Open-Meteo (free, no key) plus five replayable scenarios | `backend/weather.py` |
| Bhuvan / NRSC layers | Per-edge slope, elevation, landslide history and river bank (estimated; see DATA.md) | `backend/data/build_network.py` |
| XGBoost / Random Forest | XGBoost with monotone constraints, compared against logistic regression and the threshold rule | `backend/risk/train.py` |
| Graph Neural Network | Not built. Network effects come from corridor-level aggregation and detour-aware delay (see MODEL.md) | – |
| OSRM / GraphHopper | OSRM supplies real road shapes and distances per segment; route *choice* is a custom time-dependent Dijkstra, because OSRM cannot take a per-hour risk cost | `backend/roads.py`, `backend/routing.py` |
| PostGIS | SQLite with the same tables; PostGIS DDL provided | `backend/db.py`, `docs/schema_postgis.sql` |
| React + MapLibre | Vanilla JS modules + MapLibre GL 5 on OpenFreeMap (OpenStreetMap) tiles; no build step | `frontend/` |
| Flutter / PWA | PWA (service worker + IndexedDB) | `frontend/driver.html`, `frontend/sw.js` |
| Bluetooth / Wi-Fi Direct mesh | Simulated with BroadcastChannel between tabs; same gossip protocol | `frontend/js/driver.js` |

---

## What is real, and what is simulated

Being explicit about this matters for evaluators.

| Real | Estimated or simulated |
|---|---|
| Towns, junctions, NH numbers, rail lines (incl. Bairabi–Sairang, opened Sept 2025) and ferries | Coordinates are town-level. Road shapes and distances come from OSRM/OpenStreetMap once downloaded; until then, edges are straight lines with estimated lengths |
| Known chronic hotspots: Chitrey/Selfie Dara (NH10), Sonapur (NH6), Dima Hasao (NH27), Pagla Pahar (NH29), Noney (NH37) | Slope, elevation and landslide-history counts are expert estimates, not DEM or inventory extracts |
| Sikkim rainfall I-D threshold *I = 43.26·D^-0.78* used as a model feature | **Training labels are synthetic.** They come from a physically motivated generator, because no segment-level closure dataset exists publicly yet |
| Open-Meteo live rainfall works whenever the server has internet access | Scenario rainfall magnitudes are illustrative, patterned on the May 2022 Barak and Aug 2025 Teesta events |
| Offline sync, idempotency, auto-verification, audit and human-in-the-loop all work end to end | Convoy mesh is BroadcastChannel between browser tabs, not radio |

`docs/DATA.md` sets out the concrete pipeline for replacing each estimate with real data during the pilot: OSMnx, CartoDEM/SRTM, the NASA COOLR and GSI inventories, IMD, and NHIDCL/PWD closure logs.

## KPI replay: what it currently shows

> **Note (26 Sep 2026):** the table below is from the notebook (5 seeds × 400 trials) and predates the alternative-routes change and the 4-day injected closures. The numbers used in the current presentation come from `python -m tools.case_studies`, which writes `analysis/case_studies.json` (see `docs/EVIDENCE.md` for the real-world figures).

Measured on the simulated world, as the mean of 5 seeds × 400 trials. These are **not pilot claims**; they show how the method behaves. `notebooks/hazard_model.ipynb` reproduces the table with ± values.

| Scenario · cargo | Mean delay avoided | Blockage encounters (baseline → risk-aware) | ETA error | P90 trip | Cold-chain breaches /400 |
|---|---|---|---|---|---|
| Dry season · general | 0% | 3.4% → 3.2% | 1.9% → 3.7% | 20.7 → 20.7 h | – |
| Normal monsoon · general | +3% | 16.3% → 10.5% | 14.2% → 12.9% | 28.5 → 25.4 h | – |
| Normal monsoon · medicines | −30% (by design) | 16.3% → 6.5% | 14.2% → 9.0% | 28.5 → 26.5 h | **22 → 9** |
| Teesta cloudburst · general | +6% | 16.9% → 13.2% | 15.1% → 13.1% | 25.4 → 24.0 h | – |
| Barak extreme · general | +10% | 41.0% → 40.0% | 35.4% → 32.0% | 61.8 → 60.4 h | – |
| Kameng extreme · general | +4% | 12.1% → 11.1% | 11.2% → 11.7% | 23.6 → 23.1 h | – |

The honest reading:
- For general cargo the recommended route never loses mean time. It reduces exposure to blockages and tightens the tail.
- For cold-chain cargo the recommendation deliberately pays mean time to protect the safe-transit limit. Breaches fall by about 60%.
- In a region-wide extreme like the Barak valley in 2022, no route is clean, so the value there is early warning and hold/hand-over advice.
- Decision latency is a few milliseconds per query, well inside the 2 s target.
- The < 15% ETA-error target is met in normal conditions but not in extremes. Reroute quality (> 85%) is far from met, because in the extreme scenarios many trips have no safe alternative. Both are the right things to track in a pilot.

---

## Project layout

```
backend/
  main.py            FastAPI app: all endpoints, serves the frontend
  engine.py          scoring, optimisation, incidents, sync, corridors, shipments
  routing.py         cost function, profiles, time-dependent multimodal Dijkstra, Monte-Carlo ETA
  weather.py         Open-Meteo client + replay scenarios
  sim.py             KPI replay (risk-aware vs shortest path on the same simulated world)
  roads.py           real road shapes + distances from OSRM, validated and cached
  tracking.py        live fleet: position ingest (sim / app / GPS), route snapping, ETA, trails, truck simulator
  db.py              SQLite schema (5 proposal tables + sync log + audit)
  data/              corridor graph builder + network.json
  risk/              features, synthetic generator, training, runtime model + explanations
frontend/
  index.html, js/dispatcher.js    dispatcher console
  driver.html, js/driver.js       driver PWA
  sw.js, manifest.json            offline support
  js/common.js, css/app.css       shared
notebooks/hazard_model.ipynb      ML notebook (training, baselines, calibration, SHAP, KPI replay)
docs/                             DEMO, MODEL, DATA, API, PostGIS schema
tests/test_api.py                 end-to-end tests
```

Retrain the model with `python -m backend.risk.train`. Rebuild the graph after editing it with `python -m backend.data.build_network`.

## Sources

- NRSC/ISRO, *Landslide Atlas of India* (2023)
- Harilal, G.T. et al. (2019), "Towards establishing rainfall thresholds for a real-time landslide early warning system in Sikkim, India", *Landslides*: https://link.springer.com/article/10.1007/s10346-019-01244-1
- NH10 six-day closure at 9th Mile and Selfie Dara (Aug 2025): https://www.newsonair.gov.in/nh-10-reopens-after-six-days-of-landslide-disruption-in-sikkim-and-kalimpong
- Dima Hasao May 2022 landslides cutting NH27 and the Lumding–Badarpur line: https://www.eastmojo.com/northeast-news/2022/05/17/landslides-snap-road-rail-links-to-assam-tripura-mizoram-manipur/ · https://blogs.agu.org/landslideblog/2022/11/07/dima-hasao-1/
- Sonapur (NH6) recurring slides: https://barakbulletin.com/silchar-shillong-road-another-landslide-near-sonapur-tunnel-on-nh-6-disrupts-vehicular-traffic/
- NH37 Noney landslides: https://northeasttoday.in/northeast/manipur-fresh-landslide-hits-nh-37-in-noney-district-strands-vehicles-on-both-sides/
- Bairabi–Sairang railway: https://www.insightsonindia.com/2025/09/13/bairabi-sairang-railway-line/
- NASA COOLR landslide catalog: https://gpm.nasa.gov/landslides/data.html
- Open-Meteo API: https://open-meteo.com/en/docs
