// Worker entry point: the cron-driven poll loop and the dashboard.
//
// Two handlers:
//   scheduled()  every 5 minutes - read, store, evaluate, notify
//   fetch()      the dashboard and its JSON API, behind a shared secret
//
// Nothing survives between invocations except D1. Every tick is a cold isolate.

import * as db from "./db.js";
import * as detect from "./detect.js";
import * as sdm from "./sdm.js";
import { fetchOutdoor } from "./weather.js";
import { buildNotifier } from "./notify.js";
import { PAGE } from "./ui.js";

const COOKIE = "nestac_token";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// ---------------------------------------------------------------- polling

/**
 * One complete cycle. Never throws; failures become sample rows so an outage
 * appears in the record as rows rather than a silent gap.
 */
export async function pollOnce(env) {
  const database = env.DB;
  const settings = await db.getSettings(database);
  const now = new Date();

  const outdoor = await fetchOutdoor(settings.latitude, settings.longitude);
  const sample = { ...outdoor };
  let error = null;
  let authFailed = false;

  try {
    const token = await sdm.accessToken({
      ...env,
      NEST_REFRESH_TOKEN: await db.refreshToken(database, env),
    });
    const device = await sdm.readDevice(env, token);
    const reading = sdm.toSample(device);

    if (reading.ambient_c === null) {
      // A 200 carrying no usable traits is not a reading. Storing it as a
      // clean sample would let one malformed response clear an active alert
      // and emit a false recovery - telling you the AC came back when it did
      // not. Observed in production on 2026-08-27.
      error = "empty reading: no ambient temperature in device response";
    } else {
      Object.assign(sample, reading);
    }
  } catch (err) {
    if (err instanceof sdm.AuthError) {
      authFailed = true;
      error = `auth: ${err.message}`;
    } else {
      error = String(err.message || err).slice(0, 300);
    }
  }

  await db.insertSample(database, sample, error, now, settings.timezone);

  const rows = await db.recentSamples(database, 120);
  // States are read before evaluate() because the humidity rule needs to know
  // whether it is already active: a live alert holds until the reading falls
  // clear of the threshold, rather than clearing the moment it touches it.
  const states = await db.getStates(database);
  const conditions = detect.evaluate({
    rows,
    consecutiveErrors: await db.consecutiveErrors(database),
    settings,
    authFailed,
    active: new Set(detect.TYPES.filter((t) => states[t]?.active)),
  });

  const notifier = buildNotifier(settings, env);

  const { sent, states: nextStates } = await detect.processAlerts({
    conditions,
    states,
    settings,
    now,
    timeZone: settings.timezone,
    // Evidence: always written, whatever the push service is doing.
    record: async (type, direction, payload) => {
      await db.logAlert(database, type, direction, payload, now, settings.timezone);
    },
    // Evidence of delivery, written after the fact so the alert log can say
    // whether the push actually reached the phone.
    delivered: async (type) => {
      await db.markAlertNotified(database, type);
    },
    // Notification: best effort, retried on the next tick if it fails.
    notify: async (type, direction, payload) => {
      const { title, body } = detect.message(type, direction, payload);
      const priority = detect.priorityFor(type, direction, settings);
      try {
        await notifier.send(title, body, priority);
      } catch (err) {
        console.error(`notify failed ${type} ${direction}: ${err.message}`);
        return false;
      }
      return true;
    },
  });

  await db.putStates(database, nextStates);

  return { ok: !error, error, sent, authFailed };
}

// ------------------------------------------------------------------- auth

