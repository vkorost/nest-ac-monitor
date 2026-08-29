// D1 access: settings, samples, alerts, and the persisted alert state.
//
// Every cron tick is a fresh isolate with no memory of the last one, so these
// tables are the only state the monitor has. Nothing may live in a module
// variable and be expected to survive.

export const DEFAULTS = {
  monitoring_enabled: true,

  poll_seconds: 300,
  latitude: 40.7128,
  longitude: -74.0060,
  timezone: "America/New_York",

  alert_a_enabled: true,
  stuck_minutes: 25,
  min_drop_f: 0.5,

  alert_b_enabled: true,
  humidity_pct: 60,

  alert_c_enabled: true,
  alert_d_enabled: true,

  cooldown_minutes: 60,
  quiet_hours_enabled: false,
  quiet_start: "22:00",
  quiet_end: "07:00",

  notifier: "ntfy",
  ntfy_server: "https://ntfy.sh",

  // Alert A is the one that could justify overriding Do Not Disturb. Off by
  // default: deliver the warning, but do not force it through a silenced
  // phone. Turn on only if you want to be woken.
  wake_at_night: false,

  retention_days: 90,
};

const BOOL_KEYS = new Set([
  "monitoring_enabled",
  "alert_a_enabled",
  "alert_b_enabled",
  "alert_c_enabled",
  "alert_d_enabled",
  "quiet_hours_enabled",
  "wake_at_night",
]);

const NUM_KEYS = new Set([
  "poll_seconds",
  "latitude",
  "longitude",
  "stuck_minutes",
  "min_drop_f",
  "humidity_pct",
  "cooldown_minutes",
  "retention_days",
]);

function coerce(key, value) {
  if (value === null || value === undefined) return DEFAULTS[key];
  if (BOOL_KEYS.has(key)) {
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
  }
  if (NUM_KEYS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return value;
}

const serialise = (value) => (typeof value === "boolean" ? (value ? "1" : "0") : String(value));

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM config").all();
  const stored = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
  const merged = {};
  for (const key of Object.keys(DEFAULTS)) {
    merged[key] = coerce(key, key in stored ? stored[key] : DEFAULTS[key]);
  }
  return merged;
}

export async function setSettings(db, values) {
  const statements = [];
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULTS)) continue;
    statements.push(
      db
        .prepare(
          "INSERT INTO config(key, value) VALUES(?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .bind(key, serialise(value))
    );
  }
  if (statements.length) await db.batch(statements);
}

// ---------------------------------------------------------------- time

/** ISO8601 with the apartment's local offset. Evening failures are the whole
 *  argument, so the record has to carry local time, not just UTC. */
