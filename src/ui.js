// The dashboard, inlined.
//
// Everything is in this one string: no asset binding, no CDN, no build step.
// That keeps the auth check in front of every byte the Worker serves, and it
// means the page renders even when the only thing reachable is Cloudflare.
//
// Layout is mobile-first and single-column; the multi-column grid only appears
// once there is room for it. The chart sits directly under the live readings
// because it is the diagnostic view - a wide COOLING band where the room line
// does not fall is a compressor lockout, visible at a glance.

// Snowflake on a rounded square. Inline so there is no second request, and
// legible at 16px in a browser tab.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
      "<rect width='32' height='32' rx='7' fill='#1a5fb4'/>" +
      "<g stroke='#fff' stroke-width='2.8' stroke-linecap='round'>" +
      "<path d='M16 5.5v21M6.9 10.75l18.2 10.5M6.9 21.25l18.2-10.5'/>" +
      "</g></svg>"
  );

export const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#1a5fb4">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AC Monitor">
<title>Nest AC Monitor</title>
<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${FAVICON}">
<style>
:root {
  --bg:#f6f7f9; --panel:#fff; --ink:#1b1e23; --muted:#6b7280; --rule:#e3e6ea;
  --accent:#1a5fb4; --ok:#197b3c; --warn:#b45309; --bad:#b3261e;
  --band:rgba(26,95,180,.13); --area:rgba(26,95,180,.10);
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#15171b; --panel:#1d2026; --ink:#e6e8ea; --muted:#9aa1ab; --rule:#2c3039;
  --accent:#7cb0f0; --ok:#5dd18a; --warn:#e0a33c; --bad:#f2776a;
  --band:rgba(124,176,240,.17); --area:rgba(124,176,240,.12);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}

header{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
  flex-wrap:wrap;padding:.85rem 1rem;border-bottom:1px solid var(--rule);
  background:var(--panel);position:sticky;top:0;z-index:10}
h1{font-size:1rem;margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:.75rem}

/* master switch - large and unambiguous, and thumb-sized on a phone */
.master{display:inline-flex;align-items:center;gap:.55rem;padding:.65rem 1.1rem;
  border:2px solid var(--rule);border-radius:999px;background:var(--panel);
  color:var(--ink);font-size:.9rem;font-weight:650;cursor:pointer;
  min-height:44px;-webkit-tap-highlight-color:transparent}
.master .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--bad);flex:none}
.master.on{border-color:var(--ok)}
.master.on .dot{background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 22%,transparent)}

main{display:grid;gap:.85rem;grid-template-columns:1fr;align-items:start;
  padding:.85rem .85rem 3rem;max-width:1400px;margin:0 auto}
@media (min-width:760px){
  main{gap:1rem;padding:1rem 1.25rem 3rem;grid-template-columns:repeat(2,1fr)}
  body{font-size:14px}
}
@media (min-width:1120px){ main{grid-template-columns:repeat(3,1fr)} }
.card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;
  padding:.9rem 1rem 1.1rem}
.card.wide{grid-column:1/-1}

/* collapsible panels. <details> gives keyboard and screen-reader behaviour
   for free; open/closed state is remembered per panel in localStorage. */
details.card{padding:0}
details.card>summary{list-style:none;cursor:pointer;display:flex;align-items:center;
  justify-content:space-between;gap:.5rem;min-height:46px;padding:.7rem 1rem;
  font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;font-weight:700;
  color:var(--muted);-webkit-tap-highlight-color:transparent}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::after{content:"";flex:none;width:.5rem;height:.5rem;
  border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);
  transform:rotate(45deg) translate(-2px,-2px);transition:transform .15s}
details.card[open]>summary::after{transform:rotate(-135deg) translate(-2px,-2px)}
details.card>summary:hover{color:var(--ink)}
details.card .body{padding:0 1rem 1.1rem}
details.card .body h2:first-child{margin-top:0}

h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
  margin:1.25rem 0 .55rem;font-weight:700}
h2:first-child{margin-top:0}
.note{color:var(--muted);font-size:.78rem;margin:.3rem 0 .6rem}
.undelivered{display:block;color:var(--bad);font-size:.7rem;letter-spacing:.02em}

/* live readings ---------------------------------------------------------- */
.readings{display:grid;gap:.75rem 1.1rem;
  grid-template-columns:repeat(auto-fit,minmax(88px,1fr));align-items:end}
.reading{display:flex;flex-direction:column;gap:.1rem;min-width:0}
.reading .label{font-size:.63rem;text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);white-space:nowrap}
.reading .value{font-family:var(--mono);font-size:1.15rem;font-variant-numeric:tabular-nums}
.reading.big{grid-column:span 2}
.reading.big .value{font-size:2.4rem;line-height:1.05;letter-spacing:-.02em}
@media (min-width:760px){.reading.big{grid-column:span 1}}

.resume{margin-top:.75rem;font:inherit;font-size:.78rem;cursor:pointer;
  background:none;border:1px solid var(--rule);border-radius:.4rem;
  padding:.3rem .6rem;color:var(--warn);-webkit-tap-highlight-color:transparent}
.verdict{margin-top:.9rem;font-size:.88rem}
.verdict.alarm{color:var(--bad);font-weight:650}
.verdict.watch{color:var(--warn)}
.verdict.fine{color:var(--ok)}

/* chart ------------------------------------------------------------------ */
.charthead{display:flex;align-items:center;justify-content:space-between;
  gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem}
.ranges{display:flex;gap:.3rem;flex-wrap:wrap}
.ranges button{font:inherit;font-size:.75rem;padding:.4rem .6rem;min-height:34px;
  border:1px solid var(--rule);border-radius:999px;background:var(--bg);
  color:var(--muted);cursor:pointer;-webkit-tap-highlight-color:transparent}
.ranges button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);
  color:#fff;font-weight:650}
.chartwrap{position:relative;touch-action:pan-y}
#chart svg{width:100%;height:clamp(190px,42vw,300px);display:block}
#chart .cross{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.tipdot{position:absolute;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;
  background:var(--accent);box-shadow:0 0 0 2px var(--panel);pointer-events:none}
