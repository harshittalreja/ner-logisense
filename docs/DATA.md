# Data: provenance and the path to real data

## What ships in the prototype
| Layer | File | Status |
|---|---|---|
| Corridor graph: 85 nodes, 102 edges (road 87, rail 13, ferry 2), 12 corridors, 17 met zones | `backend/data/build_network.py` → `network.json` | Real towns, NH numbers, rail lines and ferries; town-level coordinates; real road/rail polylines from `backend/data/road_geometry.json` (97 of 100 segments) |
| Segment length | haversine × sinuosity (plain 1.25, hill 1.55, mountain 1.75) | Estimated; checked against known road distances (Siliguri–Gangtok 114 km, Guwahati–Shillong ~100 km, Silchar–Aizawl ~180 km) |
| Truck speeds | 45 / 25 / 18 km/h on NH plain / hill / mountain; rail 30 km/h; ferry 10 km/h | Assumptions |
| Slope, elevation, landslide history, river bank, no-network flag | per edge in `build_network.py` | Expert estimates, set higher on the documented hotspots |
| Rainfall | `backend/weather.py` | Open-Meteo live (7-day history + 24 h forecast), or 5 replay scenarios |

## Replacing each estimate (pilot plan)
1. **Road geometry.** Use OSMnx `graph_from_place` / `graph_from_bbox` for the pilot corridor with `custom_filter='["highway"~"trunk|primary|secondary"]'`, simplify the graph, and keep NH refs. Load it into `road_edges` (PostGIS DDL in `schema_postgis.sql`).
2. **Slope and elevation.** Sample Bhuvan CartoDEM v3 (30 m) or SRTM every 100 m along each polyline and keep the mean and p90 of the upslope within 50 m (rasterio + shapely).
3. **Landslide history.** Take the NRSC/ISRO Landslide Atlas inventory, GSI Bhukosh landslide points and NASA COOLR events. Count them with `ST_DWithin(edge, point, 1000 m)`.
4. **Rainfall.** Use IMD gridded daily rainfall (0.25°) for history and IMD/NCMRWF district forecasts for the forecast. Keep Open-Meteo as a fallback. The adapter interface is `WeatherState.values[zone] = {rain_24h, rain_72h, rain_7d, fcst_24h}`, so moving to per-edge grids only changes `for_edge()`.
5. **Labels.**
   - Closure events from NHIDCL, PWD and BRO control rooms, the state DDMA daily situation reports, and news archives (NH10, NH6, NH27, NH37 closures are reported daily in monsoon).
   - Normalise each to (segment, start, end, cause) and build 12-hour windows.
   - Retrain with `backend/risk/train.py`, swapping `sample_training_set` for the real loader.
6. **Coverage.** Mark no-network stretches from TRAI/operator coverage maps or from drive-test logs collected by the driver app itself (`offline_flag` in `vehicle_status`).

## Map boundaries
The online basemaps are OpenFreeMap styles built on OpenStreetMap, with a built-in basemap (`frontend/basemap/`, from MoRTH/Indian Railways/Natural Earth data) as the fallback. Maps published in India, including in government submissions, must show the boundaries of India as published by the Survey of India. For any official use, swap the styles in `BASEMAPS` / `resolveStyle()` in `frontend/js/common.js` for Bhuvan WMS tiles or a licensed Indian basemap. The corridor overlay does not change.

## Live rainfall
`POST /weather/live` calls
`https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&hourly=precipitation&past_days=7&forecast_days=2`
for all 17 met-zone points in one request. If the call fails (no internet, firewall), the API returns 502 with the error and the app keeps the current scenario. The freshness chip always shows which source is in use.
