# Build Spec: Nest AC Failure Monitor

Target implementer: Claude Code
Host: Windows PC, always-on
Language: Python 3.11+

---

## 1. Problem this solves

The apartment is served by a water-source heat pump on a building condenser-water
loop fed by a rooftop cooling tower. When loop temperature rises (tower fault) or
evaporator load spikes (balcony door open), refrigerant discharge pressure climbs
until a safety switch opens the compressor circuit. The blower keeps running, so
the apartment sounds like it is cooling while the temperature climbs. The failure
is silent and is typically discovered hours later.

The Nest thermostat cannot detect this. It reports its own **commanded** state, not
whether the compressor is actually running. Its Energy History draws a solid bar for
"calling for cool" whether the compressor is working, losing, or dead.

**The app's job is to infer the failure from the divergence between commanded state
and observed temperature, and push an alert to the phone.**

---

## 2. Scope

### v1 (build this)

Read-only monitoring and alerting. The app issues **no** commands to the thermostat.
This is a deliberate safety property: a bug cannot leave the apartment uncooled.

### v2 (design for, do not enable)

A duty cycler that pushes the setpoint up on a timer to force compressor off-periods.
Stub the interface, ship it disabled behind an explicit config flag, and put a warning
in the UI. See §9 for why this is deprioritized.

---

## 3. Data source

Google Smart Device Management (SDM) API.

- Device: Nest Learning Thermostat, purchased 2021. Supported under
  `sdm.devices.types.THERMOSTAT`.
- Requires a Device Access project ($5 one-time) and a **personal** Google account.
  Workspace accounts cannot complete the OAuth flow.
- Auth: OAuth 2.0 authorization-code flow, refresh token persisted locally.

### Traits consumed

| Trait | Field | Use |
|---|---|---|
| `sdm.devices.traits.Temperature` | `ambientTemperatureCelsius` | primary signal |
| `sdm.devices.traits.Humidity` | `ambientHumidityPercent` | secondary alert |
| `sdm.devices.traits.ThermostatHvac` | `status` (`OFF`/`HEATING`/`COOLING`) | commanded state |
| `sdm.devices.traits.ThermostatMode` | `mode` | sanity check |
| `sdm.devices.traits.ThermostatTemperatureSetpoint` | `coolCelsius` | context |
| `sdm.devices.traits.Connectivity` | `status` | offline alert |

All temperatures from the API are Celsius. Convert for display; store Celsius
internally to avoid rounding drift.

### Polling

`devices.get` every 5 minutes (configurable, floor of 2 minutes).

Rate limits: the THERMOSTAT device-instance limit is 5 QPM / 100 QPH, and that limit
applies to `executeCommand`, not to `get` and `list`. API-method-level limits still
apply per project and user. A 5-minute poll is 12 calls/hour and is not near any limit.

Do **not** implement Pub/Sub event subscription in v1. Polling is sufficient for a
25-minute detection window and removes a large dependency.

---

## 4. Detection logic

Maintain a rolling in-memory buffer of the last 12 samples (1 hour at 5-minute polls),
backed by the SQLite log so the buffer survives restarts.

### Alert A — stuck cooling (primary)

Fire when **all** hold:

- `ThermostatHvac.status == "COOLING"` continuously for >= `stuck_minutes` (default 25)
- Ambient temperature over that window has fallen by less than `min_drop_f`
  (default 0.5 °F) — i.e. flat or rising
- Not currently in an alert-suppression window

Rationale for the 25-minute default: a healthy cycle on this system completes in
well under that. A run longer than 25 minutes with no temperature movement is
either a compressor that has tripped off or one that is running and losing to the
load. Both warrant waking up.

### Alert B — humidity

Fire when `ambientHumidityPercent >= humidity_pct` (default 60) for two consecutive
polls. This is the latent-load failure: the coil has stopped dehumidifying.

### Alert C — thermostat offline

Fire when `Connectivity.status != "ONLINE"` for two consecutive polls, or when the
API returns errors for 3 consecutive polls.

### Alert D — auth expiry

Fire when the refresh token fails. This is the silent killer of long-running
integrations; treat it as a first-class alert, not a log line.

### Recovery notification

When a fired alert's condition clears, send a single recovery notification. Do not
send repeat recovery messages.

### Suppression

- Maximum one alert of a given type per `cooldown_minutes` (default 60).
- Optional quiet hours window (default: disabled). If enabled, Alert A still fires —
  the whole point is to wake the user — but Alerts B and C are held until the window ends.

---

## 5. Notifications

Pluggable notifier interface. Ship two implementations:

1. **ntfy.sh** — default. No account required, topic-based, works from a Windows box
   behind NAT with no inbound ports. Config: topic name, optional self-hosted server URL.
2. **Pushover** — for the user who wants delivery receipts and priority escalation.
   Config: user key, app token. Support `priority=1` for Alert A so it bypasses
   the phone's quiet mode.

Interface:

```python
class Notifier(Protocol):
    def send(self, title: str, body: str, priority: int = 0) -> None: ...
```

Message body for Alert A must include: current ambient temp (°F), setpoint (°F),
minutes in the stuck condition, and temperature delta over the window. Enough to
decide whether to get up.

---

## 6. Local web UI

A single-page UI served on `http://localhost:8765`. FastAPI + Jinja2 + vanilla JS.
No build step, no npm, no framework. The page polls a JSON status endpoint every
10 seconds.