.tip{position:absolute;top:6px;pointer-events:none;z-index:5;
  background:var(--panel);border:1px solid var(--rule);border-radius:9px;
  padding:.5rem .6rem;font-family:var(--mono);font-size:.72rem;line-height:1.5;
  box-shadow:0 6px 20px rgba(0,0,0,.18);min-width:9.5rem;max-width:min(15rem,70vw)}
.tip .when{color:var(--ink);font-weight:650;margin-bottom:.25rem}
.tip .r{display:flex;justify-content:space-between;gap:.75rem;white-space:nowrap}
.tip .r span:first-child{color:var(--muted)}
#chart .grid{stroke:var(--rule);stroke-width:1}
#chart text{fill:var(--muted);font-size:11px;font-family:var(--mono)}
@media (min-width:760px){#chart text{font-size:10px}}
.legend{display:flex;gap:.75rem;flex-wrap:wrap;color:var(--muted);
  font-size:.72rem;margin-top:.5rem}
.legend span{display:inline-flex;align-items:center;gap:.3rem}
.sw{display:inline-block;width:.85rem;height:.5rem;border-radius:2px;flex:none}
.sw.band{background:var(--band);border:1px solid var(--rule)}
.sw.amb{background:var(--accent);height:.18rem}
.sw.set{background:var(--muted);height:.18rem}
.sw.wb{background:var(--warn);height:.18rem}

/* status ----------------------------------------------------------------- */
ul.status{list-style:none;margin:0;padding:0}
ul.status li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;
  border-bottom:1px dashed var(--rule)}
ul.status .k{color:var(--muted)}
ul.status .v{font-family:var(--mono);font-size:.82rem;text-align:right}
.v.ok{color:var(--ok)}.v.bad{color:var(--bad)}.v.warn{color:var(--warn)}

/* controls --------------------------------------------------------------- */
.toggles{display:flex;flex-direction:column;gap:.1rem}
.toggles label{display:flex;align-items:center;gap:.6rem;min-height:40px}
.toggles b{font-family:var(--mono)}
.toggles i{font-style:normal;font-size:.72rem;color:var(--muted);margin-left:auto}
.toggles i.active{color:var(--bad);font-weight:650}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem}
.fields label{display:flex;flex-direction:column;gap:.25rem;font-size:.75rem;color:var(--muted)}
.fields label.check{flex-direction:row;align-items:center;gap:.5rem;min-height:40px}
.fields.pair{grid-template-columns:1fr 1fr}
label.check{display:flex;align-items:center;gap:.5rem;min-height:40px;
  font-size:.75rem;color:var(--muted)}
input,select,textarea{font:inherit;font-family:var(--mono);font-size:16px;
  padding:.5rem;border:1px solid var(--rule);border-radius:8px;
  background:var(--bg);color:var(--ink);width:100%}
@media (min-width:760px){input,select,textarea{font-size:.85rem;padding:.4rem .5rem}}
input[type=checkbox]{width:1.15rem;height:1.15rem;accent-color:var(--accent);flex:none}
textarea{resize:vertical;margin-bottom:.5rem;word-break:break-all}
.row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;margin-top:.8rem}
button,.row a{font:inherit;font-size:.82rem;padding:.55rem .9rem;border-radius:8px;
  min-height:40px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);
  cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.result{font-size:.78rem;font-family:var(--mono);word-break:break-word}
.result.ok{color:var(--ok)}.result.bad{color:var(--bad)}
.hidden{display:none}

/* alert log -------------------------------------------------------------- */
table{width:100%;border-collapse:collapse;font-size:.78rem}
td{padding:.4rem .3rem;border-bottom:1px dashed var(--rule);font-family:var(--mono)}
td.t{color:var(--muted);white-space:nowrap;width:1%}
td.what{font-family:inherit;color:var(--ink)}
td.fire{color:var(--bad);font-weight:650}
td.recover{color:var(--ok)}
tr.noterow td{border-bottom:1px dashed var(--rule);color:var(--warn);
  font-size:.72rem;font-family:inherit;padding-top:0;font-style:italic}

/* prose panels ----------------------------------------------------------- */
.prose{font-size:.82rem;line-height:1.65}
.prose p{margin:0 0 .7rem}
.prose ul{margin:0 0 .8rem;padding-left:1.1rem}
.prose li{margin-bottom:.3rem}
.prose strong{color:var(--ink)}
.prose code{font-family:var(--mono);font-size:.95em;color:var(--accent)}
.spec{width:100%;border-collapse:collapse;font-size:.78rem;margin-bottom:.8rem}
.spec td{padding:.3rem .2rem;border-bottom:1px dashed var(--rule);vertical-align:top}
.spec td:first-child{color:var(--muted);white-space:nowrap;padding-right:.9rem;
  font-family:inherit}
.spec td:last-child{font-family:var(--mono)}
.lead{color:var(--muted);font-size:.78rem;margin:0 0 .9rem}
</style>
</head>
<body>

<header>
  <div>
    <h1>Nest AC Monitor</h1>
    <span class="sub">read-only &middot; unit 4109</span>
  </div>
  <button id="master" class="master off" type="button">
    <span class="dot"></span><span id="master-label">monitoring off</span>
  </button>
</header>

