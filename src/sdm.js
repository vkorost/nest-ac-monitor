// Google Smart Device Management access. Read-only, by design.
//
// There is no command path in this module and there should not be one. The app
// never writes to the thermostat, so no bug here can leave the apartment
// uncooled.

const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
const SDM_BASE = "https://smartdevicemanagement.googleapis.com/v1";
const AUTH_BASE = "https://nestservices.google.com/partnerconnections";
const SCOPE = "https://www.googleapis.com/auth/sdm.service";
const REDIRECT_URI = "https://www.google.com";

/** The refresh token is dead. This is Alert D, not a log line. */
export class AuthError extends Error {}
/** Transient: network, timeout, 5xx. */
export class ApiError extends Error {}

export async function accessToken(env) {
  const body = new URLSearchParams({
    client_id: env.NEST_CLIENT_ID,
    client_secret: env.NEST_CLIENT_SECRET,
    refresh_token: env.NEST_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new ApiError(`token fetch failed: ${err}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // 400/401 on a refresh grant means the token is gone for good; retrying
    // will not help and the user must re-authorise.
    if (res.status === 400 || res.status === 401) throw new AuthError(text.slice(0, 300));
    throw new ApiError(`token HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text).access_token;
}

export async function readDevice(env, token) {
  let res;
  try {
    res = await fetch(`${SDM_BASE}/${env.NEST_DEVICE_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new ApiError(`device fetch failed: ${err}`);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403) throw new AuthError(`HTTP 403: ${text.slice(0, 300)}`);
    throw new ApiError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

export async function listDevices(env, token) {
  const res = await fetch(`${SDM_BASE}/enterprises/${env.NEST_PROJECT_ID}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).devices || [];
}

const trait = (device, name, field) =>
  device?.traits?.[`sdm.devices.traits.${name}`]?.[field] ?? null;

/**
 * Flatten the traits we consume into a sample row.
 *
 * Celsius is stored as returned. Converting on the way in would compound
 * rounding error across months of samples.
 */
export function toSample(device) {
  return {
    ambient_c: trait(device, "Temperature", "ambientTemperatureCelsius"),
    humidity_pct: trait(device, "Humidity", "ambientHumidityPercent"),
    hvac_status: trait(device, "ThermostatHvac", "status"),
    mode: trait(device, "ThermostatMode", "mode"),
    cool_setpoint_c: trait(device, "ThermostatTemperatureSetpoint", "coolCelsius"),
    connectivity: trait(device, "Connectivity", "status"),
  };
}

// ------------------------------------------------------ re-authorisation

export function buildAuthUrl(projectId, clientId) {
  const query = new URLSearchParams({
    redirect_uri: REDIRECT_URI,
    access_type: "offline",
    prompt: "consent",
    client_id: clientId,
    response_type: "code",
    scope: SCOPE,
  });
  return `${AUTH_BASE}/${projectId}/auth?${query}`;
}

export function extractCode(pasted) {
  const text = String(pasted || "").trim().replace(/^["']|["']$/g, "");
  if (!text.includes("code=")) return text;
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const code = new URLSearchParams(query).get("code");
  if (!code) throw new AuthError("No 'code' parameter found in that URL.");
  return code;
}

export async function exchangeCode(clientId, clientSecret, code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("invalid_grant")) {
      throw new AuthError(
        "Authorization code rejected. It is single-use and expires within minutes - get a fresh one."
      );
    }
    throw new AuthError(text.slice(0, 300));
  }
  return JSON.parse(text);
}