### Required controls

- **Master toggle: monitoring on / off.** Large, unambiguous, top of page. State
  persists across restarts.
- **Per-alert toggles** for A, B, C, D.
- **Threshold inputs**: `stuck_minutes`, `min_drop_f`, `humidity_pct`,
  `poll_seconds`, `cooldown_minutes`.
- **Quiet hours**: enable checkbox plus start/end time.
- **Notifier selection** and its credential fields.
- **"Send test notification"** button. Non-negotiable — the user must be able to
  verify the delivery path without waiting for a real failure.
- **Re-authenticate** button that restarts the OAuth flow.

### Required display

- Connection status: API reachable, thermostat online, token valid, last poll time.
- Current ambient temp, humidity, setpoint, HVAC status, thermostat mode.
- A sparkline or small chart of the last 24 hours: ambient temperature line with
  shaded bands where HVAC status was COOLING. This is the diagnostic view — it makes
  a stuck-cooling episode visually obvious.
- Alert log: last 50 events with timestamp, type, and whether it was a fire or a recovery.

### UI constraints

- Must render correctly when the browser is opened from another machine on the LAN
  (bind `0.0.0.0`, but see §8 on auth).
- No external CDN dependencies. Vendor any JS locally. The app must work if the
  internet is down, because that is one of the states it needs to report.

---

## 7. Persistence

SQLite at `%LOCALAPPDATA%\NestACMonitor\monitor.db`.

Tables:

- `samples(ts, ambient_c, humidity_pct, hvac_status, mode, cool_setpoint_c, connectivity)`
- `alerts(ts, alert_type, direction, payload_json)` where direction is `fire` or `recover`
- `config(key, value)`

Also write a daily rolling CSV export of `samples` to a configurable folder. This is
not decoration: the temperature-vs-HVAC-status record is evidence for the HVAC
contractor and for the condo association about how often the unit is failing to hold
setpoint. Make it easy to hand over.

Retention: keep samples for 90 days, then prune. Alerts are never pruned.

Secrets (OAuth client secret, refresh token, Pushover token) go in a separate file
with restrictive ACLs, not in the SQLite DB and not in any file the CSV export
folder could expose.

---

## 8. Deployment on Windows

- Package as a normal Python project with `pyproject.toml`. No PyInstaller in v1.
- Provide a PowerShell script that registers a **Scheduled Task** running at system
  startup under the user account, with "run whether user is logged on or not"
  and restart-on-failure. Do not use NSSM or a custom service wrapper; the
  scheduled task is fewer moving parts.
- Handle Windows sleep: on wake, detect the clock gap and clear the rolling buffer
  rather than computing a bogus 6-hour "stuck" window. Log the gap.
- Document in the README that the PC must be set to never sleep for the monitor to
  be useful overnight, and how to set that.
- If the UI binds beyond localhost, require a shared secret in a cookie set by a
  one-time URL. Do not ship an unauthenticated control surface that toggles
  monitoring on a LAN.

---

## 9. v2 duty cycler — design notes, disabled by default

The idea is to push the cooling setpoint up (e.g. to 80 °F) for a fixed rest period
every N minutes of run time, forcing compressor off-time so refrigerant pressures
equalize between cycles.

Constraints discovered during research that the implementation must respect:

- **Manipulate the setpoint, never the HVAC mode.** `set_temperature` immediately
  after `turn_on` fails intermittently, and is ignored outright while the entity is
  off. Setpoint pushes on an already-COOLing thermostat are reliable; mode toggling
  is not.
- **Never touch Eco mode.** `ThermostatEco.SetMode` returns `FAILED_PRECONDITION`
  when the thermostat is already in the requested state, and the error aborts the
  rest of the routine.
- **Watchdog is mandatory.** If the control loop dies with the setpoint parked at
  80, the apartment stays hot until someone notices. Persist the "elevated setpoint"
  state to disk on every write; on startup, if that flag is set, immediately restore
  the normal setpoint before doing anything else.
- **Abort ceiling.** End the rest period early if ambient exceeds a user-set maximum.
- **The Nest schedule must be deleted first**, or it will fight the cycler.
- Setpoint commands are Celsius-only and the device rounds; verify the readback
  matches intent before assuming a command landed.

Why it ships disabled: no prior art was found for this approach, the same effect is
achieved more reliably by a hardware timer at the air handler (see the companion
hardware document), and the software version depends on Google's cloud, the PC
staying awake, and an OAuth token that expires.

---

## 10. Non-goals

- Controlling the thermostat in v1.
- Camera or doorbell support.
- Multi-thermostat support. One device, hardcode the selection after discovery.
- Home Assistant. It is not natively supported on Windows and would require running
  a Linux VM for two automations.
- Historical import from Nest Energy History. The API does not expose it.

---

## 11. Acceptance criteria

1. Fresh install completes OAuth and shows live temperature within 10 minutes.
2. "Send test notification" delivers to the phone.
3. Simulated stuck-cooling (inject synthetic samples via a test hook) fires Alert A
   within one poll of crossing the threshold, and fires exactly once.
4. Killing and restarting the process preserves config, alert state, and does not
   emit a spurious alert on the first poll after restart.
5. Pulling the network cable produces Alert C, and restoring it produces a recovery
   notification.
6. 24 hours of continuous operation with no memory growth and no duplicate alerts.