<main>

  <!-- live readings - always visible -->
  <section class="card wide">
    <div class="readings">
      <div class="reading big"><span class="label">room</span><span class="value" id="r-ambient">--</span></div>
      <div class="reading"><span class="label">setpoint</span><span class="value" id="r-setpoint">--</span></div>
      <div class="reading"><span class="label">humidity</span><span class="value" id="r-humidity">--</span></div>
      <div class="reading"><span class="label">hvac</span><span class="value" id="r-hvac">--</span></div>
      <div class="reading"><span class="label">mode</span><span class="value" id="r-mode">--</span></div>
      <div class="reading"><span class="label">outdoor</span><span class="value" id="r-outdoor">--</span></div>
      <div class="reading"><span class="label">wet bulb</span><span class="value" id="r-wetbulb">--</span></div>
    </div>
    <div id="verdict" class="verdict"></div>
    <button id="resume" class="resume" type="button" hidden>
      updates paused - click to resume
    </button>
  </section>

  <!-- the diagnostic view - always visible -->
  <section class="card wide">
    <div class="charthead">
      <h2 style="margin:0">history</h2>
      <div class="ranges" id="ranges">
        <button type="button" data-range="24h" aria-pressed="true">24h</button>
        <button type="button" data-range="7d" aria-pressed="false">1 week</button>
        <button type="button" data-range="30d" aria-pressed="false">1 month</button>
        <button type="button" data-range="1y" aria-pressed="false">1 year</button>
        <button type="button" data-range="all" aria-pressed="false">all</button>
      </div>
    </div>
    <div class="chartwrap" id="chartwrap">
      <div id="chart"></div>
      <div id="tipdot" class="tipdot hidden"></div>
      <div id="tip" class="tip hidden"></div>
    </div>
    <div class="legend">
      <span><i class="sw band"></i>cooling</span>
      <span><i class="sw amb"></i>room</span>
      <span><i class="sw set"></i>setpoint</span>
      <span><i class="sw wb"></i>outdoor wet bulb</span>
      <span id="bucketnote"></span>
    </div>
    <p class="note">Shaded bands are periods the thermostat was calling for cool.
      A wide band where the room line does not fall is a compressor lockout.
      Hover or drag across the chart for exact values.</p>
  </section>

  <!-- ================= row 1 ================= -->

  <details class="card" id="p-alertlog" open>
    <summary>alert log</summary>
    <div class="body">
      <p class="note"><b>started</b> = the condition became true.
        <b>cleared</b> = it went away. A pair brackets one episode, and the gap
        between them is how long it lasted. A row marked <b>not delivered</b> was
        recorded but the push never reached your phone - the evidence is written
        before the notification is attempted, so the record survives a push
        service being down. Stuck cooling also re-notifies hourly while it
        lasts; those reminders are not logged, so one episode stays one pair.</p>
      <table id="alert-log"><tbody></tbody></table>
    </div>
  </details>

  <details class="card" id="p-connection" open>
    <summary>connection</summary>
    <div class="body">
      <ul class="status">
        <li><span class="k">thermostat</span><span class="v" id="s-online">--</span></li>
        <li><span class="k">api</span><span class="v" id="s-api">--</span></li>
        <li><span class="k">token</span><span class="v" id="s-token">--</span></li>
        <li><span class="k">last poll</span><span class="v" id="s-poll">--</span></li>
        <li><span class="k">samples stored</span><span class="v" id="s-count">--</span></li>
        <li><span class="k">notifier</span><span class="v" id="s-notifier">--</span></li>
      </ul>
      <div class="row">
        <button id="poll-now" type="button">poll now</button>
        <a id="csv" href="/api/export.csv" download>today's csv</a>
      </div>
    </div>
  </details>

  <details class="card" id="p-settings">
    <summary>settings</summary>
    <div class="body">
      <h2>alerts</h2>
      <div class="toggles">
        <label><input type="checkbox" data-key="alert_a_enabled"> stuck cooling <i id="st-A"></i></label>
        <label><input type="checkbox" data-key="alert_b_enabled"> humidity <i id="st-B"></i></label>
        <label><input type="checkbox" data-key="alert_c_enabled"> thermostat offline <i id="st-C"></i></label>
        <label><input type="checkbox" data-key="alert_d_enabled"> google auth expiry <i id="st-D"></i></label>
      </div>
      <h2>thresholds</h2>
      <div class="fields">
        <label>stuck minutes<input type="number" data-key="stuck_minutes" min="5" step="1"></label>
        <label>min drop &deg;F<input type="number" data-key="min_drop_f" min="0" step="0.1"></label>
        <label>humidity %<input type="number" data-key="humidity_pct" min="1" step="1"></label>
        <label>humidity min<input type="number" data-key="humidity_minutes" min="0" step="5"></label>
        <label>humidity clear margin %<input type="number" data-key="humidity_clear_margin" min="0" step="1"></label>
        <label>cooldown min<input type="number" data-key="cooldown_minutes" min="1" step="5"></label>
        <label>remind every min<input type="number" data-key="repeat_minutes" min="0" step="15"></label>
        <label>max reminders<input type="number" data-key="repeat_max" min="0" step="1"></label>
        <label>retention days<input type="number" data-key="retention_days" min="1" step="1"></label>
      </div>
      <h2>quiet hours</h2>
      <p class="note">Inside this window, humidity and thermostat-offline alerts
        wait until it ends. Stuck cooling always comes through.</p>
      <label class="check"><input type="checkbox" data-key="quiet_hours_enabled"> enabled</label>
      <div class="fields pair">
        <label>start<input type="time" data-key="quiet_start"></label>
        <label>end<input type="time" data-key="quiet_end"></label>
      </div>
    </div>
  </details>

  <!-- ================= row 2 ================= -->

  <details class="card" id="p-notifications">
    <summary>notifications</summary>
    <div class="body">
      <p class="note">Credentials are Cloudflare Worker secrets. They are never sent to
        this page and never returned by the API.</p>
      <div class="fields">
        <label>notifier
          <select data-key="notifier"><option value="ntfy">ntfy</option><option value="pushover">pushover</option></select>
        </label>
        <label class="check"><input type="checkbox" data-key="wake_at_night"> wake me at night (stuck cooling overrides Do Not Disturb)</label>
      </div>
      <div class="row">
        <button id="test-notify" class="primary" type="button">send test notification</button>
        <span id="test-result" class="result"></span>
      </div>
    </div>
  </details>

  <details class="card" id="p-reauth">
    <summary>re-authenticate</summary>
    <div class="body">
      <p class="note">Google refresh tokens die if the password changes or access is
        revoked. That is Alert D.</p>
      <div class="row"><button id="get-auth-url" type="button">get authorisation url</button></div>
      <div id="auth-steps" class="hidden">
        <p class="note">Open it, toggle the thermostat on, allow, then paste the google.com URL you land on:</p>
        <textarea id="auth-url" rows="3" readonly></textarea>
        <textarea id="auth-paste" rows="2" placeholder="paste the full redirect url here"></textarea>
        <div class="row">
          <button id="auth-submit" class="primary" type="button">complete</button>
          <span id="auth-result" class="result"></span>
        </div>
      </div>
    </div>
  </details>

  <details class="card" id="p-hardware">
    <summary>hardware</summary>
    <div class="body">
      <p class="lead">Unit 4109, The Ivy at Riverfront. Original installation,
        building completed 2008.</p>

      <h2>the heat pump</h2>
      <table class="spec">
        <tr><td>Make / model</td><td>Trane Axiom GEV<br>GEVB06011T0100TRD010000100000000000</td></tr>
        <tr><td>Serial</td><td>W07M89577</td></tr>
        <tr><td>Tag</td><td>HP-8</td></tr>
        <tr><td>Capacity</td><td>5 tons (60 MBH)</td></tr>
        <tr><td>Refrigerant</td><td>R-22, factory charge 98 oz (2.793 kg)</td></tr>
        <tr><td>Electrical</td><td>208 V, 60 Hz, 1 phase &middot; max breaker 60 A</td></tr>
        <tr><td>Compressor</td><td>28.0 RLA &middot; 169.0 LRA &middot; single stage</td></tr>
        <tr><td>Blower</td><td>1 HP, 5.40 FLA</td></tr>
      </table>

      <h2>safety limits</h2>
      <table class="spec">
        <tr><td>High pressure switch</td><td>opens above <b>395 psig</b></td></tr>
        <tr><td>Low pressure switch</td><td>20 psig</td></tr>
        <tr><td>Water design band</td><td>60 &ndash; 90 &deg;F entering</td></tr>
        <tr><td>ARI rating point</td><td>86 &deg;F entering water</td></tr>
      </table>

      <h2>how it is cooled</h2>
      <div class="prose">
        <p>This is <strong>not</strong> a normal apartment air conditioner. There is
          no outdoor unit of your own. The heat pump rejects heat into a
          <strong>building-wide condenser water loop</strong>, which carries it to
          <strong>rooftop cooling towers</strong> that dump it to the outside air.</p>
        <p>So cooling depends on three things working: your unit, the water loop,
          and the towers. When loop temperature rises, your unit has to push
          against higher pressure to get rid of the same heat.</p>
      </div>

      <h2>why it stops</h2>
      <div class="prose">
        <p>A <strong>lockout relay</strong> cuts the compressor while
          <strong>leaving the blower running</strong>. Two separate faults trip
          that same relay:</p>
        <ul>
          <li><strong>High pressure switch</strong> &mdash; discharge pressure above
            395 psig, from warm loop water or heavy load.</li>
          <li><strong>Condensate overflow switch</strong> &mdash; the drain has
            blocked and water is backing up.</li>
        </ul>
        <p>They produce an <strong>identical symptom and an identical reset</strong>,
          and cannot be told apart without opening the unit. Both leave air moving
          at room temperature, which is why the failure is silent.</p>
        <p>Reset: thermostat <code>Off</code>, wait five minutes,
          back to <code>Cool</code>. Expect a further delay before the compressor
          restarts &mdash; there is an anti-short-cycle timer counted from the last
          compressor stop.</p>
      </div>
    </div>
  </details>

  <!-- ================= row 3 ================= -->

  <details class="card wide" id="p-howitworks">
    <summary>how this monitor works</summary>
    <div class="body prose">
      <p class="lead">Short version: the thermostat cannot tell you the compressor
        has stopped. This can, by comparing what the thermostat <em>asked for</em>
        against what the room <em>actually did</em>.</p>

      <h2>the problem</h2>
      <p>A Nest reports its own <strong>commanded</strong> state, never whether the
        compressor is really running. When the lockout relay opens, the thermostat
        keeps saying <code>COOLING</code>, the blower keeps blowing, and the
        apartment sounds exactly like it is cooling while it warms up. Nest's own
        Energy History draws a solid bar for &ldquo;calling for cool&rdquo; whether
        the compressor is working, losing, or dead. That is why these failures were
        being discovered hours later.</p>

      <h2>the inference</h2>
      <p>Every 5 minutes a Cloudflare Worker reads the thermostat through Google's
        Smart Device Management API and writes one row: room temperature, humidity,
        HVAC status, mode, setpoint, connectivity, and outdoor temperature, humidity,
        dew point and wet bulb.</p>
      <p><strong>Sustained <code>COOLING</code> plus a room that is not getting
        cooler means the compressor is not running.</strong> That is the whole idea,
        and from outside the unit it is the only signal available.</p>

      <h2>what it watches for</h2>
      <table class="spec">
        <tr><td><b>stuck cooling</b></td><td>Calling for cool for 25 minutes with
          less than 0.5&deg;F of drop <em>over the most recent 25 minutes</em>.
          The lockout.</td></tr>
        <tr><td><b>humidity</b></td><td>Indoor humidity at or above 60% held for
          45 minutes without a break. The coil has stopped removing moisture
          &mdash; often the earliest sign, before temperature moves. It used to
          fire on two consecutive polls, which is ten minutes, and almost every
          episode it caught cleared itself within the hour; an alert that cries
          wolf is worse than no alert.</td></tr>
        <tr><td><b>thermostat offline</b></td><td>Thermostat unreachable twice running, or
          three consecutive API failures. Covers a power cut or an internet
          outage at the apartment.</td></tr>
        <tr><td><b>google auth expiry</b></td><td>Google rejected the stored
          credentials. Without this alert the monitor would go blind silently,
          which is how these integrations usually die.</td></tr>
      </table>
      <p>Each fires <strong>once</strong> and sends <strong>one</strong> recovery
        notification when it clears. <b>Stuck cooling</b> is the exception: while
        it is still true you are reminded <strong>every hour, up to ten times</strong>,
        because a compressor still locked out an hour later is still an emergency
        and one notification in the afternoon is easy to miss. The reminders are
        numbered in the title so your phone shows them as new messages instead of
        collapsing them into the first one.</p>
      <p class="note">In the exported CSV and the stored data these are recorded as
        <code>A</code>, <code>B</code>, <code>C</code> and <code>D</code>, in the
        order above.</p>

      <h2>why the window slides</h2>
      <p>The stuck-cooling check measures the <strong>most recent</strong> 25 minutes, not the whole
        run. A unit that cools well for 25 minutes and then quits would otherwise
        hide behind its own good start &mdash; the longer it sat dead, the healthier
        it would look. That exact failure happened on 27 August and the detection
        was corrected the same evening.</p>

      <h2>what it will not do</h2>
      <p><strong>It never sends a command to the thermostat.</strong> Every call is
        a read. That is deliberate: a bug in this application cannot leave the
        apartment uncooled.</p>
      <p>It also cannot diagnose. Entering water temperature, discharge pressure
        against the 395 psig cutout, which leg of the lockout relay opened, and the
        stored fault history are all invisible to a thermostat. Those come from a
        technician with gauges.</p>

      <h2>the part that matters most</h2>
      <p><strong>The log, not the alerts.</strong> An alert wakes you once. The
        record is independent evidence of how often and at what hours the unit fails
        to hold setpoint, with outdoor conditions in the same row &mdash; in a form
        you can hand to a technician or attach to an email.</p>
      <p>Readings are pruned after 90 days. <strong>Alerts are never pruned.</strong>
        Daily CSV export is on the connection panel.</p>
    </div>
  </details>

