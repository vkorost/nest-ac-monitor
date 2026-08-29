# Assignment: build a Nest AC failure monitor

A complete brief for reproducing this project with an AI coding agent
(Claude Code or similar). Hand it the whole file.

It is written as a specification plus a list of traps. The traps are the
valuable part — every one of them cost real time or produced a wrong answer
during the original build, and most are invisible until something has already
failed at 2 AM.

---

## 1. The problem

An apartment air conditioner — typically a **water-source heat pump** on a
building-wide condenser water loop fed by rooftop cooling towers — has safety
switches that open the compressor circuit while **leaving the blower running**.

The result is a silent failure. Air keeps moving at room temperature. The
apartment sounds exactly like it is cooling while it warms up. It is normally
discovered hours later.

**The thermostat cannot detect this.** A Nest reports its own *commanded* state,
never whether the compressor is actually running. Its Energy History draws a
solid bar for "calling for cool" whether the compressor is working, losing, or
dead.

### The inference to implement

> Sustained `COOLING` plus a room that is not getting cooler means the compressor
> is not running.

From outside the unit that is the only signal available, and it is sufficient.

### What the user actually needs

Two things, in this order of importance:

1. **A record.** Timestamped evidence of how often and at what hours the unit
   fails to hold setpoint, in a form that can be handed to a technician or
   attached to correspondence with a building manager. This is the deliverable.
2. **An alert.** So the failure is noticed in minutes instead of hours.

Build for the record first. The alerting is easier and matters less.

---

## 2. Hard constraints

**Read-only. The application must never send a command to the thermostat.**
No `executeCommand`, no setpoint writes, no mode changes. Every call to the
device API is a `GET`. This is a safety property, not a simplification: a bug in
the monitor must not be able to leave the apartment uncooled. Do not add a write
path even if asked to "just" adjust a setpoint.

**Runs in the cloud, not on the user's computer.** A monitor running inside the
apartment cannot report that the apartment lost power or internet — it dies with
the thing it is watching, and a hole in the record is what gets a record
dismissed.

**Free hosting.** Must fit inside Cloudflare Workers + D1 free tiers.
288 polls/day against limits of 100k requests and 100k D1 writes.

**No build step, no CDN, no npm at runtime.** Vendor or inline everything. One of
the states the app must report is "the internet is down."

### Non-goals

- Controlling the thermostat, now or later
- Multi-device support — one thermostat, pinned after discovery
- Cameras, doorbells
- Home Assistant integration
- Importing historical data from Nest Energy History (the API does not expose it)

---

## 3. What the user must do before any code runs

These cannot be automated. Walk them through it.

1. **Register for Google Device Access — $5, one time, non-refundable.**
2. **Create a Google Cloud project**, enable the Smart Device Management API,
   create an OAuth client.
3. **Buy Pushover — $5, one time** (or accept unreliable free notifications).

See §9 for the traps in each.

---

## 4. Architecture

```
Cloudflare Worker
├── scheduled()  cron "*/5 * * * *"
│     read thermostat -> read weather -> write sample
│     -> evaluate conditions -> advance state machine
│     -> record alert rows -> push notification
└── fetch()      dashboard + JSON API, behind auth

D1 (SQLite)      samples, alerts, config, alert_state
```

**Every cron tick is a cold isolate with no memory of the last one.** All state
must live in D1. Nothing may sit in a module-level variable and be expected to
survive. This is the single most important architectural fact.

### Suggested module layout

```
src/detect.js   alert logic - PURE FUNCTIONS, no I/O   <- most important file
src/db.js       D1 access, settings, retention
src/sdm.js      Google Smart Device Management, read-only
src/weather.js  Open-Meteo
src/notify.js   Notifier interface + implementations
src/index.js    cron handler, HTTP router, CSV export
src/ui.js       the dashboard, as one inlined string
test/           runs under plain node, no D1 and no network
```

**Keep `detect.js` free of I/O.** It should take arrays of plain row objects and
return decisions. That is what makes the whole state machine testable without a
database, a network, or a running Worker — and it is what lets you write a
regression test for a production bug in two minutes instead of an hour.

---

## 5. Data model

