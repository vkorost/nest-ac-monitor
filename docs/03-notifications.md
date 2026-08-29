# Notifications

Two backends ship with this project. **Which one you pick matters more than it
looks.** The reason is a trap worth understanding before you choose.

---

## The short version

| | ntfy.sh (free) | Pushover ($5 once) |
|---|---|---|
| Cost | free | $4.99 one time, 30-day trial |
| Account | none needed | yes |
| Works from a home computer | ✅ | ✅ |
| **Works from Cloudflare Workers** | ❌ **no** | ✅ |
| Android Do Not Disturb override | ✅ | ✅ |
| iOS Do Not Disturb override | ❌ | ✅ |
| Repeat until acknowledged | ❌ | ✅ |
| Open source, self-hostable | ✅ | ❌ |

**If you deploy to Cloudflare, which is the whole point of this project, use
Pushover.**

---

## What went wrong with ntfy, in detail

This project originally shipped with **ntfy.sh** as the default. It is free,
needs no account, and worked perfectly while the monitor ran on a home PC.

Moving to Cloudflare broke it, and the failure was not obvious.

### The symptom

```
HTTP 429  {"code":42908, "error":"limit reached: daily message quota reached"}
```

...after **twelve messages in a day**, against a documented limit of 250.

### The diagnosis

Publishing the same topic, with the same credentials, at the same moment:

```
from a home connection      HTTP 200
from the Cloudflare Worker  HTTP 429
```

So it was not the account, not the topic, and not the volume.

**ntfy.sh's free tier meters quota by IP address.** The account object says so
outright:

```json
"limits": { "basis": "ip", "messages": 250 }
```

A Cloudflare Worker sends from Cloudflare's **shared egress addresses**. You are
sharing that 250-messages-per-day allowance with every other Cloudflare customer
publishing to ntfy from the same IP, and strangers use it up.

### What does not fix it

**Creating an ntfy account and an access token.** This was tried. It changed
nothing, because the limit was never about the account. `basis` stays `ip` on
the free tier. Only a **paid** ntfy plan (roughly $60/year) moves the quota onto
your account.

### Why it matters more than it sounds

The failure is *intermittent and silent*. Alerts arrive when the shared quota
happens to have room and vanish when it does not, and the busiest days are hot
days, which is exactly when your air conditioning fails. An alerting system that
becomes unreliable in proportion to how much you need it is worse than one that
is simply absent, because you stop checking.

---

## Pushover

**$4.99, one time, no subscription.** 30-day free trial before you pay anything.
Per-account quota of 10,000 messages/month. At this monitor's alert rate you
would use about 0.25% of that.

> Ignore anything labelled **"Pushover for Teams"** at $5/user/month. That plan
> is for organisations.

### Setup

1. **https://pushover.net/signup**, a free account
2. Install **Pushover Notifications** from the app store and log in. Your
   **User Key** is on the app's main screen and on the website. The trial starts
   here.
3. On pushover.net, click **"Create an Application/API Token"**, name it
   `Nest AC Monitor`, and copy the **API Token**
4. Store both as Worker secrets:

```bash
wrangler secret put PUSHOVER_USER_KEY
wrangler secret put PUSHOVER_TOKEN
```

5. Set the notifier to `pushover` in the dashboard, and press **send test
   notification**

> **Worker secrets take a few seconds to propagate.** A test fired immediately
> after `wrangler secret put` can fail with the old value. Retry once before
> debugging anything.

---

## If you would rather not pay

**ntfy.sh still works** if you run the monitor on your own machine, where the IP
is yours alone. Set `NTFY_TOPIC` to something long and unguessable. On the
public server the topic name *is* the authentication, and anyone who knows it
can both read your alerts and publish fakes to them.

**Telegram** is a good free alternative from a cloud host: bot-token
authentication, no IP quota, reliable delivery, and silent delivery as a
per-message flag. It is not implemented here, but the `Notifier` interface is
three lines and adding one is straightforward.

**Or accept no notifications at all.** The log still records every episode. You
would simply not be told at the time, which is less bad than it sounds given
that the record is the more valuable half of this project.

---

## Priorities

Normalised across backends:

| Level | Used for | ntfy | Pushover |
|---|---|---|---|
| 0 normal | recoveries | 3 | 0 |
| 1 high | all alerts by default | 4 | 1 |
| 2 emergency | stuck cooling, only if you opt in | 5 | 2 (repeats until acknowledged) |

By default **nothing overrides Do Not Disturb.** You get the warning and your
phone decides whether to make noise. A **"wake me at night"** checkbox in the
dashboard raises the stuck-cooling alert to emergency if you want to be woken.

---

## Android: two settings that decide whether 3 AM works

Both are easy to miss and both silently break exactly the case you care about.

- **Battery → Unrestricted.** Settings → Apps → *(your notification app)* →
  Battery. Doze otherwise holds background pushes, sometimes for hours.
- **Override Do Not Disturb**, if you have opted into emergency alerts.
  Long-press a notification from the app, then open channel settings.