</main>

<script>
const $ = (id) => document.getElementById(id);
const ALERT_LABEL = {
  A: "stuck cooling",
  B: "humidity",
  C: "thermostat offline",
  D: "google auth expiry",
};
let settings = {}, editing = null, range = "24h";
// Last sample the dashboard has seen, so a refresh that would return nothing
// new can be skipped, and so the "last poll" clock can tick without a request.
let lastSampleTs = null;

async function api(p, o) {
  const r = await fetch(p, o);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
const post = (p, b) => api(p, {method:"POST", headers:{"Content-Type":"application/json"},
  body: JSON.stringify(b || {})});
const num = (v, u = "", d = 1) => (v === null || v === undefined) ? "--" : Number(v).toFixed(d) + u;

function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return Math.round(s) + "s ago";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  return (s / 3600).toFixed(1) + "h ago";
}
const mark = (el, t, c) => { el.textContent = t; el.className = "v " + (c || ""); };

async function refreshStatus() {
  let d;
  try { d = await api("/api/status"); }
  catch { mark($("s-api"), "unreachable", "bad"); return; }

  settings = d.settings;
  const c = d.current || {};
  const fresh = Boolean(c.ts) && c.ts !== lastSampleTs;
  if (c.ts) lastSampleTs = c.ts;
  $("r-ambient").textContent = num(c.ambient_f, "F");
  $("r-setpoint").textContent = num(c.setpoint_f, "F");
  $("r-humidity").textContent = num(c.humidity_pct, "%", 0);
  $("r-hvac").textContent = c.hvac_status || "--";
  $("r-mode").textContent = c.mode || "--";
  $("r-outdoor").textContent = num(c.outdoor_f, "F");
  $("r-wetbulb").textContent = num(c.outdoor_wetbulb_f, "F");

  const m = $("master");
  m.classList.toggle("on", !!settings.monitoring_enabled);
  $("master-label").textContent = settings.monitoring_enabled ? "monitoring on" : "monitoring off";

  const v = $("verdict"), cool = d.cooling || {};
  if (d.alert_state?.A?.active) {
    v.className = "verdict alarm";
    v.textContent = "Stuck cooling: no movement for " + cool.minutes + " minutes (run "
      + cool.run_minutes + " min). Likely compressor lockout.";
  } else if (cool.at_risk && cool.minutes > 0) {
    v.className = "verdict watch";
    v.textContent = "Cooling " + cool.run_minutes + " min, flat over the last "
      + cool.minutes + ". Alert fires at " + settings.stuck_minutes + " min flat.";
  } else if (c.hvac_status === "COOLING") {
    v.className = "verdict fine";
    v.textContent = "Cooling " + cool.run_minutes + " min, " + cool.run_delta_f + "F. Working.";
  } else {
    v.className = "verdict";
    v.textContent = c.hvac_status ? "Compressor idle (" + c.hvac_status + ")." : "";
  }

  mark($("s-online"), c.connectivity || "--", c.connectivity === "ONLINE" ? "ok" : "bad");
  mark($("s-api"), d.api_ok ? "reachable" : "failing", d.api_ok ? "ok" : "bad");
  mark($("s-token"), d.auth_ok ? "valid" : "REJECTED", d.auth_ok ? "ok" : "bad");
  mark($("s-poll"), ago(c.ts), d.stale ? "warn" : "");
  mark($("s-count"), String(d.sample_count));
  mark($("s-notifier"), d.notifier, d.notifier === "none" ? "bad" : "ok");

  for (const t of ["A","B","C","D"]) {
    const st = d.alert_state[t] || {}, el = $("st-" + t);
    el.textContent = st.active ? (st.pending ? "held" : "ACTIVE") : "";
    el.className = st.active ? "active" : "";
  }

  document.querySelectorAll("[data-key]").forEach((el) => {
    if (el === editing) return;
    const k = el.dataset.key;
    if (k in settings) { if (el.type === "checkbox") el.checked = !!settings[k]; else el.value = settings[k]; }
  });

  return fresh;
}

