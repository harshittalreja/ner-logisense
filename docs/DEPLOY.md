# Deploying NER-LogiSense (Render, free tier)

You end up with a public HTTPS address, e.g. `https://ner-logisense.onrender.com`. It serves:

- the dispatcher at `/`
- the driver app at `/driver`
- the API docs at `/docs`

Phones can open it too, and a public HTTPS address is also what phone GPS will need later.

## 1. Put the code on GitHub
Create an empty repository, e.g. `ner-logisense`, and push this folder to it:
```bash
git init && git add . && git commit -m "NER-LogiSense prototype"
git branch -M main
git remote add origin https://github.com/<you>/ner-logisense.git
git push -u origin main
```

## 2. Create the service on Render
1. Sign in at https://render.com with your GitHub account.
2. Choose **New → Blueprint**, pick the repository, then **Apply**. Render reads `render.yaml`:
   - build: `pip install -r requirements.txt`
   - start: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
   - health check: `/health`
   - Python 3.11, free plan
3. The first build takes about 3–5 minutes. Render then shows the URL.

Every `git push` to `main` redeploys automatically.

## 3. What happens on first start
- **Seeded demo.** Eight demo shipments are approved, and simulated trucks start driving them.
- **Road shapes.** The server downloads real road shapes and distances for the 87 road segments from the public OSRM server. This takes about 2 minutes at 1 request per second. The map shows *"Loading real road shapes…"* until it finishes, then routes follow the actual highways.
- **Map tiles.** They come from OpenFreeMap (OpenStreetMap data) directly into the browser. They need no key and no setup.

To avoid the 2-minute download on every cold start, save the downloaded shapes into the repo once:
1. Open `https://<your-app>.onrender.com/roads/export`.
2. Save the file as `backend/data/road_geometry.json`.
3. Commit and push it.

You can also run `python -m tools.fetch_road_geometry` locally with internet access, which does the same.

## Free-tier behaviour to know about
- **Sleeping.** The service sleeps after 15 minutes without traffic. The next visit wakes it in about 30–60 seconds, so open the link a minute before a demo.
- **No persistent disk.** Shipments, reports and the audit log reset when the service restarts, and the demo data is re-seeded. For persistent data, add a Render PostgreSQL database or a paid disk and point `NER_DB` at it (see `docs/schema_postgis.sql`).
- **Shared routing server.** The public OSRM demo server is for light, non-commercial use. For anything beyond a student demo, run your own OSRM or GraphHopper with the India extract.

## Settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `NER_DB` | `ner_logisense.db` | SQLite file path |
| `NER_SEED_DEMO` | `1` | Seed the demo shipments on start |
| `NER_FLEET_SIM` | `1` | Run the truck simulator |
| `NER_SIM_SPEEDUP` | `30` | Simulator speed (30 = a 12 h trip takes 24 min); also adjustable in the Live fleet tab |
| `NER_ROADS_FETCH` | `1` | Download missing road shapes from OSRM in the background |

## Next: real phone GPS
The server already accepts live positions at `POST /vehicles/{vehicle_id}/position` (`lat`, `lon`, `speed_kmh`, `heading`, `accuracy_m`, `ts`). Positions go through the same pipeline as the simulated trucks: snapping to the route, progress, live ETA, hazard ahead and the trail.

A vehicle that sends its own positions is no longer moved by the simulator. The remaining step is a "Share my location" switch in the driver app that calls `navigator.geolocation.watchPosition` and posts to that endpoint, queuing positions while offline. Browsers only allow location on HTTPS, which the Render URL provides.
