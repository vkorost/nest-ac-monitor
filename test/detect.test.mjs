// Port of scripts/simulate_stuck.py. Runs under plain node - no D1, no network.
//
//     node test/detect.test.mjs
//
// Every case here is either an acceptance criterion from the spec or a bug that
// actually happened in production on 2026-08-27. The ported implementation has
// to keep passing all of them; that is the point of porting the tests first.

import {
  DEFAULTS,
} from "../src/db.js";
import {
  evaluate,
  processAlerts,
  coolingStreak,
  usableWindow,
  stall,
  message,
  inQuietHours,
} from "../src/detect.js";

const TZ = "America/New_York";
const results = [];

function check(name, condition) {
  results.push({ name, ok: Boolean(condition) });
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${name}`);
}

const settings = { ...DEFAULTS };

/** Rows are newest-first, matching what recentSamples returns.
 *  An explicitly supplied null must survive as null - collapsing it into the
 *  default is what made the malformed-reading case pass spuriously. */
const pick = (spec, key, fallback) => (key in spec ? spec[key] : fallback);

function rows(...specs) {
  const ordered = [...specs].sort((a, b) => a.minutesAgo - b.minutesAgo);
  return ordered.map((s) => ({
    ts: new Date(Date.now() - s.minutesAgo * 60000).toISOString(),
    ambient_c: pick(s, "ambient_c", null),
    humidity_pct: pick(s, "humidity_pct", 55),
    hvac_status: pick(s, "hvac_status", "OFF"),
    mode: pick(s, "mode", "COOL"),
    cool_setpoint_c: pick(s, "cool_setpoint_c", 22.2),
    connectivity: pick(s, "connectivity", "ONLINE"),
    error: pick(s, "error", null),
    outdoor_wetbulb_c: 26,
  }));
}

/** A whole run of COOLING at a fixed temperature, newest first. */
function flatRun(minutes, ambient_c, extra = {}) {
  const out = [];
  for (let m = 0; m <= minutes; m += 5) {
    out.push({ minutesAgo: m, ambient_c, hvac_status: "COOLING", ...extra });
  }
  return out;
}

class Recorder {
  /** deliver=false simulates a push service that is down (ntfy 429). */
  constructor(deliver = true) {
    this.sent = [];      // notifications that actually left
    this.rows = [];      // alert rows written - the evidence
    this.deliver = deliver;
  }
  record() {
    return async (type, direction, payload) => {
      this.rows.push({ type, direction, notified: payload.notified === true });
    };
  }
  notify() {
    return async (type, direction, payload) => {
      if (!this.deliver) return false;
      const { title, body } = message(type, direction, payload);
      this.sent.push({ type, direction, title, body });
      return true;
    };
  }
  /** Stands in for markAlertNotified(): flips the newest fire row for a type. */
  delivered() {
    return async (type) => {
      for (let i = this.rows.length - 1; i >= 0; i--) {
        if (this.rows[i].type === type && this.rows[i].direction === "fire") {
          this.rows[i].notified = true;
          return;
        }
      }
    };
  }
  fires() {
    return this.sent.filter((s) => s.direction === "fire");
  }
  recoveries() {
    return this.sent.filter((s) => s.direction === "recover");
  }
}

async function cycle(sampleRows, states, rec, opts = {}) {
  const conditions = evaluate({
    rows: sampleRows,
    consecutiveErrors: opts.consecutiveErrors || 0,
    settings: opts.settings || settings,
    authFailed: opts.authFailed || false,
    // As pollOnce does: what is already active changes how the humidity rule
    // clears, so the tests have to feed it back the same way.
    active: new Set(Object.keys(states || {}).filter((t) => states[t]?.active)),
  });
  return processAlerts({
    conditions,
    states,
    settings: opts.settings || settings,
    now: opts.now || new Date(),
    timeZone: TZ,
    record: rec.record(),
    notify: rec.notify(),
    delivered: rec.delivered(),
  });
}

/** A run of humid samples at a fixed reading, newest first. */
function humidRun(minutes, humidity_pct, step = 5) {
  const out = [];
  for (let m = 0; m <= minutes; m += step) out.push({ minutesAgo: m, ambient_c: 25, humidity_pct });
  return out;
}

// ---------------------------------------------------------------- Alert A

console.log("Alert A - stuck cooling");
{
  const rec = new Recorder();
  let states = {};

  const stuck = rows(...flatRun(30, 26.5));
  let r = await cycle(stuck, states, rec);
  states = r.states;

  check("fires on the poll that crosses the threshold", r.sent.length === 1);
  check("fired alert is type A", r.sent[0]?.type === "A");

  const body = rec.fires()[0]?.body || "";
  check("message states the flat window", /No cooling for \d+ minutes/.test(body));
  check("message states room temperature", body.includes("Room"));
  check("message states setpoint", body.includes("Setpoint"));
  check("message states change over window", body.includes("Change"));

  r = await cycle(rows(...flatRun(35, 26.5)), states, rec);
  states = r.states;
  check("does not re-fire while still stuck", r.sent.length === 0);
  check("exactly one fire recorded", rec.fires().length === 1);

  // A cold isolate is what a "restart" means on Workers: no memory, state read
  // back from D1. Re-running with the same persisted state must stay quiet.
  const revived = JSON.parse(JSON.stringify(states));
  r = await cycle(rows(...flatRun(40, 26.5)), revived, rec);
  check("no spurious alert on a cold isolate with persisted state", r.sent.length === 0);
  states = r.states;

  console.log("\nRecovery");
  r = await cycle(rows({ minutesAgo: 0, ambient_c: 25.0, hvac_status: "OFF" }), states, rec);
  states = r.states;
  check("sends exactly one recovery", rec.recoveries().length === 1);
  check("recovery does not claim cooling resumed when it was switched off",
    rec.recoveries()[0].body.includes("No longer calling for cool"));

  r = await cycle(rows({ minutesAgo: 0, ambient_c: 24.8, hvac_status: "OFF" }), states, rec);
  check("does not repeat the recovery", rec.recoveries().length === 1);
}

// ---------------------------------------------------------------- Alert B

console.log("\nAlert B - humidity");
{
  // The old rule was two consecutive polls - ten minutes - and the October 2026
  // log is a wall of five-minute episodes that cleared themselves. These cases
  // pin the tolerance that replaced it.
  const rec = new Recorder();
  const brief = await cycle(rows(...humidRun(20, 66)), {}, rec);
  check("twenty minutes over threshold does not fire",
    !brief.sent.some((s) => s.type === "B"));

  const sustained = await cycle(rows(...humidRun(50, 66)), {}, rec);
  check("fires once humidity has held for the dwell window",
    sustained.sent.some((s) => s.type === "B"));

  const body = rec.fires().find((f) => f.type === "B")?.body || "";
  check("humidity message states how long it held", /held for \d+ minutes/.test(body));

  // A single reading after a cron gap is not evidence of 45 minutes.
  const gap = await cycle(
    rows({ minutesAgo: 0, ambient_c: 25, humidity_pct: 70 },
         { minutesAgo: 400, ambient_c: 25, humidity_pct: 70 }),
    {},
    new Recorder()
  );
  check("one reading after a gap does not satisfy the dwell",
    !gap.sent.some((s) => s.type === "B"));

  // Hysteresis: active at 60, a reading of 59 holds (margin 2), 57 clears.
  const held = await cycle(rows(...humidRun(50, 59)), sustained.states, new Recorder());
  check("stays active inside the clear margin", Boolean(held.states.B.active));

  const cleared = await cycle(rows(...humidRun(50, 57)), sustained.states, new Recorder());
  check("clears once it falls past the margin", !cleared.states.B.active);

  // The margin must not become a back door into firing.
  const belowFresh = await cycle(rows(...humidRun(50, 59)), {}, new Recorder());
  check("a reading inside the margin never fires from cold",
    !belowFresh.sent.some((s) => s.type === "B"));
}

// ------------------------------------------------- Alert A keeps reminding

console.log("\nAlert A - hourly reminders");
{
  const rec = new Recorder();
  const stuck = rows(...flatRun(30, 26.5));
  const t0 = new Date();
  const at = (mins) => new Date(t0.getTime() + mins * 60000);

  let r = await cycle(stuck, {}, rec, { now: t0 });
  check("first notification is the fire", rec.fires().length === 1);

  r = await cycle(stuck, r.states, rec, { now: at(30) });
  check("silent half an hour in", rec.fires().length === 1);

  r = await cycle(stuck, r.states, rec, { now: at(61) });
  check("reminds an hour after the first alert", rec.fires().length === 2);
  check("reminder is numbered in the title", /still \(1\/10\)/.test(rec.fires()[1].title));
  check("reminder body says it is still not cooling",
    /Still not cooling/.test(rec.fires()[1].body));

  r = await cycle(stuck, r.states, rec, { now: at(95) });
  check("does not remind twice inside the hour", rec.fires().length === 2);

  r = await cycle(stuck, r.states, rec, { now: at(121) });
  check("reminds again at two hours", rec.fires().length === 3);

  for (let h = 3; h <= 13; h++) r = await cycle(stuck, r.states, rec, { now: at(h * 60 + 1) });
  check("stops after ten reminders", rec.fires().length === 11);
  check("the tenth reminder is numbered 10/10", /still \(10\/10\)/.test(rec.fires()[10].title));

  // One row per episode: reminders notify, they do not fill the evidence log.
  check("reminders are not written to the alert log",
    rec.rows.filter((x) => x.type === "A" && x.direction === "fire").length === 1);

  const back = await cycle(
    rows({ minutesAgo: 0, ambient_c: 25.0, hvac_status: "OFF" }), r.states, rec,
    { now: at(14 * 60) }
  );
  check("recovery still fires after the reminders",
    back.sent.some((x) => x.direction === "recover"));
}

// --------------------------------------------------- delivery is recorded

console.log("\nDelivery evidence");
{
  const ok = new Recorder();
  await cycle(rows(...flatRun(30, 26.5)), {}, ok);
  check("a delivered alert is marked notified in the log",
    ok.rows.find((x) => x.type === "A" && x.direction === "fire")?.notified === true);

  const down = new Recorder(false);
  const r = await cycle(rows(...flatRun(30, 26.5)), {}, down);
  check("an undelivered alert is still recorded",
    Boolean(down.rows.find((x) => x.type === "A" && x.direction === "fire")));
  check("an undelivered alert is not marked notified",
    down.rows.find((x) => x.type === "A" && x.direction === "fire")?.notified === false);

  // The retry that lands on a later tick still stamps the row it belongs to.
  down.deliver = true;
  await cycle(rows(...flatRun(35, 26.5)), r.states, down);
  check("a later successful retry marks the original row notified",
    down.rows.find((x) => x.type === "A" && x.direction === "fire")?.notified === true);
}

// ------------------------------------------------- stall after a good start

console.log("\nStall after a working start");
{
  // The production failure: 70 minutes of continuous COOLING, 2.0F removed in
  // the first 25 minutes, then dead flat for 45.
  const spec = [];
  for (let m = 0; m <= 45; m += 5) spec.push({ minutesAgo: m, ambient_c: 26.79, hvac_status: "COOLING" });
  for (let m = 50; m <= 70; m += 5) {
    spec.push({ minutesAgo: m, ambient_c: 26.79 + ((m - 45) * 1.11) / 25, hvac_status: "COOLING" });
  }
  const stalled = rows(...spec);

  const run = coolingStreak(usableWindow(stalled, settings.poll_seconds));
  check("whole-run drop really does exceed the threshold (the trap)",
    run.dropF > settings.min_drop_f);

  const rec = new Recorder();
  const r = await cycle(stalled, {}, rec);
  check("fires on a run that cooled first and then stalled",
    r.sent.some((s) => s.type === "A"));
  check("message reports the flat window, not the whole run",
    (rec.fires()[0]?.body || "").includes("No cooling for"));

  // A long run that is still genuinely cooling must stay silent.
  const working = [];
  for (let m = 0; m <= 70; m += 5) {
    working.push({ minutesAgo: m, ambient_c: 26.5 + m * 0.02, hvac_status: "COOLING" });
  }
  const quiet = new Recorder();
  const r2 = await cycle(rows(...working), {}, quiet);
  check("stays silent on a long run that is still cooling",
    !r2.sent.some((s) => s.type === "A"));
}

// ------------------------------------------ evidence survives delivery failure

console.log("\nPush service down");
{
  // On 2026-08-28 the ntfy quota was exhausted while a technician was on site.
  // Delivery failed, and because the alert row was only written on successful
  // delivery, a real 25-minute lockout never reached the alerts table.
  const down = new Recorder(false);
  let r = await cycle(rows(...flatRun(30, 26.5)), {}, down);

  check("nothing is delivered when the push service is down", down.sent.length === 0);
  check("the alert is still recorded as evidence",
    down.rows.some((x) => x.type === "A" && x.direction === "fire"));
  check("alert stays unfired so delivery retries", !r.states.A.fired);
  check("alert is marked logged so it is not recorded twice", Boolean(r.states.A.logged));

  // Next tick, still stuck, still no delivery: must not duplicate the row.
  const before = down.rows.length;
  r = await cycle(rows(...flatRun(35, 26.5)), r.states, down);
  check("does not write a second row while the same episode continues",
    down.rows.length === before);

  // Cleared: the recovery must be recorded even though nothing was ever sent.
  r = await cycle(rows({ minutesAgo: 0, ambient_c: 25.0, hvac_status: "OFF" }), r.states, down);
  check("recovery is recorded even though no notification was ever delivered",
    down.rows.some((x) => x.type === "A" && x.direction === "recover"));
  check("no recovery notification is sent for an alert that never notified",
    down.recoveries().length === 0);
}

// -------------------------------------------------- malformed API response

console.log("\nMalformed reading");
{
  const rec = new Recorder();
  const humid55 = humidRun(55, 66).map((x) => ({ ...x, minutesAgo: x.minutesAgo + 5 }));
  let r = await cycle(rows(...humid55), {}, rec);
  check("humidity alert is active before the malformed row", Boolean(r.states.B.active));

  // A 200 that carried no traits: every field null, no error set.
  const withNull = rows(
    { minutesAgo: 0, ambient_c: null, humidity_pct: null, hvac_status: null, connectivity: null },
    ...humid55
  );
  const after = await cycle(withNull, r.states, rec);
  check("null reading does not fire a false recovery",
    !after.sent.some((s) => s.direction === "recover"));
  check("humidity alert stays active through a null reading", Boolean(after.states.B.active));
}

// ------------------------------------------------- one failed poll mid-run

console.log("\nFailed poll during a lockout");
{
  const spec = flatRun(30, 26.5);
  const withError = spec.map((s) =>
    s.minutesAgo === 15
      ? { minutesAgo: 15, ambient_c: null, hvac_status: null, error: "TimeoutError" }
      : s
  );
  const rec = new Recorder();
  const r = await cycle(rows(...withError), {}, rec);
  check("one failed poll does not reset the stuck-cooling clock",
    r.sent.some((s) => s.type === "A"));
}

// ------------------------------------------------------------- clock gap

console.log("\nMissed cron ticks");
{
  // Two COOLING samples six hours apart. The naive window is 360 minutes with
  // no movement, which would fire a bogus Alert A on the first tick back.
  const rec = new Recorder();
  const r = await cycle(
    rows(
      { minutesAgo: 0, ambient_c: 26.5, hvac_status: "COOLING" },
      { minutesAgo: 360, ambient_c: 26.5, hvac_status: "COOLING" }
    ),
    {},
    rec
  );
  check("no bogus alert across a six hour gap", r.sent.length === 0);
}

// ----------------------------------------------------------- quiet hours

console.log("\nQuiet hours");
{
  const quiet = { ...settings, quiet_hours_enabled: true, quiet_start: "00:00", quiet_end: "23:59" };
  const rec = new Recorder();
  const r = await cycle(rows(...flatRun(50, 26.5, { humidity_pct: 70 })), {}, rec, {
    settings: quiet,
  });
  const types = new Set(r.sent.map((s) => s.type));
  check("Alert A still fires during quiet hours", types.has("A"));
  check("Alert B is held during quiet hours", !types.has("B"));
  check("held alert is marked pending", Boolean(r.states.B.pending));
}

// --------------------------------------------------------- misc helpers

console.log("\nHelpers");
{
  check("stall() returns null for a run shorter than the window",
    stall(coolingStreak(rows(...flatRun(10, 26.5))).streak, 25) === null);
  check("quiet hours wrap past midnight",
    inQuietHours({ quiet_hours_enabled: true, quiet_start: "22:00", quiet_end: "07:00" },
      new Date("2026-08-27T06:00:00-04:00"), TZ));
  check("quiet hours exclude the middle of the day",
    !inQuietHours({ quiet_hours_enabled: true, quiet_start: "22:00", quiet_end: "07:00" },
      new Date("2026-08-27T13:00:00-04:00"), TZ));
}

// ------------------------------------------------------------------ done

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