// ------------------------------------------------------------------- chart

function tickLabel(date, rangeKey) {
  const p = (n) => String(n).padStart(2, "0");
  if (rangeKey === "24h") return p(date.getHours()) + ":00";
  if (rangeKey === "7d" || rangeKey === "30d") return p(date.getMonth()+1) + "/" + p(date.getDate());
  return date.toLocaleString(undefined, { month: "short", year: "2-digit" });
}

// Geometry of the chart currently on screen, so a pointer position can be
// mapped back to the sample under it. The SVG uses preserveAspectRatio="none",
// so the viewBox stretches to the container and the mapping stays linear.
let chartState = null;

function drawChart(data) {
  const host = $("chart");
  const raw = data.bucket === "raw";
  const good = data.samples.filter(s => s.ambient_f !== null);
  $("bucketnote").textContent = raw ? "" :
    "(" + (data.bucket === "hour" ? "hourly" : "daily") + " averages)";

  if (good.length < 2) {
    host.innerHTML = '<p class="note">Not enough samples yet.</p>';
    chartState = null; hideTip();
    return;
  }

  const W = 1000, H = 300, L = 40, R = 10, T = 10, B = 24;
  const t = s => new Date(s.ts).getTime();
  const t0 = t(good[0]), t1 = t(good[good.length-1]) || t0 + 1;

  const vals = [];
  for (const s of good) {
    vals.push(s.ambient_f);
    if (s.ambient_min_f !== null && s.ambient_min_f !== undefined) vals.push(s.ambient_min_f, s.ambient_max_f);
    if (s.setpoint_f !== null) vals.push(s.setpoint_f);
    if (s.wetbulb_f !== null) vals.push(s.wetbulb_f);
  }
  let lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }

  const x = s => L + ((t(s) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const line = k => { let d = "", pen = false;
    for (const s of good) { if (s[k] === null || s[k] === undefined) { pen = false; continue; }
      d += (pen ? "L" : "M") + x(s).toFixed(1) + "," + y(s[k]).toFixed(1); pen = true; } return d; };

  // COOLING shading. Raw samples give exact bands; aggregated buckets shade in
  // proportion to how much of the bucket was spent calling for cool.
  let bands = "";
  if (raw) {
    let start = null;
    for (let i = 0; i < good.length; i++) {
      const cooling = good[i].hvac === "COOLING";
      if (cooling && start === null) start = good[i];
      if ((!cooling || i === good.length - 1) && start !== null) {
        const x1 = x(start), x2 = x(good[i]);
        bands += '<rect x="' + x1.toFixed(1) + '" y="' + T + '" width="' + Math.max(1, x2 - x1).toFixed(1)
          + '" height="' + (H - T - B) + '" fill="var(--band)"/>';
        start = null;
      }
    }
  } else {
    const w = Math.max(1, (W - L - R) / good.length);
    for (const s of good) {
      const frac = s.cooling_frac || 0;
      if (frac <= 0) continue;
      bands += '<rect x="' + (x(s) - w / 2).toFixed(1) + '" y="' + T + '" width="' + w.toFixed(1)
        + '" height="' + (H - T - B) + '" fill="var(--band)" opacity="' + Math.min(1, frac).toFixed(2) + '"/>';
    }
  }

  // min/max envelope for aggregated buckets, so an averaged day still shows swing
  let envelope = "";
  if (!raw && good[0].ambient_min_f !== null && good[0].ambient_min_f !== undefined) {
    let up = "", down = "";
    good.forEach((s, i) => {
      up += (i ? "L" : "M") + x(s).toFixed(1) + "," + y(s.ambient_max_f).toFixed(1);
    });
    for (let i = good.length - 1; i >= 0; i--) {
      down += "L" + x(good[i]).toFixed(1) + "," + y(good[i].ambient_min_f).toFixed(1);
    }
    envelope = '<path d="' + up + down + 'Z" fill="var(--area)"/>';
  }

  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const val = lo + ((hi - lo) * i) / 4, yy = y(val).toFixed(1);
    grid += '<line class="grid" x1="' + L + '" y1="' + yy + '" x2="' + (W - R) + '" y2="' + yy + '"/>';
    grid += '<text x="4" y="' + (+yy + 4).toFixed(1) + '">' + val.toFixed(0) + 'F</text>';
  }

  const ticks = [];
  const n = window.innerWidth < 560 ? 4 : 6;
  for (let i = 0; i <= n; i++) {
    const when = new Date(t0 + ((t1 - t0) * i) / n);
    const anchor = i === 0 ? "start" : i === n ? "end" : "middle";
    ticks.push('<text x="' + (L + ((W - L - R) * i) / n).toFixed(1) + '" y="' + (H - 6)
      + '" text-anchor="' + anchor + '">' + tickLabel(when, data.range) + '</text>');
  }

  const cross = '<line class="cross" id="cross" x1="0" y1="' + T + '" x2="0" y2="'
    + (H - B) + '" opacity="0" vector-effect="non-scaling-stroke"/>';

  chartState = { data, good, W, H, L, R, T, B, t0, t1, lo, hi, raw };

  host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
    + bands + envelope + grid + ticks.join("") + cross
    + '<path d="' + line("wetbulb_f") + '" fill="none" stroke="var(--warn)" stroke-width="1.6" stroke-dasharray="4 3" opacity=".75" vector-effect="non-scaling-stroke"/>'
    + '<path d="' + line("setpoint_f") + '" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>'
    + '<path d="' + line("ambient_f") + '" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
}

