"""One-time OAuth setup for the Nest AC Monitor.

Run this once, on any machine, before deploying the Worker. It produces the
refresh token and device id you will store as Cloudflare Worker secrets.
Standard library only - nothing to install.

Walks through Steps 5-7 of docs/SETUP_DEVICE_ACCESS.md:

  1. Builds the Google partner-connections authorization URL.
  2. Exchanges the authorization code for a refresh token.
  3. Calls devices.list, which is what actually finalizes authorization.
  4. Finds the thermostat and shows its current readings.
  5. Writes everything to a secrets file with restrictive Windows ACLs.

    python tools/oauth_setup.py            # full first-time setup
    python tools/oauth_setup.py --verify   # re-check an existing setup
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AUTH_BASE = "https://nestservices.google.com/partnerconnections"
TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token"
SDM_BASE = "https://smartdevicemanagement.googleapis.com/v1"
SCOPE = "https://www.googleapis.com/auth/sdm.service"
REDIRECT_URI = "https://www.google.com"

THERMOSTAT_TYPE = "sdm.devices.types.THERMOSTAT"

SECRETS_PATH = (
    Path(os.environ.get("LOCALAPPDATA", Path.home())) / "NestACMonitor" / "secrets.json"
)


# --------------------------------------------------------------------------- io


def say(msg: str = "") -> None:
    print(msg, flush=True)


def rule(title: str) -> None:
    say()
    say(f"--- {title} " + "-" * max(0, 68 - len(title)))
    say()


def ask(prompt: str, current: str | None = None) -> str:
    """Prompt for a value, offering the existing one as the default."""
    if current:
        shown = current if len(current) < 48 else current[:45] + "..."
        raw = input(f"{prompt}\n  [{shown}]: ").strip()
        return raw or current
    while True:
        raw = input(f"{prompt}\n  : ").strip()
        if raw:
            return raw
        say("  Required.")


def mask(value: str, keep: int = 6) -> str:
    if not value:
        return "(empty)"
    return value[:keep] + "..." + f"({len(value)} chars)"


def die(msg: str, *hints: str) -> "NoReturn":  # type: ignore[valid-type]
    say()
    say(f"FAILED: {msg}")
    for hint in hints:
        say(f"  - {hint}")
    sys.exit(1)


# ------------------------------------------------------------------------- http


def post_form(url: str, fields: dict[str, str]) -> dict:
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from None


def get_json(url: str, access_token: str) -> dict:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {access_token}"}, method="GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from None


# ------------------------------------------------------------------------ oauth


def build_auth_url(project_id: str, client_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "redirect_uri": REDIRECT_URI,
            "access_type": "offline",
            "prompt": "consent",
            "client_id": client_id,
            "response_type": "code",
            "scope": SCOPE,
        }
    )
    return f"{AUTH_BASE}/{project_id}/auth?{query}"


def extract_code(pasted: str) -> str:
    """Accept either the whole redirect URL or a bare authorization code."""
    pasted = pasted.strip().strip('"').strip("'")
    if "code=" not in pasted:
        return pasted
    query = urllib.parse.urlparse(pasted).query or pasted.split("?", 1)[-1]
    values = urllib.parse.parse_qs(query).get("code")
    if not values:
        die("No 'code' parameter found in that URL.")
    return values[0]


def exchange_code(client_id: str, client_secret: str, code: str) -> dict:
    try:
        return post_form(
            TOKEN_URL,
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": REDIRECT_URI,
            },
        )
    except RuntimeError as exc:
        text = str(exc)
        if "invalid_grant" in text:
            die(
                "Google rejected the authorization code.",
                "The code is single-use and expires within minutes.",
                "Re-open the authorization URL and paste a fresh redirect URL.",
                text,
            )
        if "redirect_uri_mismatch" in text:
            die(
                "Redirect URI mismatch.",
                "The OAuth client's Authorized redirect URI must be exactly:",
                f"    {REDIRECT_URI}",
                "No trailing slash, and it must be under 'Authorized redirect URIs',",
                "not 'Authorized JavaScript origins'.",
                text,
            )
        die("Token exchange failed.", text)


def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    try:
        data = post_form(
            TOKEN_URL,
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
    except RuntimeError as exc:
        die(
            "Refresh token is no longer valid.",
            "Re-run without --verify to authorize again.",
            "Common causes: Google password changed, access revoked at",
            "myaccount.google.com/permissions, or the OAuth app fell back to",
            "'Testing' publishing status (which expires tokens after 7 days).",
            str(exc),
        )
    return data["access_token"]


# --------------------------------------------------------------------- devices


def list_devices(project_id: str, access_token: str) -> list[dict]:
    url = f"{SDM_BASE}/enterprises/{project_id}/devices"
    try:
        data = get_json(url, access_token)
    except RuntimeError as exc:
        die(
            "devices.list failed.",
            "Check the Device Access Project ID (the UUID, not the GCP project id).",
            str(exc),
        )
    return data.get("devices", [])


def trait(device: dict, name: str, field: str, default=None):
    return device.get("traits", {}).get(f"sdm.devices.traits.{name}", {}).get(field, default)


def c_to_f(celsius) -> str:
    if celsius is None:
        return "n/a"
    return f"{celsius * 9 / 5 + 32:.1f}F"


def describe(device: dict) -> None:
    say(f"  Name        {device.get('name')}")
    label = device.get("parentRelations", [{}])[0].get("displayName")
    if label:
        say(f"  Room        {label}")
    say(f"  Ambient     {c_to_f(trait(device, 'Temperature', 'ambientTemperatureCelsius'))}")
    say(f"  Humidity    {trait(device, 'Humidity', 'ambientHumidityPercent', 'n/a')}%")
    say(f"  HVAC        {trait(device, 'ThermostatHvac', 'status', 'n/a')}")
    say(f"  Mode        {trait(device, 'ThermostatMode', 'mode', 'n/a')}")
    setpoint = trait(device, "ThermostatTemperatureSetpoint", "coolCelsius")
    say(f"  Cool set    {c_to_f(setpoint)}")
    say(f"  Connected   {trait(device, 'Connectivity', 'status', 'n/a')}")


def pick_thermostat(devices: list[dict]) -> dict:
    thermostats = [d for d in devices if d.get("type") == THERMOSTAT_TYPE]

    if not thermostats:
        die(
            "No thermostat found on this account.",
            f"devices.list returned {len(devices)} device(s), none of type THERMOSTAT.",
            "Usually means the thermostat is still on a legacy Nest account,",
            "or it was not toggled on during the consent screen.",
            "Re-run and make sure the thermostat is enabled before clicking Next.",
        )

    if len(thermostats) == 1:
        return thermostats[0]

    say(f"Found {len(thermostats)} thermostats:")
    for i, device in enumerate(thermostats, 1):
        room = device.get("parentRelations", [{}])[0].get("displayName", "?")
        say(f"  {i}. {room}  ({device.get('name')})")
    while True:
        choice = input("Which one should the monitor watch? ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(thermostats):
            return thermostats[int(choice) - 1]


# --------------------------------------------------------------------- secrets


def load_secrets() -> dict:
    if not SECRETS_PATH.exists():
        return {}
    try:
        return json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def lock_down(path: Path) -> bool:
    """Strip inherited ACLs so only the current user can read the file."""
    user = os.environ.get("USERNAME")
    if os.name != "nt" or not user:
        try:
            path.chmod(0o600)
            return True
        except OSError:
            return False
    result = subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(F)"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def save_secrets(secrets: dict) -> None:
    SECRETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SECRETS_PATH.write_text(json.dumps(secrets, indent=2), encoding="utf-8")
    if lock_down(SECRETS_PATH):
        say(f"Wrote {SECRETS_PATH}")
        say("  ACLs restricted to your user account only.")
    else:
        say(f"Wrote {SECRETS_PATH}")
        say("  WARNING: could not restrict file permissions. Check them manually.")


# ------------------------------------------------------------------------- main


def verify() -> None:
    rule("Verifying existing setup")
    secrets = load_secrets()
    missing = [
        k for k in ("project_id", "client_id", "client_secret", "refresh_token")
        if not secrets.get(k)
    ]
    if missing:
        die(
            f"Secrets file is incomplete: missing {', '.join(missing)}",
            f"Expected at {SECRETS_PATH}",
            "Run without --verify to do first-time setup.",
        )

    say("Refreshing access token...")
    token = refresh_access_token(
        secrets["client_id"], secrets["client_secret"], secrets["refresh_token"]
    )
    say("  OK - refresh token is still valid.")

    say("Calling devices.list...")
    devices = list_devices(secrets["project_id"], token)
    say(f"  OK - {len(devices)} device(s) visible.")

    device = pick_thermostat(devices)
    rule("Current readings")
    describe(device)

    if device.get("name") != secrets.get("device_id"):
        secrets["device_id"] = device.get("name")
        save_secrets(secrets)
        say("  Device id updated.")

    rule("Setup is healthy")


def setup() -> None:
    existing = load_secrets()

    rule("Step 1 of 3 - credentials")
    say("From the Device Access Console and Google Cloud Credentials page.")
    say()
    project_id = ask(
        "Device Access Project ID (UUID, from console.nest.google.com)",
        existing.get("project_id"),
    )
    client_id = ask("OAuth Client ID", existing.get("client_id"))
    client_secret = ask("OAuth Client Secret", existing.get("client_secret"))

    rule("Step 2 of 3 - authorize")
    say("Open this URL in a browser signed in as the account that owns the")
    say("thermostat. Toggle the thermostat ON, allow access, and click through")
    say("the 'Google hasn't verified this app' warning if it appears.")
    say()
    say(build_auth_url(project_id, client_id))
    say()
    say("You will land on a google.com page that may look blank or ordinary.")
    say("The authorization code is in the ADDRESS BAR. Copy the whole URL.")
    say()
    pasted = input("Paste the full redirect URL here:\n  : ")
    code = extract_code(pasted)
    say(f"  Got code {mask(code, 8)}")

    say()
    say("Exchanging for tokens...")
    tokens = exchange_code(client_id, client_secret, code)
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        die(
            "Google returned no refresh token.",
            "The authorization URL must include access_type=offline and prompt=consent.",
            "Re-run this script and use the URL exactly as printed.",
        )
    say(f"  access_token  {mask(tokens['access_token'])}")
    say(f"  refresh_token {mask(refresh_token)}")

    rule("Step 3 of 3 - find the thermostat")
    say("Calling devices.list (this is what finalizes authorization)...")
    devices = list_devices(project_id, tokens["access_token"])
    say(f"  {len(devices)} device(s) visible to this project.")
    say()
    device = pick_thermostat(devices)
    describe(device)

    missing_traits = [
        name
        for name, field in (
            ("Temperature", "ambientTemperatureCelsius"),
            ("Humidity", "ambientHumidityPercent"),
            ("ThermostatHvac", "status"),
            ("Connectivity", "status"),
        )
        if trait(device, name, field) is None
    ]
    if missing_traits:
        say()
        say("  WARNING: these traits the monitor needs are missing:")
        for name in missing_traits:
            say(f"    - {name}")

    rule("Saving")
    save_secrets(
        {
            "project_id": project_id,
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "device_id": device.get("name"),
        }
    )

    rule("Done")
    say("Verify any time with:")
    say("    python scripts/oauth_setup.py --verify")


def main() -> None:
    try:
        if "--verify" in sys.argv:
            verify()
        else:
            setup()
    except KeyboardInterrupt:
        say()
        say("Cancelled. Nothing was written.")
        sys.exit(130)


if __name__ == "__main__":
    main()