```sql
CREATE TABLE samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,            -- ISO8601 UTC
    ts_local TEXT NOT NULL,      -- ISO8601 with local offset
    ambient_c REAL, humidity_pct REAL,
    hvac_status TEXT, mode TEXT, cool_setpoint_c REAL,
    connectivity TEXT,
    error TEXT,                  -- NULL on success
    outdoor_c REAL, outdoor_rh_pct REAL,
    outdoor_dewpoint_c REAL, outdoor_wetbulb_c REAL
);

CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ts_local TEXT NOT NULL,
    alert_type TEXT NOT NULL,    -- A | B | C | D
    direction TEXT NOT NULL,     -- fire | recover
    payload_json TEXT
);

CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE alert_state (
    alert_type TEXT PRIMARY KEY,
    active INTEGER NOT NULL DEFAULT 0,
    fired INTEGER NOT NULL DEFAULT 0,   -- notification actually delivered
    logged INTEGER NOT NULL DEFAULT 0,  -- alert row written (evidence)
    pending INTEGER NOT NULL DEFAULT 0, -- held by quiet hours
    since_ts TEXT, last_fire_ts TEXT
);
```

**Store both UTC and local timestamps.** Evening and overnight failures are the
entire argument; a record a technician cannot read at a glance is worth less.

**Store Celsius as the API returns it.** Convert only for display. Rounding on
the way in compounds across months of samples.

**Record failed polls as rows** with the message in `error`. An outage must
appear in the record as rows, not as a silent gap. The offline alert keys off
them.

**Retention: prune samples after 90 days. Never prune alerts.** They are the
evidence and they are tiny.

---

## 6. Detection

### Alert A — stuck cooling (the primary one)

Fires when **all** hold:

- `hvac_status == "COOLING"` continuously for at least `stuck_minutes` (25)
- The room fell by **less than** `min_drop_f` (0.5 °F) **over the trailing
  `stuck_minutes`**, not over the whole run
- Not suppressed by cooldown

> ### ⚠️ The trailing window is the most important detail in this document
>
> The obvious implementation measures temperature change across the entire
> unbroken `COOLING` run. **It is wrong, and it fails silently on the most common
> real failure.**
>
> Observed in production: a 70-minute run removed 2.0 °F in its first 25 minutes,
> then sat **completely flat for 45 minutes** while still calling for cool.
> Measured across the whole run the drop was 2.0 °F — four times the threshold —
> so nothing fired. The unit's good first 25 minutes had permanently immunised it
> against ever being detected as stuck. The longer it sat dead, the healthier it
> looked.
>
> This is exactly the documented behaviour of the failure: *"cools two to four
> degrees over 20–30 minutes and shuts down again."*
>
> Measure the **most recent** `stuck_minutes` of the run. The question is not
> whether it has ever cooled; it is whether it is cooling **now**.

### Alert B — humidity

`humidity_pct >= humidity_pct` (60) on two consecutive polls. This is the
latent-load failure: the coil has stopped dehumidifying. **Often the earliest
signal** — humidity rises during a stalled cooling run, because the blower
re-evaporates condensate off a coil that is no longer cold.

### Alert C — thermostat offline

`connectivity != "ONLINE"` on two consecutive polls, **or** three consecutive
poll errors.

### Alert D — auth expiry

The refresh token was rejected. **Treat this as a first-class alert, not a log
line.** It is the silent killer of long-running integrations: without it the
monitor goes blind and nothing tells you.

### Suppression

- One alert per type per `cooldown_minutes` (60)
- Optional quiet hours: hold B and C until the window ends. **A always fires** —
  waking the user is the point.

### Recovery

One notification when a fired alert clears. Never repeat it.

**Make the recovery message state-aware.** The stuck-cooling condition clears for
two very different reasons: the compressor came back, or the thermostat stopped
calling for cool at all (setpoint reached, or a manual reset). Saying "cooling
resumed" when someone just switched it off is a lie in the record.

---

## 7. Notifications

A pluggable interface:

```js
send(title: string, body: string, priority: 0 | 1 | 2): Promise<void>
```

Normalise priority across backends: `0` normal, `1` high, `2` emergency. Make the
mapping explicit per backend and let the user choose whether the stuck-cooling
alert is allowed to override Do Not Disturb.

The stuck-cooling message must carry: **room temperature, setpoint, minutes
stuck, temperature change over the window, humidity, and outdoor wet bulb.**
Enough to decide whether to get out of bed without opening anything.

### Backends

- **Pushover** — $5 one time, per-account quota, delivery receipts, an emergency
  priority that re-alerts until acknowledged, and Apple-approved Critical Alerts
  on iOS. **Recommended.**
- **ntfy.sh** — free and account-less, fine from a home IP. **See the trap in
  §9.** It does not work reliably from a cloud host.

---

## 8. The dashboard

Single page, served by the Worker, everything inlined. No CDN, no build step.