// ----------------------------------------------------------------- tooltip

function hideTip() {
  $("tip").classList.add("hidden");
  $("tipdot").classList.add("hidden");
  const c = document.getElementById("cross");
  if (c) c.setAttribute("opacity", "0");
}

function fmtWhen(iso, range, bucket) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (bucket === "day") return date + " " + d.getFullYear();
  if (bucket === "hour") return date + " " + p(d.getHours()) + ":00";
  return date + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function showTip(clientX) {
  if (!chartState) return;
  const { data, good, W, H, L, R, t0, t1, lo, hi, raw } = chartState;
  const wrap = $("chartwrap");
  const rect = $("chart").getBoundingClientRect();
  if (!rect.width) return;

  // container pixels -> viewBox units -> time -> nearest sample
  const vbX = ((clientX - rect.left) / rect.width) * W;
  const frac = Math.min(1, Math.max(0, (vbX - L) / (W - L - R)));
  const target = t0 + frac * (t1 - t0);

  let best = good[0], bestGap = Infinity;
  for (const s of good) {
    const gap = Math.abs(new Date(s.ts).getTime() - target);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }

  const bx = L + ((new Date(best.ts).getTime() - t0) / (t1 - t0 || 1)) * (W - L - R);
  const by = 10 + (1 - (best.ambient_f - lo) / (hi - lo)) * (H - 10 - 24);

  const cross = document.getElementById("cross");
  if (cross) {
    cross.setAttribute("x1", bx.toFixed(1));
    cross.setAttribute("x2", bx.toFixed(1));
    cross.setAttribute("opacity", "1");
  }

  const px = (bx / W) * rect.width;
  const py = (by / H) * rect.height;
  const dot = $("tipdot");
  dot.style.left = px + "px";
  dot.style.top = py + "px";
  dot.classList.remove("hidden");

  const row = (k, v) => v === null || v === undefined ? ""
    : '<div class="r"><span>' + k + '</span><span>' + v + '</span></div>';
  const f = (v, u, d) => v === null || v === undefined ? null : Number(v).toFixed(d === undefined ? 1 : d) + (u || "");

  let html = '<div class="when">' + fmtWhen(best.ts, data.range, data.bucket) + "</div>";
  html += row("room", f(best.ambient_f, "F"));
  if (!raw && best.ambient_min_f !== null && best.ambient_min_f !== undefined) {
    html += row("range", f(best.ambient_min_f, "", 1) + " - " + f(best.ambient_max_f, "F"));
  }
  html += row("setpoint", f(best.setpoint_f, "F"));
  html += row("humidity", f(best.humidity_pct, "%", 0));
  if (raw) {
    html += row("hvac", best.hvac || "--");
  } else if (best.cooling_frac !== null && best.cooling_frac !== undefined) {
    html += row("cooling", Math.round(best.cooling_frac * 100) + "% of period");
  }
  html += row("outdoor", f(best.outdoor_f, "F"));
  html += row("wet bulb", f(best.wetbulb_f, "F"));
  if (best.error) html += row("poll", "error");

  const tip = $("tip");
  tip.innerHTML = html;
  tip.classList.remove("hidden");

  // keep the box inside the card
  const tw = tip.offsetWidth || 150;
  let left = px + 14;
  if (left + tw > wrap.clientWidth - 4) left = px - tw - 14;
  tip.style.left = Math.max(4, left) + "px";
}

