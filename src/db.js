// D1 access: settings, samples, alerts, and the persisted alert state.
//
// Every cron tick is a fresh isolate with no memory of the last one, so these
// tables are the only state the monitor has. Nothing may live in a module
// variable and be expected to survive.

export const DEFAULTS = {
  monitoring_enabled: true,

  poll_seconds: 300,
  latitude: 25.7743,
  longitude: -80.1937,
  timezone: "America/New_York",

  alert_a_enabled: true,
  stuck_minutes: 25,
  min_drop_f: 0.5,

  alert_b_enabled: true,
  humidity_pct: 60,
  // Humidity has to STAY up to be worth a notification. Two consecutive polls
  // (the old rule) meant ten minutes, and the October 2026 log is full of
  // five-minute episodes that cleared themselves - an alert that cries wolf
  // teaches you to ignore the one that matters.
  humidity_minutes: 45,
  humidity_clear_margin: 2,

  alert_c_enabled: true,
  alert_d_enabled: true,

  cooldown_minutes: 60,

  // Alert A only: a compressor still locked out an hour later is still an
  // emergency, and one notification at 15:00 is easy to miss among others.
  // Re-sent every repeat_minutes while the condition holds, repeat_max times.
  repeat_minutes: 60,
  repeat_max: 10,
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
  "humidity_minutes",
  "humidity_clear_margin",
  "cooldown_minutes",
  "repeat_minutes",
  "repeat_max",
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

/** The exact spelling the `ts` column stores, so string comparisons on it are
 *  apples to apples. (D1 has no date type; `ts` is text and every WHERE on it
 *  is a string compare.) */
export const utcStamp = (date) => date.toISOString().replace(/\.\d+Z$/, "+00:00");

export async function insertSample(db, sample, error, now, timeZone) {
  // One batch, so the row and the counter can never disagree: D1 runs a batch
  // as a single transaction. See sampleCount() for why a counter exists at all.
  await db.batch([
    db
      .prepare(
        `INSERT INTO samples
       (ts, ts_local, ambient_c, humidity_pct, hvac_status, mode,
        cool_setpoint_c, connectivity, error,
        outdoor_c, outdoor_rh_pct, outdoor_dewpoint_c, outdoor_wetbulb_c)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        utcStamp(now),
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
      ),
    db.prepare(COUNT_BUMP).bind(1, COUNT_KEY),
  ]);
}

// ------------------------------------------------- stored-sample count
//
// `SELECT COUNT(*) AS n FROM samples` is deliberately NOT used to fill the
// "samples stored" line in the UI. No index can answer a count, so SQLite
// scans the whole table: at 13,000 samples that was 13,320 rows read per
// /api/status call, the dashboard polled status every ten seconds, and on
// 2026-10-12 that single query read 5.5 million rows in a day. D1's free tier
// allows 5 million rows read per day across the ENTIRE account, not per
// database, so it also took down an unrelated app sharing that account. Do not
// put COUNT(*) back here. Anything a page polls has to cost O(rows returned),
// not O(table).
//
// The count lives in `config` instead: bumped by insertSample(), reduced by
// prune(), and read with a primary-key lookup (one row). A counter rather than
// MAX(id) because prune() deletes rows, which MAX(id) would not notice.

const COUNT_KEY = "samples_count";

// Clamped at zero, and a no-op when the key is absent, which lets sampleCount()
// seed the true value instead of starting a fresh counter from one.
const COUNT_BUMP =
  "UPDATE config SET value = CAST(MAX(0, CAST(value AS INTEGER) + ?) AS TEXT) " +
  "WHERE key = ?";

/** Stored samples, exact, for one row read. */
export async function sampleCount(db) {
  const stored = await getRaw(db, COUNT_KEY);
  const n = stored === null || String(stored).trim() === "" ? NaN : Number(stored);
  if (Number.isFinite(n)) return n;

  // Missing (the first call after this change shipped) or unreadable: pay for
  // one full scan, write the answer down, and never scan again. Counting and
  // storing in a single statement, so a sample inserted at the same moment
  // cannot be lost between the count and the write - its own bump is a no-op
  // while the key is absent, but then the COUNT below already includes it.
  // `WHERE true` is required: SQLite cannot parse ON CONFLICT after a bare
  // INSERT...SELECT.
  await db
    .prepare(
      `INSERT INTO config(key, value)
       SELECT ?, CAST(COUNT(*) AS TEXT) FROM samples WHERE true
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .bind(COUNT_KEY)
    .run();
  const row = await getRaw(db, COUNT_KEY);
  return Number(row) || 0;
}

/** Newest first. */
export async function recentSamples(db, limit = 120) {
  const { results } = await db
    .prepare("SELECT * FROM samples ORDER BY id DESC LIMIT ?")
    .bind(limit)
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
export async function chartSeries(db, rangeKey = "24h", sinceMs = null) {
  const range = RANGES[rangeKey] || RANGES["24h"];
  const cutoff = range.hours ? new Date(Date.now() - range.hours * 3600_000) : null;

  const where = cutoff ? "WHERE ts >= ?" : "";
  const args = cutoff ? [utcStamp(cutoff)] : [];

  if (range.bucket === "raw") {
    // Incremental refresh. A dashboard that already holds the window up to its
    // newest point passes that point as `sinceMs` and gets back only what the
    // sampler has added since - one row per five minutes, instead of re-reading
    // all ~290 rows of the window on every refresh.
    //
    // `since` can only ever narrow the window: a value older than the cutoff is
    // ignored, so a stale or hostile request cannot use it to ask for more.
    const since =
      sinceMs && cutoff && sinceMs > cutoff.getTime() ? new Date(sinceMs) : null;

    // ORDER BY ts, not id: the filter is on ts, so ordering by ts lets
    // idx_samples_ts serve both and the scan stops at the cutoff. Ordering by
    // id forced a full table scan plus a sort - 3,218 rows read to return the
    // ~290 of a 24-hour chart. Both columns are monotonic here (ts is written
    // once per insert, in order), so the rendered chart is identical.
    const { results } = await db
      .prepare(
        since
          ? "SELECT * FROM samples WHERE ts > ? ORDER BY ts"
          : `SELECT * FROM samples ${where} ORDER BY ts`
      )
      .bind(...(since ? [utcStamp(since)] : args))
      .all();
    return { bucket: "raw", partial: Boolean(since), rows: results || [] };
  }

  // This aggregate scans the range it summarises: ~17,300 rows read per call
  // for 30d/1y/all. Acceptable for the few calls a day a human makes by
  // clicking a range button, NOT acceptable on a timer - that is how the free
  // tier was exhausted on 2026-10-12. Never put a bucketed range on a short
  // interval. If one ever has to be polled, cache the result in `config`
  // keyed by range with a timestamp and serve the cache, the way Health
  // Monitor caches its coverage calendar.
  //
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

  return { bucket: range.bucket, partial: false, rows: results || [] };
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
      utcStamp(now),
      localIso(now, timeZone),
      type,
      direction,
      JSON.stringify(payload || {})
    )
    .run();
}

/**
 * Mark the latest logged fire for a type as actually delivered.
 *
 * The evidence row is written before the push is attempted, on purpose - it
 * must not depend on a notification service being reachable. That left the log
 * unable to answer the only question that matters after the fact ("did my phone
 * get this?"), which came up for real after the stuck-cooling alert of
 * 2026-10-12. Rows now carry notified:false from the start and are flipped here
 * once a push lands, including on a later tick after a failed attempt.
 */
export async function markAlertNotified(db, type) {
  await db
    .prepare(
      `UPDATE alerts
          SET payload_json = json_set(COALESCE(payload_json, '{}'), '$.notified', json('true'))
        WHERE id = (SELECT id FROM alerts
                     WHERE alert_type = ? AND direction = 'fire'
                     ORDER BY id DESC LIMIT 1)`
    )
    .bind(type)
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
  const cutoff = utcStamp(new Date(Date.now() - retentionDays * 86400_000));
  const result = await db.prepare("DELETE FROM samples WHERE ts < ?").bind(cutoff).run();
  const removed = result.meta?.changes ?? 0;
  if (removed) await db.prepare(COUNT_BUMP).bind(-removed, COUNT_KEY).run();
  return removed;
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
