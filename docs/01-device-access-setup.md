# Setup: Google Device Access + OAuth for the Nest AC Monitor

One-time setup. Budget about 30 minutes. Costs **$5 USD, non-refundable**.

You will end up with five values that the monitor needs:

| Value | Looks like | Where it comes from |
|---|---|---|
| `project_id` (Device Access) | `32c4c2bc-fe0d-461b-b51c-f3885afff2f0` | Step 4 |
| `client_id` | `1234-abc.apps.googleusercontent.com` | Step 3 |
| `client_secret` | `GOCSPX-...` | Step 3 |
| `refresh_token` | `1//0g...` | Step 6 |
| `device_id` (Nest thermostat) | `enterprises/<project_id>/devices/AVPH...` | Step 7 |

---

## Step 0: Preconditions (check these before spending the $5)

- [ ] The Nest Learning Thermostat is **migrated to a Google Account**, not a legacy
      Nest account. If you still sign in at `home.nest.com`, migrate first via the
      Google Home app. The SDM API cannot see legacy-Nest-account devices.
- [ ] You are using a **personal `@gmail.com` account**. Google Workspace accounts
      cannot open the Device Access Console or complete the OAuth consent flow.
      This is a hard block, not a warning.
- [ ] You are signed into **only that one Google account** in the browser you will
      use. Multi-login is the single most common cause of a botched setup.

> **The $5 fee is tied permanently to the Google Account you use.** Once a Google
> Account is associated with a Device Access Project it *cannot be changed*. Get
> the account right before you pay.

---

## Step 1: Create the Google Cloud project

1. Go to https://console.cloud.google.com/
2. Project dropdown (top bar) -> **New Project**.
3. Name it `nest-ac-monitor`. No organization. **Create**.
4. Make sure the project selector now shows `nest-ac-monitor` before continuing.

## Step 2: Enable the Smart Device Management API

1. Go to https://console.cloud.google.com/apis/library/smartdevicemanagement.googleapis.com
2. Confirm `nest-ac-monitor` is the selected project.
3. Click **Enable**.

## Step 3: Create the OAuth client

First the consent screen (recent consoles call this **Google Auth Platform**;
older ones call it **OAuth consent screen**):

1. Go to https://console.cloud.google.com/auth/overview
2. **Get started** / **Configure**:
   - App name: `Nest AC Monitor`
   - User support email: your gmail address
   - Audience: **External**
   - Developer contact: your gmail address
3. Save.

### 3a. Publish the app: do not skip this

1. Go to **Audience** (left nav) -> **Publishing status**.
2. Click **Publish app** and confirm. Status must read **In production**.

> **Why this matters more than anything else on this page.** While the app sits in
> **Testing**, Google expires every refresh token it issues after exactly **7 days**.
> The monitor then dies silently every week, which is the exact failure mode
> Alert D exists to catch, and you do not want to be acknowledging it every Tuesday.
> Publishing to **In production** removes the 7-day cap. You are the only user and
> you are reading only your own device data, so Google verification is not required.
> You will click through an "unverified app" interstitial once during Step 5.

### 3b. Create the client credentials

1. Go to https://console.cloud.google.com/apis/credentials
2. **Create Credentials** -> **OAuth client ID**.
3. Application type: **Web application**.
4. Name: `nest-ac-monitor-client`.
5. Under **Authorized redirect URIs**, click **Add URI** and enter exactly:

   ```
   https://www.google.com
   ```

   No trailing slash. This is Google's documented redirect for Device Access.
   The auth code comes back as a query parameter on a google.com URL that you
   copy out of the address bar by hand.
6. **Create**. Copy the **Client ID** and **Client Secret** now, or download the JSON.

## Step 4: Register for Device Access and create the Device Access project

1. Go to https://console.nest.google.com/device-access
2. Accept the **Google API Terms of Service** and the **Device Access Sandbox
   Terms of Service**.
3. Pay the **$5 one-time fee**.
4. **Create project**:
   - Project name: `nest-ac-monitor`
   - OAuth client ID: paste the Client ID from Step 3b
   - Events: **Disable**. v1 polls; it does not use Pub/Sub. (Changeable later.)