(function wireTooltip() {
  const wrap = $("chartwrap");
  let tracking = false;
  wrap.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || tracking) showTip(e.clientX);
  });
  wrap.addEventListener("pointerdown", (e) => { tracking = true; showTip(e.clientX); });
  wrap.addEventListener("pointerup", () => { tracking = false; });
  wrap.addEventListener("pointercancel", () => { tracking = false; hideTip(); });
  wrap.addEventListener("pointerleave", () => { tracking = false; hideTip(); });
})();

// The series currently on screen. Kept so the 24-hour chart can be refreshed
// incrementally - only the samples newer than its last point are fetched, which
// is one row per five minutes instead of re-reading all ~290 rows of the window
// every time - and so a resize or a panel toggle can redraw from memory instead
// of spending a request. Bucketed ranges (7d and up) are always fetched whole:
// they are user-initiated, rare, and expensive enough to keep off any timer.
let series = null;

async function refreshHistory(force) {
  const last = series && series.bucket === "raw" && series.range === range && !force
    ? Date.parse(series.samples[series.samples.length - 1]?.ts)
    : NaN;
  const since = Number.isFinite(last) ? last : null;

  try {
    const d = await api("/api/history?range=" + range + (since ? "&since=" + since : ""));
    if (d.partial && since && series && d.range === series.range) {
      // Append what arrived, then drop whatever fell out of the window.
      const cutoff = Date.now() - 24 * 3_600_000;
      series.samples = series.samples
        .concat(d.samples)
        .filter((x) => Date.parse(x.ts) >= cutoff);
    } else {
      series = d;
    }
    drawChart(series);
    hideTip();
  } catch {}
}

/** Re-render the chart from the series in hand. No request: a window resize or
 *  an opened panel changes the layout, not the data. */
function redrawChart() {
  if (series) { drawChart(series); hideTip(); } else refreshHistory();
}

async function refreshAlerts() {
  // 50 rows is not worth spending on a panel nobody has open, and this one
  // remembers being closed. Opening it fetches immediately - see wirePanels().
  if (!$("p-alertlog").open) return;
  try {
    const d = await api("/api/alerts");
    document.querySelector("#alert-log tbody").innerHTML = d.alerts.length
      ? d.alerts.map(a => {
          let note = "", undelivered = false;
          try {
            const p = JSON.parse(a.payload || "{}");
            note = p.note || "";
            // Only rows written since delivery started being recorded carry the
            // flag at all; older ones say nothing rather than guess.
            undelivered = p.notified === false;
          } catch {}
          const esc = (x) => String(x).replace(/[&<>]/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
          const label = a.direction === "fire" ? "started" : "cleared";
          const what = ALERT_LABEL[a.type] || a.type;
          return '<tr><td class="t">' + a.ts.replace("T", " ").slice(0, 16)
            + '</td><td class="what">' + what + '</td><td class="' + a.direction + '">'
            + label + (undelivered ? '<span class="undelivered">not delivered</span>' : "")
            + '</td></tr>'
            + (note ? '<tr class="noterow"><td colspan="3">' + esc(note) + '</td></tr>' : "");
        }).join("")
      : '<tr><td class="t" colspan="3">no alerts recorded</td></tr>';
  } catch {}
}

// Panels remember whether you left them open. Wrapped because localStorage
// throws outright in some privacy modes rather than just returning null.
function wirePanels() {
  document.querySelectorAll("details.card").forEach((d) => {
    const key = "nestac.panel." + d.id;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) d.open = saved === "1";
    } catch {}
    d.addEventListener("toggle", () => {
      try { localStorage.setItem(key, d.open ? "1" : "0"); } catch {}
      if (d.id === "p-alertlog" && d.open) refreshAlerts();
      if (d.id === "p-howitworks" || d.id === "p-hardware") return;
      redrawChart();
    });
  });
}

// ------------------------------------------------------------------ wiring

