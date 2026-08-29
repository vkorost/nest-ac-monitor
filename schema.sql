-- D1 schema for the Nest AC Monitor.
--
-- Mirrors the SQLite schema the local app uses, so a day of samples collected
-- on the PC imports into D1 without translation and the evidence record stays
-- continuous across the move.

CREATE TABLE IF NOT EXISTS samples (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                 TEXT NOT NULL,   -- ISO8601, UTC
    ts_local           TEXT NOT NULL,   -- ISO8601, apartment local time
    ambient_c          REAL,
    humidity_pct       REAL,
    hvac_status        TEXT,
    mode               TEXT,
    cool_setpoint_c    REAL,
    connectivity       TEXT,
    error              TEXT,            -- NULL on success
    outdoor_c          REAL,
    outdoor_rh_pct     REAL,
    outdoor_dewpoint_c REAL,
    outdoor_wetbulb_c  REAL             -- the tower-capacity number
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    ts_local     TEXT NOT NULL,
    alert_type   TEXT NOT NULL,        -- A | B | C | D
    direction    TEXT NOT NULL,        -- fire | recover
    payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Persisted so a cold Worker invocation cannot re-fire an alert that is
-- already active, or lose a recovery that is still owed. Every cron tick is a
-- fresh isolate with no memory, so this table IS the state machine's memory.
CREATE TABLE IF NOT EXISTS alert_state (
    alert_type   TEXT PRIMARY KEY,
    active       INTEGER NOT NULL DEFAULT 0,
    fired        INTEGER NOT NULL DEFAULT 0,  -- notification actually delivered
    logged       INTEGER NOT NULL DEFAULT 0,  -- alert row written (evidence)
    pending      INTEGER NOT NULL DEFAULT 0,
    since_ts     TEXT,
    last_fire_ts TEXT
);