**Layout order matters.** Live readings first, then the chart, then everything
else. The chart is the diagnostic view — a wide COOLING band where the room line
does not fall is a lockout, visible at a glance.

Required:

- **Master on/off switch**, large and unambiguous, state persisted
- **Live readings**: room, setpoint, humidity, HVAC status, mode, outdoor, wet
  bulb — plus a one-sentence plain-language verdict
- **Chart** with selectable ranges (24h / 1 week / 1 month / 1 year / all),
  ambient line, setpoint line, outdoor wet bulb line, and **shaded bands where
  the thermostat was calling for cool**
- **Hover/touch tooltip** with a crosshair and the exact values at that point
- Per-alert toggles, thresholds, quiet hours
- **Send test notification** button — non-negotiable. The delivery path must be
  verifiable without waiting for a real failure.
- Re-authenticate flow
- Alert log with plain-language labels
- CSV export

### Details that turn out to matter

- **Downsample long ranges server-side.** A year of five-minute samples is
  ~105,000 rows. Bucket by hour beyond a few days, by day beyond a few months.
  Carry **min/max** per bucket so an averaged day that swung ten degrees does not
  render as a flat line, and a **cooling fraction** so the shading still means
  something once individual cycles are averaged away.
- **Mobile first.** This gets checked from a phone, in bed, at 2 AM. Single
  column by default; inputs at 16px so mobile browsers do not zoom on focus;
  40px+ touch targets.
- **Collapsible panels with remembered state.** Wrap `localStorage` in
  `try/catch` — in some privacy modes it throws rather than returning null.
- **Avoid jargon in the UI.** `fire`/`recover` are database values; users read
  them as "started"/"cleared". `A`/`B`/`C`/`D` are internal; show the names.

---

## 9. Traps

Every one of these was hit for real.

### Google Device Access

- **Google Workspace accounts cannot do this at all.** Not a warning — the
  Device Access Console will not load and the OAuth flow cannot complete. A
  personal `@gmail.com` account is required. Check before spending the $5.
- **The $5 binds permanently to the account that pays.** It cannot be moved.
- **The thermostat must be migrated to a Google Account**, not a legacy Nest
  account. Free way to check first: does the device appear in the Google Home
  app? If not, the API will return an empty device list and the $5 is wasted.
- **⚠️ Publish the OAuth app to production, or refresh tokens expire every 7
  days.** In "Testing" publishing status Google expires every refresh token after
  exactly one week. The monitor dies silently, weekly, at whatever hour the token
  was issued. This is the single most common way this project fails a month
  later.
- **Publishing requires a homepage URL and a privacy policy URL** — and Google's
  form does **not** mark them as required. The Publish button is simply greyed
  out, and the error text points at the wrong page. Hover the disabled button to
  see the real message. Two trivial static pages satisfy it; templates are in
  [`oauth-pages/`](oauth-pages/).
- **The redirect URI is `https://www.google.com`, exactly.** No trailing slash.
  It looks wrong — you are not running a server there — but it is Google's
  documented pattern for Device Access. The authorization code comes back as a
  query parameter and the user copies the whole URL out of the address bar.
- **Authorization is not complete until a `devices.list` call is made.** Skip it
  and the connection stays half-open.
- **Setpoints are Celsius-only and the device rounds.** Ask for 81 °F, read back
  80.7 °F. Not a bug; do not "fix" it.
- **Rate limits apply to `executeCommand`, not to `get`/`list`.** A 5-minute poll
  is nowhere near any ceiling.

### Cloudflare

- **⚠️ Cloudflare's browser-integrity check blocks default library user agents
  at the edge**, before the Worker ever sees the request — HTTP **403 with
  `error code: 1010`** in the body. `curl` passes; `Python-urllib` does not. Any
  script hitting the API needs a conventional `User-Agent` header. Note the
  difference: **401 means the Worker rejected you; 403/1010 means you never
  reached it.**
- **Worker secrets take a few seconds to propagate.** A test immediately after
  `wrangler secret put` can fail with the old value. Retry before debugging.
- **`wrangler d1 execute --command` has quoting problems on Windows.** Use
  `--file` with a `.sql` file instead.
- **Cloudflare Access + service tokens: `auto_redirect_to_identity` must be
  `false`.** With it on, Access redirects to the identity provider *before*
  checking service-token headers, so automated access gets a 302 no matter what
  credentials it presents.
- The Access API needs its own scoped API token (`Access: Apps and Policies`,
  `Access: Organizations, Identity Providers, and Groups`, and
  `Access: Service Tokens` if creating those). Wrangler's OAuth token does not
  carry them.