$("ranges").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-range]");
  if (!b) return;
  range = b.dataset.range;
  for (const el of $("ranges").children) el.setAttribute("aria-pressed", String(el === b));
  refreshHistory(true);
});

document.querySelectorAll("[data-key]").forEach((el) => {
  el.addEventListener("focus", () => { editing = el; });
  el.addEventListener("blur", () => { if (editing === el) editing = null; });
  el.addEventListener("change", async () => {
    const value = el.type === "checkbox" ? el.checked : el.value;
    editing = null;
    await post("/api/config", { [el.dataset.key]: value });
    refreshStatus();
  });
});

$("master").addEventListener("click", async () => {
  await post("/api/config", { monitoring_enabled: !settings.monitoring_enabled });
  refreshStatus();
});

$("poll-now").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try { await post("/api/poll-now"); } finally { e.target.disabled = false; }
  refreshStatus(); refreshHistory(); refreshAlerts();
});

$("test-notify").addEventListener("click", async (e) => {
  const out = $("test-result");
  e.target.disabled = true; out.textContent = "sending..."; out.className = "result";
  try { const r = await post("/api/test-notification");
    out.textContent = "sent via " + r.via + " - check your phone"; out.className = "result ok"; }
  catch (err) { out.textContent = String(err.message || err).slice(0,200); out.className = "result bad"; }
  finally { e.target.disabled = false; }
});

$("get-auth-url").addEventListener("click", async () => {
  try { const r = await api("/api/auth-url");
    $("auth-url").value = r.url; $("auth-steps").classList.remove("hidden");
    window.open(r.url, "_blank", "noopener");
  } catch (err) { $("auth-result").textContent = String(err.message||err).slice(0,160);
    $("auth-result").className = "result bad"; }
});

$("auth-submit").addEventListener("click", async () => {
  const out = $("auth-result");
  out.textContent = "exchanging..."; out.className = "result";
  try { await post("/api/auth-complete", { redirect_url: $("auth-paste").value });
    out.textContent = "re-authenticated"; out.className = "result ok"; $("auth-paste").value = "";
  } catch (err) { out.textContent = String(err.message||err).slice(0,200); out.className = "result bad"; }
});

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawChart, 250);
});

// ---------------------------------------------------------------- polling
//
// One timer, aligned to the sampler, and nothing fetched that cannot have
// changed. The sampler is a cron job on */5, so the old ten-second status poll
// showed nothing new 29 times out of 30 - and it never stopped: on 2026-10-12 a
// single dashboard tab left open in the background spent the whole Cloudflare
// account's D1 free-tier day - 5 million rows read, shared by every database on
// the account - on polls that returned unchanged numbers, and took an unrelated
// app down with it.
//
// So: one status call per sample, fired just after the cron tick lands rather
// than on an arbitrary phase, which is both 5x cheaper than a one-minute timer
// and fresher. History and alerts are not on a timer at all - they are fetched
// only when that status call reports a sample the dashboard did not have. The
// "last poll" clock ticks locally off the timestamp already in hand. Nothing
// runs while the tab is hidden, and nothing runs after a long idle stretch.
// Every query here costs rows against a shared account budget, so the rule is:
// never spend a request on an answer that cannot have changed.

const SAMPLE_MS = 300_000;             // the sampler's */5 cadence
const OFFSET_MS = 25_000;              // land just after the cron tick writes
const IDLE_LIMIT_MS = 2 * 3_600_000;   // then stop until a human comes back

let pollTimer = null;
let lastSeen = Date.now();

// Time to the next five-minute boundary plus the offset. Epoch arithmetic, so
// the slots line up with the cron's UTC schedule whatever the local zone.
function msToNextSlot() {
  const now = Date.now();
  const slot = Math.ceil((now - OFFSET_MS) / SAMPLE_MS) * SAMPLE_MS + OFFSET_MS;
  return Math.max(5_000, slot - now);
}

function refreshAll() { refreshStatus(); refreshHistory(); refreshAlerts(); }

function stopPolling(paused) {
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  $("resume").hidden = !paused;
}

/** Resume from hidden/idle. The immediate flag fetches once before the
 *  first slot, so a tab coming back does not wait up to five minutes. */
function startPolling(immediate) {
  lastSeen = Date.now();
  $("resume").hidden = true;
  if (immediate) refreshAll();
  if (pollTimer === null) pollTimer = setTimeout(onTick, msToNextSlot());
}

async function onTick() {
  pollTimer = null;
  // Hidden tabs are stopped on visibilitychange; this is the backstop for
  // browsers that fire the timer anyway (and for throttled background tabs).
  if (document.hidden) { stopPolling(false); return; }
  if (Date.now() - lastSeen > IDLE_LIMIT_MS) { stopPolling(true); return; }

  const fresh = await refreshStatus();
  if (fresh) { refreshHistory(); refreshAlerts(); }

  // Not if something resumed us while that was in flight.
  if (pollTimer === null && !document.hidden) pollTimer = setTimeout(onTick, msToNextSlot());
}

// The "last poll" line re-renders from the timestamp already in hand, so the
// clock keeps moving between fetches without costing a request.
setInterval(() => {
  if (document.hidden || !lastSampleTs) return;
  const late = Date.now() - Date.parse(lastSampleTs) > (settings.poll_seconds || 300) * 3000;
  mark($("s-poll"), ago(lastSampleTs), late ? "warn" : "");
}, 10_000);

addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling(false);
  else startPolling(true);          // one catch-up fetch, then back on the timer
});

$("resume").addEventListener("click", () => startPolling(true));

// Someone clicking range buttons for two hours is not idle. Only counts while
// the timer runs: once paused, the resume button is the way back.
const noteActivity = () => { if (pollTimer !== null) lastSeen = Date.now(); };
addEventListener("pointerdown", noteActivity, { passive: true });
addEventListener("keydown", noteActivity, { passive: true });

wirePanels();
// A page opened into a background tab polls nothing until it is looked at.
if (document.hidden) stopPolling(false);
else startPolling(true);
</script>
</body>
</html>`;
