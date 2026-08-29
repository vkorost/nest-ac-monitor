// Alert detection. Pure functions over plain row objects - no database, no
// network - so the whole state machine is testable under plain node.
//
// The core inference: the thermostat reports what it *commanded*, never whether
// the compressor is actually running. When the lockout relay opens on a
// water-source heat pump the blower stays energised, so the apartment sounds
// like it is cooling while it warms. A sustained COOLING command with a flat or
// rising room temperature is the only signal available from outside the unit.

export const TYPES = ["A", "B", "C", "D"];

export const TITLES = {
  A: "AC not cooling",
  B: "Humidity high",
  C: "Thermostat offline",
  D: "Nest authorisation failed",
};

// 0 normal, 1 high, 2 emergency. Only Alert A is ever a candidate for
// emergency, and only when the owner has asked to be woken.
export const PRIORITIES = { A: 1, B: 1, C: 1, D: 1 };

export function priorityFor(type, direction, settings = {}) {
  if (direction !== "fire") return 0;
  if (type === "A" && settings.wake_at_night) return 2;
  return PRIORITIES[type] ?? 0;
}

// B and C can wait for morning if quiet hours are on. A never waits.
const QUIET_DEFERRABLE = new Set(["B", "C"]);

const ms = (iso) => Date.parse(iso);
export const toF = (c) => (c === null || c === undefined ? null : (c * 9) / 5 + 32);
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------- windowing

/**
 * Trim the rolling buffer at the first large clock gap.
 *
 * The local version needed this because Windows sleeping overnight would
 * otherwise present two COOLING samples six hours apart as a six-hour stuck
 * window. On Workers the equivalent is a cron tick that was skipped or a
 * deployment gap. Either way, cutting at the gap is the difference between a
 * real alert and one that teaches you to ignore alerts.
 *
 * @param rows newest first
 */
export function usableWindow(rows, pollSeconds) {
  if (!rows.length) return [];
  const threshold = Math.max(pollSeconds * 3, 900) * 1000;
  const kept = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (ms(rows[i - 1].ts) - ms(rows[i].ts) > threshold) break;
    kept.push(rows[i]);
  }
  return kept;
}

/** The unbroken run of COOLING ending at the newest sample. */
export function coolingStreak(rows) {
  const streak = [];
  for (const row of rows) {
    // A failed poll is not evidence that cooling stopped. Breaking the streak
    // on one network blip would restart the clock and delay a real alert by
    // another full stuck_minutes.
    if (row.error || row.hvac_status === null || row.hvac_status === undefined) continue;
    if (row.hvac_status !== "COOLING") break;
    if (row.ambient_c === null || row.ambient_c === undefined) continue;
    streak.push(row);
  }

  if (streak.length < 2) return { minutes: 0, dropF: 0, streak };

  const newest = streak[0];
  const oldest = streak[streak.length - 1];
  const minutes = (ms(newest.ts) - ms(oldest.ts)) / 60000;
  const dropF = ((oldest.ambient_c - newest.ambient_c) * 9) / 5;
  return { minutes, dropF, streak };
}

/**
 * Cooling achieved over the TRAILING stuckMinutes of the run.
 *
 * Measuring the whole run is wrong, and it failed in production on 2026-08-27:
 * a 70-minute run cooled 2.0F in its first 25 minutes and then sat dead flat
 * for 45 while still calling for cool. Across the whole window the drop was
 * 2.0F, comfortably over the 0.5F threshold, so nothing fired - while the
 * compressor had plainly stopped and the room had been static for three
 * quarters of an hour. The unit's good first 25 minutes had permanently
 * immunised it against ever being detected as stuck.
 *
 * What matters is not whether the run has ever cooled. It is whether it is
 * cooling *now*, so the window slides with the present moment.
 *
 * @returns {{minutes:number, dropF:number}|null} null if the run is too short
 */
export function stall(streak, stuckMinutes) {
  if (streak.length < 2) return null;

  const newestTs = ms(streak[0].ts);
  const window = [];
  let spans = false;
  for (const row of streak) {
    window.push(row);
    if ((newestTs - ms(row.ts)) / 60000 >= stuckMinutes) {
      spans = true;
      break;
    }
  }
  if (!spans || window.length < 2) return null;

  const oldest = window[window.length - 1];
  if (streak[0].ambient_c === null || oldest.ambient_c === null) return null;

  return {
    minutes: (newestTs - ms(oldest.ts)) / 60000,
    dropF: ((oldest.ambient_c - streak[0].ambient_c) * 9) / 5,
  };
}

// --------------------------------------------------------------- conditions

/**
 * @param rows newest first
 * @returns {Object<string, {met: boolean, payload: object}>}
 */
