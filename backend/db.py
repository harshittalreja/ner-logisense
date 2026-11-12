"""
SQLite persistence. Table names and key fields follow the data model in the proposal
(road_edges, hazard_events, shipments, vehicle_status, route_decisions) plus three support
tables: server_events (sync log with a monotonically increasing cursor), device_stats and
audit_log. docs/schema_postgis.sql has the equivalent PostGIS DDL for the production path.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).parents[1] / "ner_logisense.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS road_edges (
    edge_id TEXT PRIMARY KEY, source TEXT, target TEXT, mode TEXT, route_ref TEXT,
    geometry TEXT, road_class TEXT, slope REAL, elevation REAL, landslide_hist INTEGER,
    length_km REAL, last_status TEXT DEFAULT 'open', status_reason TEXT, status_updated REAL
);
CREATE TABLE IF NOT EXISTS hazard_events (
    event_id TEXT PRIMARY KEY, type TEXT, severity TEXT, geometry TEXT, edge_id TEXT,
    time_start REAL, time_end REAL, source TEXT, device_id TEXT, verified INTEGER DEFAULT 0,
    note TEXT, created_at REAL, received_at REAL, via TEXT, hops INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_hazard_edge_time ON hazard_events(edge_id, time_start);
CREATE TABLE IF NOT EXISTS shipments (
    shipment_id TEXT PRIMARY KEY, priority TEXT, origin TEXT, destination TEXT, cargo_type TEXT,
    temp_range TEXT, deadline REAL, weight_t REAL, status TEXT, route_id TEXT, vehicle_id TEXT,
    created_at REAL
);
CREATE TABLE IF NOT EXISTS vehicle_status (
    vehicle_id TEXT PRIMARY KEY, lat REAL, lon REAL, speed REAL, load TEXT,
    offline_flag INTEGER DEFAULT 0, last_sync REAL, last_seen REAL, shipment_id TEXT, edge_id TEXT, pinged INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS route_decisions (
    route_id TEXT PRIMARY KEY, shipment_id TEXT, profile TEXT, recommended_profile TEXT,
    edges TEXT, cost_breakdown TEXT, risk_score REAL, eta REAL, eta_p90 REAL, model_version TEXT,
    data_freshness TEXT, decision TEXT DEFAULT 'proposed', decided_by TEXT, override_reason TEXT,
    created_at REAL, decided_at REAL, payload TEXT
);
CREATE TABLE IF NOT EXISTS server_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, kind TEXT, device_id TEXT,
    payload TEXT, created_at REAL, received_at REAL
);
CREATE TABLE IF NOT EXISTS device_stats (
    device_id TEXT PRIMARY KEY, created_total INTEGER, received_total INTEGER, via_mesh INTEGER,
    last_sync REAL
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, actor TEXT, action TEXT, detail TEXT
);
"""


class DB:
    def __init__(self, path: Path | str = DB_PATH):
        self.path = str(path)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    # ---------------------------------------------------------------- generic
    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def x(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur

    def audit(self, actor: str, action: str, detail: dict):
        self.x("INSERT INTO audit_log(ts, actor, action, detail) VALUES (?,?,?,?)",
               (time.time(), actor, action, json.dumps(detail)))

    # ---------------------------------------------------------------- seed
    def seed_edges(self, edges: list[dict]):
        with self.lock:
            n = self.conn.execute("SELECT COUNT(*) FROM road_edges").fetchone()[0]
            if n:
                return
            self.conn.executemany(
                "INSERT INTO road_edges(edge_id, source, target, mode, route_ref, geometry, road_class, slope,"
                " elevation, landslide_hist, length_km) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(e["id"], e["source"], e["target"], e["mode"], e["route_ref"],
                  json.dumps({"type": "LineString", "coordinates": e["geometry"]}), e["road_class"],
                  e["slope_deg"], e["elevation_m"], e["landslide_hist"], e["length_km"]) for e in edges])
            self.conn.commit()

    # ---------------------------------------------------------------- edges
    def edge_status(self) -> dict[str, str]:
        return {r["edge_id"]: r["last_status"] for r in self.q("SELECT edge_id, last_status FROM road_edges")}

    def set_edge_status(self, edge_id: str, status: str, reason: str):
        self.x("UPDATE road_edges SET last_status=?, status_reason=?, status_updated=? WHERE edge_id=?",
               (status, reason, time.time(), edge_id))

    # ---------------------------------------------------------------- events
    def insert_hazard(self, ev: dict) -> bool:
        """Idempotent insert keyed on event_id. Returns True if new."""
        with self.lock:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO hazard_events(event_id, type, severity, geometry, edge_id, time_start,"
                " time_end, source, device_id, verified, note, created_at, received_at, via, hops)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (ev["event_id"], ev["type"], ev.get("severity", "medium"),
                 json.dumps({"type": "Point", "coordinates": [ev.get("lon"), ev.get("lat")]}),
                 ev.get("edge_id"), ev.get("created_at") or time.time(), None, ev.get("source", "driver"),
                 ev.get("device_id"), int(ev.get("verified", 0)), ev.get("note", ""),
                 ev.get("created_at") or time.time(), time.time(), ev.get("via", "direct"), int(ev.get("hops", 0))))
            self.conn.commit()
            return cur.rowcount > 0

    def append_server_event(self, kind: str, payload: dict, device_id: str | None = None,
                            event_id: str | None = None) -> int | None:
        with self.lock:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO server_events(event_id, kind, device_id, payload, created_at, received_at)"
                " VALUES (?,?,?,?,?,?)",
                (event_id or str(uuid.uuid4()), kind, device_id, json.dumps(payload),
                 payload.get("created_at") or time.time(), time.time()))
            self.conn.commit()
            return cur.lastrowid if cur.rowcount else None

    def server_events_since(self, cursor: int, limit: int = 500):
        rows = self.q("SELECT seq, event_id, kind, device_id, payload, created_at FROM server_events"
                      " WHERE seq > ? ORDER BY seq LIMIT ?", (cursor, limit))
        for r in rows:
            r["payload"] = json.loads(r["payload"])
        return rows

    def max_seq(self) -> int:
        r = self.q("SELECT COALESCE(MAX(seq), 0) AS m FROM server_events")
        return r[0]["m"]