### ntfy.sh

- **⚠️ The free tier meters quota by IP address, even when authenticated.**
  The account object reports `"limits": {"basis": "ip"}`. From a Cloudflare
  Worker you share that 250-messages-per-day allowance with every other customer
  on the same egress address, and strangers exhaust it. Creating an account and
  an access token **does not help** — only a paid tier moves the quota onto the
  account.
  Symptom: publishing works from a home connection and returns HTTP 429 from the
  Worker, same topic, same token, same moment.

### Logic bugs to write tests for before you hit them

1. **A run that cools and then stalls.** See §6. The whole-run measurement can
   never detect it.
2. **A malformed API response stored as a valid reading.** A 200 that carries no
   traits produces an all-null row. If that is stored with `error = NULL`, it
   clears active alerts and emits a **false recovery** — telling the user the AC
   came back when it had not. That is worse than no alert at all. Treat a reading
   with no ambient temperature as a failed poll.
3. **Evidence lost when notifications fail.** If the alert row is only written
   after a successful push, an outage at the notification service erases the
   record of a real failure. **Separate recording from delivery**: write the row
   unconditionally, retry only the push.
4. **One failed poll resetting the cooling streak.** A network blip forty minutes
   into a lockout should not restart the clock and delay the alert by another
   full window. Skip error rows in the streak rather than breaking on them.
5. **A clock gap producing a bogus alert.** Two `COOLING` samples six hours apart
   — a sleeping PC, a missed cron run, a deployment gap — look like a six-hour
   stuck window. Trim the rolling buffer at any gap larger than about three poll
   intervals.
6. **Sign errors in temperature deltas.** Decide once whether positive means
   warmer or cooler, write it in a comment, and keep every module consistent. An
   inverted sign will label a working unit "stuck" and vice versa.

---

## 10. Acceptance criteria

1. Fresh install completes OAuth and shows a live temperature within 10 minutes.
2. "Send test notification" delivers to the phone.
3. Synthetic stuck-cooling samples fire the alert within one poll of crossing the
   threshold, and fire **exactly once**.
4. Restarting the process preserves config and alert state and does not emit a
   spurious alert on the first poll afterwards.
5. Losing connectivity produces the offline alert; restoring it produces one
   recovery.
6. 24 hours of continuous operation with no duplicate alerts and no memory
   growth.
7. **A run that cools 2 °F and then goes flat for 45 minutes fires the alert.**
8. **A malformed reading does not fire a recovery.**
9. **An alert is recorded even when the push service is down.**

Numbers 7–9 are the ones that separate software that works from software that
looks like it works.

---

## 11. Build order

Working code early beats a complete design.

1. **OAuth first, and verify with a live reading.** Nothing else can be tested
   until this works. Write a script that walks the user through it, exchanges the
   code, calls `devices.list`, prints the current temperature, and stores
   credentials with restrictive file permissions.
2. **A minimal poller — 40 lines, no alerts, no UI.** Get it writing samples to
   the real schema immediately. Every hour before this exists is evidence lost,
   and in a hot month that data is not recoverable.
3. **The detection logic, with its tests, before any of the plumbing.** Pure
   functions over row arrays. Write the tests from §9 and §10 first.
4. **Notifications**, and verify delivery end to end before trusting anything.
5. **The dashboard.**
6. **Deploy to the cloud** and migrate the samples already collected, so the
   record stays continuous across the move.

### On working alongside a live failure

If the user's equipment is failing while you build, expect the software to be
wrong about a real event at least once. Two of the bugs in §9 were found exactly
that way — the monitor was watching a genuine lockout and said nothing.

When that happens: fix it, write the regression test **seeded from the real
data**, and say plainly what was missed. A monitor that quietly under-reports is
worse than no monitor, because the user stops checking.

---

## 12. Style notes

- **Comment the reasoning, not the mechanics.** `// trim at a clock gap` is
  noise. `// two COOLING samples six hours apart look like a six-hour stuck
  window` is the reason the code exists.
- **Comment the traps at the point of the code they affect.** Someone reading
  `stall()` in a year needs to know why it measures a trailing window, and they
  will not go looking for a design document.
- **Fail closed on anything that guards a control surface.** If the auth secret
  is missing, serve nothing — do not fall back to open.
- **Never invent data.** If a real episode is missing from the record because of
  a bug, say so and leave the gap. A log with a documented hole is worth more
  than one with rows someone typed in afterwards.