export function evaluate({ rows, consecutiveErrors = 0, settings, authFailed = false }) {
  const windowed = usableWindow(rows, settings.poll_seconds);

  // A row is only evidence if it carries the signal. Rows with a null reading
  // are ignored rather than treated as "condition cleared" - otherwise one
  // malformed API response fires a spurious recovery, which is worse than no
  // alert at all because it tells you the AC came back when it did not.
  const clean = windowed.filter((r) => !r.error && r.ambient_c !== null && r.ambient_c !== undefined);
  const humid = windowed.filter((r) => !r.error && r.humidity_pct !== null && r.humidity_pct !== undefined);
  const linked = windowed.filter((r) => !r.error && r.connectivity !== null && r.connectivity !== undefined);

  const results = {};

  // --- A: stuck cooling ----------------------------------------------------
  const run = coolingStreak(windowed);
  const flat = stall(run.streak, settings.stuck_minutes);
  const latest = clean[0] || null;

  results.A = {
    met: Boolean(settings.alert_a_enabled && flat && flat.dropF < settings.min_drop_f),
    payload: {
      ambient_f: latest ? round1(toF(latest.ambient_c)) : null,
      setpoint_f: latest ? round1(toF(latest.cool_setpoint_c)) : null,
      minutes: flat ? Math.round(flat.minutes) : 0,
      run_minutes: Math.round(run.minutes),
      delta_f: flat ? round1(-flat.dropF) : 0, // positive means it got warmer
      run_delta_f: round1(-run.dropF),
      humidity_pct: latest ? latest.humidity_pct : null,
      outdoor_wetbulb_f: latest ? round1(toF(latest.outdoor_wetbulb_c)) : null,
      hvac_status: latest ? latest.hvac_status : null,
      samples: run.streak.length,
    },
  };

  // --- B: humidity, two consecutive polls ----------------------------------
  const humidTwo = humid.slice(0, 2);
  results.B = {
    met: Boolean(
      settings.alert_b_enabled &&
        humidTwo.length === 2 &&
        humidTwo.every((r) => r.humidity_pct >= settings.humidity_pct)
    ),
    payload: {
      humidity_pct: humidTwo.length ? humidTwo[0].humidity_pct : null,
      threshold: settings.humidity_pct,
      ambient_f: humidTwo.length ? round1(toF(humidTwo[0].ambient_c)) : null,
    },
  };

  // --- C: offline ----------------------------------------------------------
  const linkedTwo = linked.slice(0, 2);
  const offlineTwo = linkedTwo.length === 2 && linkedTwo.every((r) => r.connectivity !== "ONLINE");
  results.C = {
    met: Boolean(settings.alert_c_enabled && (offlineTwo || consecutiveErrors >= 3)),
    payload: {
      connectivity: linkedTwo.length ? linkedTwo[0].connectivity : null,
      consecutive_errors: consecutiveErrors,
      reason: consecutiveErrors >= 3 ? "api errors" : "device offline",
    },
  };

  // --- D: auth -------------------------------------------------------------
  results.D = {
    met: Boolean(settings.alert_d_enabled && authFailed),
    payload: { detail: "Refresh token rejected. Re-authenticate from the dashboard." },
  };

  return results;
}

// ----------------------------------------------------------------- messages