5. Copy the **Project ID** (a UUID). This is *not* the GCP project name. Every SDM
   API call needs it.

## Step 5: Authorize your account (the consent flow)

Build this URL, substituting your two values:

```
https://nestservices.google.com/partnerconnections/PROJECT_ID/auth?redirect_uri=https://www.google.com&access_type=offline&prompt=consent&client_id=CLIENT_ID&response_type=code&scope=https://www.googleapis.com/auth/sdm.service
```

1. Open it in the browser signed into the correct Google account.
2. Grant permission to your **thermostat** (toggle it on), then **Next**.
3. Sign in / choose the account. On the "Google hasn't verified this app" screen,
   click **Advanced** -> **Go to Nest AC Monitor (unsafe)**. That is expected for
   your own unverified app.
4. Click **Allow** on the scope grant.
5. The browser lands on `https://www.google.com/?code=XXXX&scope=...`. It may look
   like a blank or ordinary Google page, but **the payload is in the address bar**.
   Copy the entire URL immediately.

> The `code` is single-use and expires in a few minutes. If you fumble it, re-open
> the auth URL and get a fresh one.

## Step 6: Exchange the code for a refresh token

Run the helper (from the repo root):

```powershell
python tools/oauth_setup.py
```

It prompts for Project ID, Client ID, Client Secret, and the pasted redirect URL;
exchanges the code; verifies the token with a live `devices.list`; and writes the
result to the secrets file with restrictive ACLs.

<details>
<summary>Manual equivalent, if you prefer to see the wire calls</summary>

```powershell
curl.exe -L -X POST "https://www.googleapis.com/oauth2/v4/token?client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=AUTH_CODE&grant_type=authorization_code&redirect_uri=https://www.google.com"
```

Returns `access_token` (1 hour), `refresh_token` (what you keep), `expires_in`.
</details>

## Step 7: Confirm and capture the device ID

**Authorization is not considered complete until you make a `devices.list` call.**
The helper does this for you; the manual form is:

```powershell
curl.exe -X GET "https://smartdevicemanagement.googleapis.com/v1/enterprises/PROJECT_ID/devices" -H "Authorization: Bearer ACCESS_TOKEN"
```

You want a `sdm.devices.types.THERMOSTAT` entry. Copy its `name` field, since that
full path is the `device_id`. The monitor is single-device, so this gets pinned in
config after discovery.

Sanity-check the traits in that response: `Temperature.ambientTemperatureCelsius`,
`Humidity.ambientHumidityPercent`, `ThermostatHvac.status`, `Connectivity.status`.
If any are missing, the thermostat is probably still on a legacy Nest account.

---

## Operational notes worth knowing up front

- **Access token**: 1 hour. The monitor refreshes it automatically.
- **Refresh token**: no expiry once the app is **In production**, though Google
  revokes it if unused for **6 months**. A 5-minute poll makes that a non-issue.
- **What kills a refresh token**: changing your Google password, revoking access at
  https://myaccount.google.com/permissions, un-publishing the app back to Testing,
  or removing the connection at https://nestservices.google.com/partnerconnections.
  All of these surface as **Alert D**.
- **Rate limits**: the 5 QPM / 100 QPH thermostat limit applies to `executeCommand`,
  not `get`/`list`. A 5-minute poll is 12 calls/hour, nowhere near any ceiling.
- **Do not commit the secrets file.** Client secret and refresh token together are
  full access to the thermostat.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Device Access Console will not load | Workspace account, or wrong account in a multi-login browser |
| Consent screen lists no devices | Thermostat still on a legacy Nest account. Migrate it in the Google Home app |
| `redirect_uri_mismatch` | Step 3b URI is not exactly `https://www.google.com` (trailing slash, or `http://`) |
| `invalid_grant` on exchange | Code already used or expired. Get a fresh one from Step 5 |
| No `refresh_token` in the response | `access_type=offline` or `prompt=consent` missing from the Step 5 URL |
| Auth dies after ~7 days | App fell back to **Testing** publishing status. Re-check Step 3a. |
| `devices` list is empty | The Step 7 `devices.list` call is what finalizes authorization. Run it |
