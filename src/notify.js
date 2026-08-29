// Pluggable notification delivery.
//
// Priority is normalised across backends:
//
//     0  normal    routine, recoveries
//     1  high      Alert B and C
//     2  emergency Alert A - the one that has to wake you at 2am
//
// ntfy maps 2 to priority 5 (max). On Android, max-priority messages land on
// their own notification channel, which can be set to override Do Not Disturb.
// That is the whole reason for the mapping.

const NTFY_PRIORITY = { 0: 3, 1: 4, 2: 5 };
const PUSHOVER_PRIORITY = { 0: 0, 1: 1, 2: 2 };

export class NotifierError extends Error {}

/** HTTP headers must be latin-1 clean. Degrade rather than throw. */
const asciiOnly = (text) => String(text).replace(/[^\x20-\x7E]/g, "?");

class NtfyNotifier {
  constructor(topic, server, token) {
    if (!topic) throw new NotifierError("No ntfy topic configured.");
    this.name = "ntfy";
    this.topic = topic;
    this.server = (server || "https://ntfy.sh").replace(/\/+$/, "");
    // Without a token, ntfy.sh meters anonymous publishing per source IP -
    // 250 messages a day. A Worker publishes from Cloudflare's shared egress
    // addresses, so that quota is shared with every other Cloudflare customer
    // hitting ntfy from the same IP, and it runs out on strangers' traffic.
    // An access token moves the quota onto the account. Observed as HTTP 429
    // on 2026-08-27 with twelve messages sent all day.
    this.token = token || "";
  }

  async send(title, body, priority = 0) {
    const headers = {
      Title: asciiOnly(title),
      Priority: String(NTFY_PRIORITY[priority] ?? 3),
      Tags: priority >= 2 ? "rotating_light" : "warning",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await fetch(`${this.server}/${this.topic}`, {
        method: "POST",
        headers,
        body,
      });
    } catch (err) {
      throw new NotifierError(`ntfy ${err}`);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      if (res.status === 429 && !this.token) {
        throw new NotifierError(
          "ntfy 429: anonymous per-IP daily quota exhausted. Set NTFY_TOKEN " +
            "so the quota follows the account instead of Cloudflare's shared " +
            `egress IP. (${detail})`
        );
      }
      throw new NotifierError(`ntfy HTTP ${res.status}: ${detail}`);
    }
  }
}

class PushoverNotifier {
  constructor(userKey, token) {
    if (!userKey || !token) {
      throw new NotifierError("Pushover needs both a user key and an app token.");
    }
    this.name = "pushover";
    this.userKey = userKey;
    this.token = token;
  }

  async send(title, body, priority = 0) {
    const mapped = PUSHOVER_PRIORITY[priority] ?? 0;
    const fields = {
      token: this.token,
      user: this.userKey,
      title,
      message: body,
      priority: String(mapped),
    };
    if (mapped === 2) {
      // Emergency: re-alert every 60s for up to 30 minutes, or until
      // acknowledged on the phone.
      fields.retry = "60";
      fields.expire = "1800";
    }

    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    if (!res.ok) {
      throw new NotifierError(`pushover HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

/** Stands in when nothing is configured, so a missing topic degrades to a
 *  logged failure rather than an exception inside the cron handler. */
class NullNotifier {
  /** `missing` names the secret that is actually absent, so the error points at
   *  the real problem rather than always blaming NTFY_TOPIC. */
  constructor(missing = "NTFY_TOPIC") {
    this.name = "none";
    this.missing = missing;
  }
  async send() {
    throw new NotifierError(
      `No notifier configured. Set ${this.missing} as a Worker secret. ` +
        "(A secret set moments ago may take a few seconds to reach the Worker.)"
    );
  }
}

export function buildNotifier(settings, env) {
  const choice = (settings.notifier || "ntfy").toLowerCase();
  try {
    if (choice === "pushover") {
      return new PushoverNotifier(env.PUSHOVER_USER_KEY, env.PUSHOVER_TOKEN);
    }
    return new NtfyNotifier(env.NTFY_TOPIC, settings.ntfy_server, env.NTFY_TOKEN);
  } catch {
    return new NullNotifier(
      choice === "pushover" ? "PUSHOVER_USER_KEY and PUSHOVER_TOKEN" : "NTFY_TOPIC"
    );
  }
}
