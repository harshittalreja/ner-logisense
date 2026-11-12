# Handover notes (26 Sep 2026)

The full briefing is **`NER-LogiSense_Briefing.pdf`**, which sits beside this project folder in the handover zip. This file is the short version, kept inside the repo.

## State of the project
- **Working prototype.** It has two runnable forms:
  - the Python server: `./run.sh`, then open http://localhost:8000
  - a browser-only build with the whole backend ported to JavaScript: `python -m tools.build_static`
- **Tests.** 19 tests pass: `pip install -r requirements-dev.txt && python -m pytest -q`.
- **Live demo link** (browser build, currently shared as "anyone with the link"; the original owner controls sharing): https://claude.ai/artifact/C2iBdy6CLC5pYNsj4oAWzC
- **Presentation.** `presentation/NER-LogiSense_Impact_Deck.pptx` (18 slides, with speaker notes).
  - Real-world figures and sources: `docs/EVIDENCE.md`.
  - Prototype figures: reproduce with `python -m tools.case_studies`.

## Recent changes (25–26 Sep)
- **Four genuinely different route options.** `alternatives()` in `backend/routing.py` uses the penalty method, an overlap filter and ETA tolerances per profile. It is mirrored in `frontend/js/localserver.js`.
- **Seeded field reports** (`DEMO_REPORTS` in `backend/engine.py` and `localserver.js`). Two of them auto-verify a closure of NH27 near Jatinga, so the Corridors, Live fleet and alert feeds all have data.
- **KPI replay.** Injected closures now last 4 days (`INJECTED_CLOSURE_H` in `backend/sim.py`) instead of forever. Previously a baseline truck that ran out of re-plans waited forever, which produced absurd averages.
- **Vercel target.** `python -m tools.build_static --vercel` writes `vercel-site/`, which uses online OpenStreetMap tiles and falls back to the built-in map.
- **New files:**
  - `tools/case_studies.py` and `analysis/case_studies.json`: every prototype number in the deck
  - `docs/EVIDENCE.md`: the real-world numbers, with sources

## Open work, in suggested order
1. **Public deployment.** Two routes:
   - Vercel (static): `npx vercel --prod` inside `vercel-site/`.
   - Render (full server): push to GitHub, then New → Blueprint (`render.yaml`, see `docs/DEPLOY.md`).
2. **Real phone GPS.** Add a "Share my location" switch in the driver app (`frontend/js/driver.js`). It should call `navigator.geolocation.watchPosition` and post to `POST /vehicles/{id}/position`, queuing positions while offline. The server side is already done. This needs HTTPS.
3. **Keep the two engines in sync.** Any change to `backend/routing.py`, `engine.py`, `tracking.py` or `sim.py` must be mirrored in `frontend/js/localserver.js`, or the browser build will behave differently from the server.
4. **Real data** (see `docs/DATA.md`):
   - closure logs from NHIDCL/BRO/PWD, and IMD rainfall
   - DEM-derived slope
   - GSI/NRSC inventory counts
   - then retrain with `python -m backend.risk.train`
5. **Reroute-quality KPI.** It sits at 44–60% against an 85% target in general monsoon runs. This is the main modelling weakness to work on (see the briefing, section 11).