export function message(type, direction, payload) {
  const title = TITLES[type];

  if (direction === "recover") {
    if (type === "A") {
      // The condition clears for two very different reasons: the compressor
      // came back, or the thermostat stopped calling for cool at all (setpoint
      // reached, or a manual Off-wait-Cool reset). Saying "cooling resumed"
      // when someone just switched it off would be a lie in the record.
      const body =
        payload.hvac_status === "COOLING"
          ? `Cooling resumed. Now ${payload.ambient_f}F, setpoint ${payload.setpoint_f}F.`
          : `No longer calling for cool (${payload.hvac_status || "OFF"}). Room ${payload.ambient_f}F.`;
      return { title: `${title} - cleared`, body };
    }
    if (type === "B") {
      return {
        title: `${title} - cleared`,
        body: `Humidity back under threshold, now ${payload.humidity_pct}%.`,
      };
    }
    if (type === "C") {
      return { title: `${title} - cleared`, body: "Thermostat is reachable again." };
    }
    return { title: `${title} - cleared`, body: "Nest authorisation is working again." };
  }

  if (type === "A") {
    const delta = payload.delta_f;
    const word = delta > 0 ? "rose" : "flat";
    let opening = `No cooling for ${payload.minutes} minutes while the thermostat has been calling for cool.`;
    if (payload.run_minutes > payload.minutes + 5) {
      opening += ` The run has been going ${payload.run_minutes} minutes in total.`;
    }
    const lines = [
      opening,
      "",
      `  Room       ${payload.ambient_f}F`,
      `  Setpoint   ${payload.setpoint_f}F`,
      delta === null || delta === undefined
        ? "  Change     n/a"
        : `  Change     ${delta > 0 ? "+" : ""}${delta.toFixed(1)}F over the last ${payload.minutes} min (${word})`,
    ];
    if (payload.humidity_pct !== null) lines.push(`  Humidity   ${payload.humidity_pct}%`);
    if (payload.outdoor_wetbulb_f !== null) lines.push(`  Outdoor WB ${payload.outdoor_wetbulb_f}F`);
    lines.push("", "Likely compressor lockout. Reset: Off, wait 5 min, back to Cool.");
    return { title, body: lines.join("\n") };
  }

  if (type === "B") {
    return {
      title,
      body:
        `Indoor humidity ${payload.humidity_pct}% (threshold ${payload.threshold}%) ` +
        "for two consecutive polls. The coil has stopped dehumidifying.",
    };
  }

  if (type === "C") {
    return {
      title,
      body:
        `No usable reading from the thermostat (${payload.reason}). ` +
        "Either it is offline or the monitor cannot reach Google.",
    };
  }

  return { title, body: payload.detail || "Authorisation failed." };
}

// -------------------------------------------------------------- quiet hours

/** Minutes past local midnight, in the apartment's timezone. */
export function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

export function inQuietHours(settings, date, timeZone) {
  if (!settings.quiet_hours_enabled) return false;
  const parse = (hhmm) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };
  const start = parse(settings.quiet_start);
  const end = parse(settings.quiet_end);
  if (start === null || end === null) return false;

  const now = localMinutes(date, timeZone);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

// ------------------------------------------------------------ state machine

/**
 * Advance each alert's state, record what happened, and send what needs sending.
 *
 * Recording and delivery are deliberately separate:
 *
 *   record(type, direction, payload)  writes the alert row. This is EVIDENCE.
 *   notify(type, direction, payload)  pushes to the phone. Resolves true when
 *                                     the notification actually left.
 *
 * They used to be one call, and on 2026-08-28 that lost a real lockout: the
 * ntfy quota was exhausted, delivery failed, and because the row was only
 * written on successful delivery, a 25-minute stall that happened while a
 * technician was on site never reached the alerts table at all. The log is the
 * point of this application; it must not depend on a push service being up.
 *
 * A delivery failure still does not set `fired`, so notification retries on the
 * next tick. But `logged` is set regardless, so the episode is recorded once.
 *
 * @returns {{sent: Array, states: Object}}
 */
export async function processAlerts({ conditions, states, settings, now, timeZone, record, notify }) {
  const nowIso = now.toISOString();
  const quiet = inQuietHours(settings, now, timeZone);
  const cooldownMs = settings.cooldown_minutes * 60000;
  const sent = [];
  const next = {};

  for (const type of TYPES) {
    const { met, payload } = conditions[type] || { met: false, payload: {} };
    const state = { ...(states[type] || { active: 0, fired: 0, logged: 0, pending: 0, since_ts: null, last_fire_ts: null }) };

    if (met) {
      if (!state.active) {
        state.active = 1;
        state.since_ts = nowIso;
        state.fired = 0;
        state.logged = 0;
        state.pending = 0;
      }

      const held = quiet && QUIET_DEFERRABLE.has(type);

      // Record first, unconditionally. The evidence must not depend on a push
      // service being reachable.
      if (!state.logged && !held) {
        await record(type, "fire", payload);
        state.logged = 1;
      }

      if (!state.fired) {
        const recentFire =
          state.last_fire_ts && now.getTime() - Date.parse(state.last_fire_ts) < cooldownMs;

        if (held) {
          state.pending = 1;
        } else if (recentFire) {
          // Inside the cooldown: stay active, do not notify, and do not mark
          // as fired so it can still notify once the window passes.
          state.pending = 0;
        } else if (await notify(type, "fire", payload)) {
          state.fired = 1;
          state.pending = 0;
          state.last_fire_ts = nowIso;
          sent.push({ type, direction: "fire" });
        }
      }
    } else if (state.active) {
      if (state.logged) await record(type, "recover", payload);
      if (state.fired && (await notify(type, "recover", payload))) {
        sent.push({ type, direction: "recover" });
      }
      state.active = 0;
      state.fired = 0;
      state.logged = 0;
      state.pending = 0;
      state.since_ts = null;
    }

    next[type] = state;
  }

  return { sent, states: next };
}
