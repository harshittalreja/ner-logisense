-- NER-LogiSense: production schema (PostgreSQL 15 + PostGIS 3).
-- The prototype runs the same tables on SQLite (backend/db.py) with GeoJSON text geometry.
-- Moving to PostGIS changes storage and spatial queries, not the API.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE road_edges (
    edge_id         TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    target          TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('road', 'rail', 'ferry')),
    route_ref       TEXT,                       -- NH10, NFR Hill Section …
    geometry        GEOMETRY(LineString, 4326) NOT NULL,
    road_class      TEXT,
    slope           REAL,                       -- mean slope (deg), from CartoDEM / SRTM
    elevation       REAL,
    landslide_hist  INTEGER,                    -- inventory points within 1 km buffer
    length_km       REAL,
    last_status     TEXT DEFAULT 'open' CHECK (last_status IN ('open', 'blocked')),
    status_reason   TEXT,
    status_updated  TIMESTAMPTZ
);
CREATE INDEX road_edges_gix ON road_edges USING GIST (geometry);

CREATE TABLE hazard_events (
    event_id    UUID PRIMARY KEY,               -- generated on the device: makes sync idempotent
    type        TEXT NOT NULL,                  -- landslide | washout | flood | accident | debris | clear
    severity    TEXT,
    geometry    GEOMETRY(Point, 4326),
    edge_id     TEXT REFERENCES road_edges(edge_id),
    time_start  TIMESTAMPTZ NOT NULL,
    time_end    TIMESTAMPTZ,
    source      TEXT,                           -- driver | dispatcher | authority | model
    device_id   TEXT,
    verified    BOOLEAN DEFAULT FALSE,
    note        TEXT,
    received_at TIMESTAMPTZ DEFAULT now(),
    via         TEXT,                           -- direct | mesh
    hops        INTEGER DEFAULT 0
);
CREATE INDEX hazard_events_edge_time ON hazard_events (edge_id, time_start DESC);
CREATE INDEX hazard_events_gix ON hazard_events USING GIST (geometry);

CREATE TABLE shipments (
    shipment_id TEXT PRIMARY KEY,
    priority    TEXT,
    origin      TEXT,
    destination TEXT,
    cargo_type  TEXT,
    temp_range  TEXT,
    deadline    TIMESTAMPTZ,
    weight_t    REAL,
    status      TEXT,
    route_id    TEXT,
    vehicle_id  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE vehicle_status (
    vehicle_id   TEXT PRIMARY KEY,
    gps_point    GEOMETRY(Point, 4326),
    speed        REAL,
    load         TEXT,
    offline_flag BOOLEAN,
    last_sync    TIMESTAMPTZ,
    last_seen    TIMESTAMPTZ,
    shipment_id  TEXT,
    edge_id      TEXT
);

CREATE TABLE route_decisions (
    route_id            TEXT PRIMARY KEY,
    shipment_id         TEXT,
    profile             TEXT,
    recommended_profile TEXT,
    edges               JSONB,
    cost_breakdown      JSONB,                 -- travel_time, risk, perishability, reliability
    risk_score          REAL,
    eta                 REAL,
    eta_p90             REAL,
    model_version       TEXT,
    data_freshness      JSONB,
    decision            TEXT,                  -- proposed | approved | rejected
    decided_by          TEXT,
    override_reason     TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    decided_at          TIMESTAMPTZ
);

CREATE TABLE server_events (                  -- sync log; seq is the device cursor
    seq         BIGSERIAL PRIMARY KEY,
    event_id    UUID UNIQUE,
    kind        TEXT,
    device_id   TEXT,
    payload     JSONB,
    created_at  TIMESTAMPTZ,
    received_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_log (
    id     BIGSERIAL PRIMARY KEY,
    ts     TIMESTAMPTZ DEFAULT now(),
    actor  TEXT,
    action TEXT,
    detail JSONB
);

-- Example spatial query the prototype approximates in Python (snap a report to the nearest road edge):
-- SELECT edge_id FROM road_edges WHERE mode = 'road'
--   ORDER BY geometry <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) LIMIT 1;

-- Example feature query (landslide inventory density along each edge):
-- UPDATE road_edges e SET landslide_hist = (
--   SELECT count(*) FROM landslide_inventory l
--   WHERE ST_DWithin(e.geometry::geography, l.geom::geography, 1000));
