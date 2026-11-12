# API reference (summary)

Interactive, always-current docs: **http://localhost:8000/docs** (Swagger) and `/redoc`.

## Core endpoints (deck slide 8)
| Method & path | Purpose |
|---|---|
| `POST /route/optimize` | Four route options (fastest/balanced/safest/emergency) with metrics, cost breakdown, legs, geometry, explained alerts, recommendation + reason, comparison vs fastest. Stores every option in `route_decisions` as *proposed*. |
| `GET /risk/edge/{id}` | Current H(e,t), forecast +6/12/24 h, factor explanation, confidence, rainfall inputs, delay-if-blocked, recent incidents. |
| `POST /incident/report` | One report (idempotent on `event_id`). Snaps lat/lon to the nearest corridor segment. Two independent devices reporting a blockage within 6 h auto-verify it. |
| `GET /dashboard/corridors` | 12 corridors: health, P(disruption) now and within 24 h, expected delay, ETA σ, worst segment, blocked segments; alert feed; offline-sync stats. |
| `POST /sync/events` | Batch upload from an offline device plus download of everything since `cursor`. Events carry `event_id` (UUID), `origin_device` (≠ `device_id` means relayed over the mesh), `hops`, `created_at`. Returns `accepted`, `duplicates`, `events`, new `cursor`. |

## Supporting endpoints
`GET /network` · `GET /risk/edges` · `GET /weather` · `POST /weather/scenario` · `POST /weather/live` · `POST /shipments` · `GET /shipments` · `POST /route/{route_id}/approve` (a non-recommended route needs `override_reason`) · `POST /edges/{id}/status` (manual override, reason required) · `GET /vehicles` · `GET /incidents` · `POST /sim/replay` · `GET /model` · `GET /audit` · `GET /health`

## Live tracking
| Method & path | Purpose |
|---|---|
| `GET /stream/fleet` | Server-sent events: every vehicle once a second (position, heading, speed, status, progress, ETA, next hazard) |
| `GET /fleet` · `GET /fleet/{id}` | Snapshot of the fleet, or one vehicle with its trail and planned route |
| `POST /vehicles/{id}/position` | Live position from a device (`lat`, `lon`, `speed_kmh`, `heading`, `accuracy_m`, `ts`); the phone GPS entry point |
| `POST /fleet/sim` | Simulator speed-up (`speedup`, 1–600) and `running` |
| `GET /roads/status` · `GET /roads/export` | Progress of the OSRM road-shape download, and the cache file to commit |

## Example
```bash
curl -s -X POST localhost:8000/route/optimize -H 'Content-Type: application/json' \
  -d '{"origin":"SLG","destination":"GTK","cargo_type":"pharma","deadline_h":10}' | jq '.recommended, .comparison'

curl -s -X POST localhost:8000/sync/events -H 'Content-Type: application/json' -d '{
  "device_id":"TRK-A","cursor":0,"stats":{"created_total":1},
  "events":[{"event_id":"6f1c…","kind":"incident","origin_device":"TRK-A",
             "payload":{"type":"landslide","lat":26.98,"lon":88.45,"note":"both lanes"}}]}'
```
