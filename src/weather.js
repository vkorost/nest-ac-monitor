// Outdoor conditions from Open-Meteo. No account, no API key.
//
// Wet bulb is why this module exists. A cooling tower cannot reject heat below
// the ambient wet bulb, so tower capacity is governed by it - not by the dry
// bulb temperature on a weather app. Towers are commonly designed around 78F
// wet bulb. Above that, capacity falls, condenser water returns warmer,
// entering water temperature at the heat pump climbs, and discharge pressure
// rises toward the 395 psig cutout with less margin than it had in June.
//
// Recorded next to each sample, it lets the log answer a question the
// building's daily spot-readings cannot: do the lockouts cluster at high
// outdoor wet bulb? If they do, the constraint is the tower, not the apartment.

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const FIELDS = "temperature_2m,relative_humidity_2m,dew_point_2m,wet_bulb_temperature_2m";

/**
 * Never throws. A weather miss must not cost us a thermostat sample - the
 * thermostat reading is the primary signal and this is context.
 */
export async function fetchOutdoor(lat, lon) {
  const query = new URLSearchParams({ latitude: lat, longitude: lon, current: FIELDS });
  try {
    const res = await fetch(`${OPEN_METEO}?${query}`);
    if (!res.ok) return {};
    const current = (await res.json()).current || {};
    return {
      outdoor_c: current.temperature_2m ?? null,
      outdoor_rh_pct: current.relative_humidity_2m ?? null,
      outdoor_dewpoint_c: current.dew_point_2m ?? null,
      outdoor_wetbulb_c: current.wet_bulb_temperature_2m ?? null,
    };
  } catch {
    return {};
  }
}
