# Nest AC Monitor — Cloudflare deployment

The same monitor, running on Cloudflare Workers + D1 instead of the PC.

Your own hostname, e.g. **https://ac.example.com**

## Why it moved

Not cost — the PC version was free. A monitor running *inside* the apartment
cannot tell you the apartment lost power or internet; it dies with the thing it
is watching, and a hole in the record is what gets a record dismissed. The
building tripped its main breaker in a lightning storm on 4 August 2026. A
monitor hosted elsewhere keeps logging through that and reports the outage as
Alert C.

## Shape

| | |
|---|---|
| Poll | Cron Trigger, `*/5 * * * *` |
| Storage | D1 (`nestac`) |
| UI | Inlined in the Worker. No assets binding, no CDN, no build step |
| Auth | Shared secret in a cookie, or Cloudflare Access if placed in front |
| Cost | Inside the free tier: 288 polls/day against 100k requests and 100k D1 writes |

```
src/detect.js   alert logic, pure functions, no I/O   <- the part worth reading
src/db.js       D1 access, settings, retention
src/sdm.js      Google SDM, read-only
src/weather.js  Open-Meteo, wet bulb
src/notify.js   Pushover + ntfy
src/index.js    cron handler, HTTP router, CSV export
src/ui.js       the dashboard, as one string
test/           35 assertions, plain node, no D1 or network
```

`detect.js` is deliberately free of I/O so the whole state machine runs under
plain node. Every case in `test/` is either an acceptance criterion from the
spec or a bug that actually happened in production.

```bash
node test/detect.test.mjs
```

## Deploy

```bash
npx wrangler d1 create nestac          # copy the id into wrangler.jsonc
npx wrangler d1 execute nestac --remote --file=schema.sql
npx wrangler deploy
```

Start from `wrangler.jsonc.example`: copy it to `wrangler.jsonc`, paste in the
database id from `d1 create`, and set the route to your own hostname.

> **`--command` has quoting problems on Windows.** Use `--file` with a `.sql`
> file for anything non-trivial.

### Secrets

Set with `wrangler secret put NAME`. They are never returned by the API and
never rendered into the page.

| Secret | |
|---|---|
| `NEST_PROJECT_ID` | Device Access project UUID |
| `NEST_CLIENT_ID` | OAuth client id |
| `NEST_CLIENT_SECRET` | OAuth client secret |
| `NEST_REFRESH_TOKEN` | bootstrap refresh token |
| `NEST_DEVICE_ID` | `enterprises/…/devices/…` |
| `NTFY_TOPIC` | ntfy topic — on the public server this *is* the auth |
| `WEB_TOKEN` | shared secret for the dashboard |
| `PUSHOVER_USER_KEY`, `PUSHOVER_TOKEN` | only if using Pushover |

Re-authorising from the dashboard writes the new refresh token to
`config.refresh_token_override`, because Worker secrets cannot be rewritten at
runtime. That key is never exposed by `/api/status` — `getSettings()` only ever
iterates `DEFAULTS`, so it cannot leak by accident.

### Authorising a browser

```
https://ac.example.com/auth?token=<WEB_TOKEN>
```

Sets a year-long cookie. Every other path returns 401 without it. **It fails
closed**: if `WEB_TOKEN` is unset, nothing is served at all. An unauthenticated
page that can switch monitoring off is worse than no dashboard.

For something better, put **Cloudflare Access** in front of the route with a
Google SSO policy. The Worker already honours
`cf-access-authenticated-user-email`, so Access alone is sufficient once
configured.

## Scripted access

Cloudflare's browser-integrity check rejects some default library user agents
at the edge with **error 1010**, before the Worker ever sees the request. `curl`
passes; `Python-urllib` does not. Any script hitting the API needs a
conventional `User-Agent` header:

```python
headers = {
    "Cookie": f"nestac_token={TOKEN}",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) nestac-watch/1.0",
}
```

The symptom is a 403 with `error code: 1010` in the body — not a 401, which is
what a bad token gives you. Worth distinguishing: 401 means the Worker rejected
you, 403/1010 means you never reached it.

## Operations

```bash
npx wrangler tail                                    # live logs
npx wrangler d1 execute nestac --remote \
  --command "SELECT COUNT(*) FROM samples"
```

CSV for any day, for a technician or the association:

```
https://ac.example.com/api/export.csv?day=2026-08-27
```

Samples are pruned after `retention_days` (90), on the tick nearest 04:00 UTC.
Alerts are never pruned.