export function localIso(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const offset = (parts.timeZoneName || "GMT+00:00").replace("GMT", "") || "+00:00";
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

// ------------------------------------------------------------- samples

export async function insertSample(db, sample, error, now, timeZone) {
  await db
    .prepare(
      `INSERT INTO samples
       (ts, ts_local, ambient_c, humidity_pct, hvac_status, mode,
        cool_setpoint_c, connectivity, error,
        outdoor_c, outdoor_rh_pct, outdoor_dewpoint_c, outdoor_wetbulb_c)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      now.toISOString().replace(/\.\d+Z$/, "+00:00"),
      localIso(now, timeZone),
      sample.ambient_c ?? null,
      sample.humidity_pct ?? null,
      sample.hvac_status ?? null,
      sample.mode ?? null,
      sample.cool_setpoint_c ?? null,
      sample.connectivity ?? null,
      error ?? null,
      sample.outdoor_c ?? null,
      sample.outdoor_rh_pct ?? null,
      sample.outdoor_dewpoint_c ?? null,
      sample.outdoor_wetbulb_c ?? null
    )
    .run();
}

/** Newest first. */
export async function recentSamples(db, limit = 120) {
  const { results } = await db
    .prepare("SELECT * FROM samples ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all();
  return results || [];
}

/** Oldest first, for charting. */
export async function samplesSince(db, hours = 24) {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const { results } = await db
    .prepare("SELECT * FROM samples WHERE ts >= ? ORDER BY id")
    .bind(cutoff)
    .all();
  return results || [];
}

// Chart ranges. Beyond a few days, raw five-minute samples are both too many
// to send and too dense to read, so they are bucketed server-side. A year at
// full resolution would be ~105,000 rows; bucketed by day it is 365.
export const RANGES = {
  "24h": { hours: 24, bucket: "raw" },
  "7d": { hours: 24 * 7, bucket: "hour" },
  "30d": { hours: 24 * 30, bucket: "hour" },
  "1y": { hours: 24 * 365, bucket: "day" },
  all: { hours: null, bucket: "day" },
};

/**
 * Samples for a chart range, downsampled as needed. Oldest first.
 *
 * Aggregated buckets carry min/max ambient so a day that swung ten degrees
 * does not render as a flat average, and a cooling fraction so the COOLING
 * shading still means something once individual cycles are averaged away.
 */
export async function chartSeries(db, rangeKey = "24h") {
  const range = RANGES[rangeKey] || RANGES["24h"];

  const where = range.hours
    ? "WHERE ts >= ?"
    : "";
  const args = range.hours
    ? [new Date(Date.now() - range.hours * 3600_000).toISOString()]
    : [];

  if (range.bucket === "raw") {
    const { results } = await db
      .prepare(`SELECT * FROM samples ${where} ORDER BY id`)
      .bind(...args)
      .all();
    return { bucket: "raw", rows: results || [] };
  }

  // substr on the local timestamp: 13 chars is YYYY-MM-DDTHH, 10 is the date.
  const width = range.bucket === "hour" ? 13 : 10;
  const { results } = await db
    .prepare(
      `SELECT substr(ts_local, 1, ${width}) AS bucket,
              MIN(ts_local) AS ts_local,
              AVG(ambient_c) AS ambient_c,
              MIN(ambient_c) AS ambient_min_c,
              MAX(ambient_c) AS ambient_max_c,
              AVG(cool_setpoint_c) AS cool_setpoint_c,
              AVG(humidity_pct) AS humidity_pct,
              AVG(outdoor_c) AS outdoor_c,
              AVG(outdoor_wetbulb_c) AS outdoor_wetbulb_c,
              SUM(CASE WHEN hvac_status = 'COOLING' THEN 1 ELSE 0 END) * 1.0
                / COUNT(*) AS cooling_frac,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              COUNT(*) AS n
       FROM samples ${where}
       GROUP BY bucket
       ORDER BY bucket`
    )
    .bind(...args)
    .all();

  return { bucket: range.bucket, rows: results || [] };
}

export async function latestSample(db) {
  return db.prepare("SELECT * FROM samples ORDER BY id DESC LIMIT 1").first();
}

export async function consecutiveErrors(db) {
  const { results } = await db
    .prepare("SELECT error FROM samples ORDER BY id DESC LIMIT 20")
    .all();
  let count = 0;
  for (const row of results || []) {
    if (row.error) count++;
    else break;
  }
  return count;
}

// -------------------------------------------------------------- alerts

export async function logAlert(db, type, direction, payload, now, timeZone) {
  await db
    .prepare(
      "INSERT INTO alerts(ts, ts_local, alert_type, direction, payload_json) VALUES (?,?,?,?,?)"
    )
    .bind(
      now.toISOString().replace(/\.\d+Z$/, "+00:00"),
      localIso(now, timeZone),
      type,
      direction,
      JSON.stringify(payload || {})
    )
    .run();
}

export async function recentAlerts(db, limit = 50) {
  const { results } = await db
    .prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all();
  return results || [];
}

export async function getStates(db) {
  const { results } = await db.prepare("SELECT * FROM alert_state").all();
  const states = {};
  for (const row of results || []) states[row.alert_type] = row;
  return states;
}

export async function putStates(db, states) {
  const statements = Object.entries(states).map(([type, s]) =>
    db
      .prepare(
        `INSERT INTO alert_state (alert_type, active, fired, logged, pending, since_ts, last_fire_ts)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(alert_type) DO UPDATE SET
           active=excluded.active, fired=excluded.fired, logged=excluded.logged,
           pending=excluded.pending, since_ts=excluded.since_ts,
           last_fire_ts=excluded.last_fire_ts`
      )
      .bind(type, s.active ? 1 : 0, s.fired ? 1 : 0, s.logged ? 1 : 0, s.pending ? 1 : 0, s.since_ts ?? null, s.last_fire_ts ?? null)
  );
  if (statements.length) await db.batch(statements);
}

// --------------------------------------------------------- housekeeping

/** Samples are pruned after the retention window. Alerts never are. */
export async function prune(db, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const result = await db.prepare("DELETE FROM samples WHERE ts < ?").bind(cutoff).run();
  return result.meta?.changes ?? 0;
}

// ------------------------------------------------------------ raw config
//
// For values that must persist but must never be echoed back by the API.
// getSettings() only ever iterates DEFAULTS, so a key stored here cannot leak
// through /api/status by accident.

export async function getRaw(db, key) {
  const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function putRaw(db, key, value) {
  await db
    .prepare(
      "INSERT INTO config(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .bind(key, value)
    .run();
}

/**
 * The refresh token, preferring one written by an in-app re-authorisation over
 * the bootstrap Worker secret. Workers secrets cannot be rewritten at runtime,
 * so re-auth from the dashboard has to land somewhere else.
 */
export async function refreshToken(db, env) {
  return (await getRaw(db, "refresh_token_override")) || env.NEST_REFRESH_TOKEN;
}