function authorised(request, env) {
  // Fail closed. An unauthenticated control surface that can switch monitoring
  // off is worse than no dashboard at all.
  if (!env.WEB_TOKEN) return false;

  // Cloudflare Access, if it is in front of this Worker, proves identity
  // before the request ever arrives.
  if (request.headers.get("cf-access-authenticated-user-email")) return true;

  const cookies = request.headers.get("cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return Boolean(match && match[1] === env.WEB_TOKEN);
}

// ------------------------------------------------------------------ views

async function statusView(env) {
  const database = env.DB;
  const settings = await db.getSettings(database);
  const latest = await db.latestSample(database);
  const rows = await db.recentSamples(database, 120);
  const states = await db.getStates(database);

  const windowed = detect.usableWindow(rows, settings.poll_seconds);
  const run = detect.coolingStreak(windowed);
  const flat = detect.stall(run.streak, settings.stuck_minutes);
  const half = detect.stall(run.streak, Math.max(5, settings.stuck_minutes * 0.6));

  // db.sampleCount() reads a single config row. It is not a COUNT(*) on
  // purpose - that scanned all 13,000+ samples on every status poll and burned
  // the account's whole D1 free-tier day in 24 hours. See the comment above
  // sampleCount() in db.js before changing this.
  const sampleTotal = await db.sampleCount(database);
  const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  const f = detect.toF;

  const stale =
    latest && Date.now() - Date.parse(latest.ts) > settings.poll_seconds * 3000;

  return {
    settings,
    current: latest
      ? {
          ts: latest.ts_local,
          ambient_f: r1(f(latest.ambient_c)),
          humidity_pct: latest.humidity_pct,
          hvac_status: latest.hvac_status,
          mode: latest.mode,
          setpoint_f: r1(f(latest.cool_setpoint_c)),
          connectivity: latest.connectivity,
          outdoor_f: r1(f(latest.outdoor_c)),
          outdoor_wetbulb_f: r1(f(latest.outdoor_wetbulb_c)),
          error: latest.error,
        }
      : {},
    cooling: {
      run_minutes: Math.round(run.minutes),
      run_delta_f: r1(-run.dropF),
      minutes: flat ? Math.round(flat.minutes) : 0,
      delta_f: flat ? r1(-flat.dropF) : 0,
      samples: run.streak.length,
      at_risk: Boolean(half && half.dropF < settings.min_drop_f),
    },
    alert_state: Object.fromEntries(
      detect.TYPES.map((t) => {
        const s = states[t] || {};
        return [t, { active: Boolean(s.active), fired: Boolean(s.fired), pending: Boolean(s.pending), since: s.since_ts || null }];
      })
    ),
    sample_count: sampleTotal,
    api_ok: !latest?.error,
    auth_ok: !(latest?.error || "").startsWith("auth:"),
    stale: Boolean(stale),
    notifier: buildNotifier(settings, env).name,
    quiet_now: detect.inQuietHours(settings, new Date(), settings.timezone),
  };
}

const CSV_HEADER =
  "ts_local,ts,ambient_f,humidity_pct,hvac_status,mode,cool_setpoint_f," +
  "connectivity,outdoor_f,outdoor_rh_pct,outdoor_dewpoint_f,outdoor_wetbulb_f,error";

async function exportCsv(env, day) {
  const settings = await db.getSettings(env.DB);
  const target =
    day ||
    new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(new Date());
  const { results } = await env.DB.prepare(
    "SELECT * FROM samples WHERE substr(ts_local,1,10) = ? ORDER BY id"
  )
    .bind(target)
    .all();

  const f = (c) => (c === null || c === undefined ? "" : (Math.round(((c * 9) / 5 + 32) * 100) / 100));
  const cell = (v) => (v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : v);

  const lines = [CSV_HEADER];
  for (const r of results || []) {
    lines.push(
      [
        r.ts_local, r.ts, f(r.ambient_c), cell(r.humidity_pct), cell(r.hvac_status),
        cell(r.mode), f(r.cool_setpoint_c), cell(r.connectivity), f(r.outdoor_c),
        cell(r.outdoor_rh_pct), f(r.outdoor_dewpoint_c), f(r.outdoor_wetbulb_c),
        cell(r.error),
      ].join(",")
    );
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="samples-${target}.csv"`,
    },
  });
}

// --------------------------------------------------------------- handlers

export default {
  async scheduled(event, env, ctx) {
    const settings = await db.getSettings(env.DB);
    if (!settings.monitoring_enabled) {
      console.log("monitoring is off - skipping poll");
      return;
    }
    ctx.waitUntil(
      (async () => {
        const result = await pollOnce(env);
        if (result.error) console.error(`poll error: ${result.error}`);
        for (const s of result.sent) console.log(`ALERT ${s.type} ${s.direction}`);

        // Prune roughly once a day, on the tick nearest 04:00 UTC.
        if (new Date().getUTCHours() === 4 && new Date().getUTCMinutes() < 5) {
          const removed = await db.prune(env.DB, settings.retention_days);
          if (removed) console.log(`pruned ${removed} samples`);
        }
      })()
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      const token = url.searchParams.get("token") || "";
      if (!env.WEB_TOKEN || token !== env.WEB_TOKEN) {
        return new Response("bad token", { status: 401 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    if (!authorised(request, env)) {
      return new Response(
        env.WEB_TOKEN
          ? "Unauthorised. Open /auth?token=... once to authorise this browser."
          : "WEB_TOKEN is not set. Run: wrangler secret put WEB_TOKEN",
        { status: 401 }
      );
    }

    try {
      if (url.pathname === "/") {
        return new Response(PAGE, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (url.pathname === "/api/status") return json(await statusView(env));

      if (url.pathname === "/api/history") {
        // `range` is the current interface; `hours` is kept so older links and
        // any scripts pointed at the previous endpoint keep working.
        const rangeKey = url.searchParams.get("range")
          || (url.searchParams.get("hours") ? "24h" : "24h");

        // `since` (epoch ms) asks for only the samples added after the point
        // the caller already holds, so a chart refresh reads one row instead of
        // a whole window. chartSeries() clamps it to the range, and answers
        // with partial:true when it honoured it, which is the client's signal
        // to append rather than replace.
        const sinceRaw = Number(url.searchParams.get("since"));
        const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : null;
        const { bucket, partial, rows } = await db.chartSeries(env.DB, rangeKey, since);
        const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
        const f = detect.toF;

        return json({
          range: rangeKey,
          bucket,
          partial,
          samples: rows.map((r) => ({
            ts: r.ts_local,
            ambient_f: r1(f(r.ambient_c)),
            ambient_min_f: r1(f(r.ambient_min_c)),
            ambient_max_f: r1(f(r.ambient_max_c)),
            setpoint_f: r1(f(r.cool_setpoint_c)),
            humidity_pct: r.humidity_pct === null ? null : Math.round(r.humidity_pct),
            hvac: bucket === "raw" ? r.hvac_status : null,
            cooling_frac: r.cooling_frac === undefined ? null : r.cooling_frac,
            wetbulb_f: r1(f(r.outdoor_wetbulb_c)),
            outdoor_f: r1(f(r.outdoor_c)),
            error: bucket === "raw" ? r.error : (r.errors || 0) > 0 ? "errors" : null,
          })),
        });
      }

      if (url.pathname === "/api/alerts") {
        const rows = await db.recentAlerts(env.DB, 50);
        return json({
          alerts: rows.map((r) => ({
            ts: r.ts_local, type: r.alert_type, direction: r.direction, payload: r.payload_json,
          })),
        });
      }

      if (url.pathname === "/api/export.csv") {
        return exportCsv(env, url.searchParams.get("day"));
      }

      if (request.method === "POST" && url.pathname === "/api/config") {
        const body = await request.json();
        await db.setSettings(env.DB, body);
        return json({ ok: true, settings: await db.getSettings(env.DB) });
      }

      if (request.method === "POST" && url.pathname === "/api/poll-now") {
        return json(await pollOnce(env));
      }

      if (request.method === "POST" && url.pathname === "/api/test-notification") {
        const settings = await db.getSettings(env.DB);
        const notifier = buildNotifier(settings, env);
        try {
          await notifier.send(
            "Nest AC Monitor - test",
            "Delivery path works. A real Alert A arrives at high priority with " +
              "temperature, setpoint, minutes stuck and the change over the window.",
            2
          );
        } catch (err) {
          return json({ ok: false, error: err.message }, 502);
        }
        return json({ ok: true, via: notifier.name });
      }

      if (url.pathname === "/api/auth-url") {
        if (!env.NEST_PROJECT_ID || !env.NEST_CLIENT_ID) {
          return json({ error: "No project id or client id configured." }, 400);
        }
        return json({ url: sdm.buildAuthUrl(env.NEST_PROJECT_ID, env.NEST_CLIENT_ID) });
      }

      if (request.method === "POST" && url.pathname === "/api/auth-complete") {
        const { redirect_url } = await request.json();
        try {
          const code = sdm.extractCode(redirect_url);
          const tokens = await sdm.exchangeCode(env.NEST_CLIENT_ID, env.NEST_CLIENT_SECRET, code);
          if (!tokens.refresh_token) {
            return json({ ok: false, error: "Google returned no refresh token." }, 400);
          }
          await db.putRaw(env.DB, "refresh_token_override", tokens.refresh_token);
          return json({ ok: true });
        } catch (err) {
          return json({ ok: false, error: err.message }, 400);
        }
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: String(err.message || err) }, 500);
    }
  },
};
