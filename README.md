# TeslaFi MCP Server

[![CI](https://github.com/Zenotech-bv/teslafi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Zenotech-bv/teslafi-mcp/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[TeslaFi](https://teslafi.com) API. It lets MCP clients such as Claude Desktop
query your vehicle's live data, stored drive and charge history, and commute
patterns — and, only if you explicitly opt in, send vehicle commands.

Example: *"How many times did I drive from Home to Acme HQ last month, and what
did charging cost me?"*

## What can you ask?

Once connected, your MCP client can answer questions like these — and combine
the underlying data in ways no fixed dashboard can.

**Live status**

- "Is my car charging right now, and what's it set to stop at?"
- "What's my battery level — is that enough for a 150 km round trip?"
- "What's my range — show it in miles instead."
- "Where's my car parked, and is it locked?"
- "How many kilometres has my car done?"
- "Check my tyre pressures (in bar) — anything low?"
- "What software version is the car on, and is an update pending?"

**Driving & charging history**

- "List my drives from last weekend."
- "How far did I drive in June, and what was my longest trip? Use miles."
- "Show this month's charging sessions — how much energy did I add in total?"
- "How often do I charge away from home?"
- "What's my total distance on record — and remember it only goes back to when
  I joined TeslaFi, so don't call it lifetime."

**Commutes & places**

- "How many times did I commute to the office last month?"
- "What are my ten most-visited places this year?"
- "Which weekdays did I work from home in June?"

**Reports & analysis** (the client combines tools and does the math)

- "Build me a mileage expense report for July: date, from, to, distance — as a
  table I can paste into a spreadsheet."
- "Compare my energy use this month against last month."
- "Estimate my charging cost per kilometre, assuming €0.30/kWh at home and
  €0.55/kWh supercharging."

**Vehicle commands** (only with the explicit opt-in — see below)

- "Warm the cabin to 21 °C."
- "Turn on the driver's seat heater, full blast."
- "Set the charge limit to 90% for tomorrow's long trip."
- "Flash the lights so I can find the car in this car park."
- "Lock the car."
- "The car's asleep — wake it and start charging." (waking must be asked for
  explicitly; a plain command never wakes a sleeping car)
- "How much of my monthly TeslaFi command quota have I used?"

## Tools

| Tool | Purpose |
| --- | --- |
| `tesla_get_current_data` | Live / last-known vehicle data (state, battery, range, charging, location). |
| `tesla_get_drives` | Stored drive history, with optional date-range filtering. |
| `tesla_get_charges` | Stored charge sessions, with optional date-range filtering. |
| `tesla_get_trips_for_month` | All drives in a given calendar month, normalized. |
| `tesla_analyze_home_work_trips` | Count home-to-work and work-to-home commutes in a month (e.g. Home ↔ Acme HQ). |
| `tesla_get_locations` | Unique named locations and visit counts derived from drive history. |
| `tesla_send_command` | Send a vehicle control command — **disabled by default**, see [Vehicle commands](#vehicle-commands-opt-in). Car commands **never wake a sleeping car** unless you pass `wake_seconds` or `no_wake: false`. |

### Units

Every data-returning tool (`tesla_get_current_data`, `tesla_get_drives`,
`tesla_get_charges`, `tesla_get_trips_for_month`,
`tesla_analyze_home_work_trips`, `tesla_get_locations`) accepts an optional
`units` argument — `"metric"`, `"imperial"`, or `"both"` — and every response
carries a top-level `units` field stating the system that was applied.

**Physical quantities are self-describing.** Field names carry the unit as a
suffix (`_km`/`_mi`, `_kmh`/`_mph`, `_c`/`_f`, `_bar`/`_psi`, `_kwh`, `_m`/`_ft`,
`_pct`), and every markdown number is printed next to its unit (`314 km`,
`24 °C`, `3.1 bar`, `18.6 kWh`, `72 %`). With `units: "both"` **both** suffixed
fields are emitted for each quantity.

**Effective-unit resolution** (used when `units` is not passed), in order:

1. the explicit `units` tool argument;
2. the `TESLAFI_UNITS` environment variable (`metric`/`imperial`,
   case-insensitive; any other value ignored);
3. your TeslaFi account preference (the feed's `measure` field), remembered in
   memory from the most recent feed response this session;
4. metric.

> The OS locale is **not** visible to the server. `TESLAFI_UNITS` is the
> documented way for a client to pin a default so you don't have to pass
> `units` on every call.

**Live feed vs. history.** Live feed values (`tesla_get_current_data`) are
Tesla-native (miles, mph, °C, psi, metres) regardless of your account setting,
so they are **converted** to the chosen system. History records
(drives/charges/trips) already carry **both** unit systems, so the server
**selects** the pre-existing field for the chosen system rather than
re-converting — no double-conversion or rounding drift. Percentages, kWh, and
currency are never converted; only their unit label is attached.

### Compact output and `include_raw`

`tesla_get_drives`, `tesla_get_charges`, and `tesla_get_trips_for_month` return
**compact records by default** (physical fields use the unit-suffixed names
above, for the applied system):

- Drives: `id`, `date`, `start_location`, `end_location`, then
  `distance_km`/`distance_mi`, `efficiency_wh_km`/`efficiency_wh_mi`,
  `speed_avg_kmh`/`speed_avg_mph`, `speed_max_kmh`/`speed_max_mph`,
  `temperature_avg_c`/`temperature_avg_f` (°C-only source, converted for
  imperial), `tpms_avg_bar`/`tpms_avg_psi` (bar-only source, converted for
  imperial), and `drive_kwh` (kWh — never converted). Everything else stays in
  the raw record (`include_raw`).
- Charges: `id`, `date`, `location`, `energy_added_kwh` (kWh — never converted)
- Trips: a normalized shape with start/end location, ISO timestamps,
  `distance_km`/`distance_mi`, and duration in minutes

All three tools accept an optional `include_raw` boolean (default `false`).
Only when it is `true` is the full raw TeslaFi record embedded (under a `raw`
key) alongside each summary — raw records are large, so request them only when
you need fields the summaries don't carry.

### History coverage metadata

`tesla_get_drives`, `tesla_get_charges`, and `tesla_get_trips_for_month` also
return, alongside `total`/`returned`/`offset`/`limit`/`has_more`:

- `date_range`: `{ earliest, latest }` computed from the **full fetched
  dataset** for the query (before pagination). When no date filter is supplied,
  `earliest` is effectively your TeslaFi join date. No extra network call is
  made — it is derived from the records already fetched.
- `coverage_note`: a short sentence noting that TeslaFi history only goes back
  to when you joined, so a "lifetime" figure derived from these records
  excludes any distance/energy before that date.

These let a client label totals honestly (the markdown likewise says, e.g.,
`2,526 drives on record (since 2023-12-18); showing 1–50`).

`tesla_analyze_home_work_trips` matches location names loosely
(case-insensitive substring match) and caps the embedded matched-trip list at
**500 entries**, setting `trips_truncated: true` when the cap is hit; the
summary counts always cover the full month.

## Getting a TeslaFi API token

1. Log in to TeslaFi and open <https://teslafi.com/api.php>
   (**Settings → TeslaFi API**).
2. Generate (or copy) your API token.
3. If you plan to use vehicle commands, also enable the specific commands you
   want on the **Commands** tab of that page.

## Installation

### Option A: MCP extension bundle (recommended)

1. Download `teslafi-mcp.mcpb` from the latest
   [GitHub Release](https://github.com/Zenotech-bv/teslafi-mcp/releases).
2. Open it with Claude Desktop (double-click, or **Settings → Extensions →
   Install extension**).
3. Paste your TeslaFi API token when prompted. Vehicle commands stay off unless
   you enable the "Enable vehicle commands" option.

### Option B: manual configuration

```bash
git clone https://github.com/Zenotech-bv/teslafi-mcp.git
cd teslafi-mcp
npm install
npm run build
```

Then add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "teslafi": {
      "command": "node",
      "args": ["/path/to/teslafi-mcp/dist/index.js"],
      "env": {
        "TESLA_API_TOKEN": "your_teslafi_token_here"
      }
    }
  }
}
```

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TESLA_API_TOKEN` | Yes* | — | Your TeslaFi API token. |
| `TESLAFI_API_TOKEN` | Yes* | — | Alias for `TESLA_API_TOKEN`; either works. |
| `TESLAFI_ENABLE_COMMANDS` | No | unset (off) | Enables the `tesla_send_command` tool. Only `true`, `1`, or `yes` (case-insensitive) enable it; **any other value keeps the server read-only**. |
| `TESLAFI_UNITS` | No | unset (Automatic) | Default unit system for physical quantities when a tool call omits `units`. `metric` or `imperial` (case-insensitive) pins a default; **any other value** (including the extension's "Automatic") defers to your TeslaFi account's `measure` setting, then metric. The OS locale is **not** visible to the server, so this is the documented way for a client to pin a default without passing `units` on every call. |
| `TESLAFI_CACHE_TTL_SECONDS` | No | `60` | TTL of the in-memory history cache, in seconds. Set to `0` to disable caching; invalid values fall back to the default. |

\* One of the two token variables must be set; `TESLA_API_TOKEN` takes
precedence.

Note for extension-bundle users: the "Enable vehicle commands" checkbox maps to
`TESLAFI_ENABLE_COMMANDS`. When left off it passes the literal string `"false"`,
which is not in the truthy set (`true`/`1`/`yes`) and therefore keeps commands
disabled — only ticking the checkbox enables them. The **Units** dropdown maps
to `TESLAFI_UNITS`; its default "Automatic (account default)" passes a value
the server ignores, so units fall back to your TeslaFi account setting (then
metric) until you choose Metric or Imperial.

### Vehicle commands (opt-in)

`tesla_send_command` is registered but **disabled by default**. When disabled,
calling it returns a clear error explaining how to enable it — nothing is sent
to your car. To use it you must:

1. Set `TESLAFI_ENABLE_COMMANDS=true` in the server's environment (or tick
   "Enable vehicle commands" when installing the extension bundle), **and**
2. Enable the individual commands on TeslaFi's **Commands** tab at
   <https://teslafi.com/api.php>.

#### Supported commands

Commands are validated against a **fixed local allowlist** — the 24 commands
below, matching **TeslaFi's official API documentation** (the command list
shown on the logged-in API settings page at <https://teslafi.com/api.php>).
Anything not on the list, any parameter key not valid for the given command,
and the reserved keys `token`, `command`, `wake`, and `noWake` are rejected by
this server itself, before any network request is made. Numeric parameters are
also value-checked locally (ranges noted below), so an out-of-range value
never costs a quota request.

Benign (polling, logging, horn, lights, climate):

| Command | Parameters |
| --- | --- |
| `wake` | — (resume TeslaFi polling: sets the idle timer to 0 and re-enables polling) |
| `wake_up` | — (wake the vehicle) |
| `sleep` | `time` (optional; minutes for the sleep attempt) |
| `enableLogging` | — |
| `command_count` | — (read-only: current command/wake quota usage) |
| `honk` | — |
| `flash_lights` | — |
| `auto_conditioning_start` / `auto_conditioning_stop` | — |
| `set_temps` | `temp` (Celsius, one decimal allowed; 15–28) |
| `seat_heater` | `heater` (0 = driver, 1 = passenger, 2 = rear left, 4 = rear center, 5 = rear right — there is **no** seat `3`), `level` (0–3; `0` = off). Conditioning must be turned on first. |
| `steering_wheel_heater` | `statement` (`true`/`false`). Conditioning must be turned on first. |
| `set_preconditioning_max` | `statement` (`true`/`false`) — Max Defrost; when turned off, conditioning remains on |
| `preset` | `number` (preset ID, required), `statement` (optional; `true` sends an email confirmation). The controls the preset drives must themselves be enabled. |

Consequential (logging off, locks, charging, security):

| Command | Parameters |
| --- | --- |
| `disableLogging` | — (stops TeslaFi's data logging for your account) |
| `door_lock` / `door_unlock` | — |
| `charge_start` / `charge_stop` | — |
| `charge_port_door_open` / `charge_port_door_close` | — |
| `set_charge_limit` | `charge_limit_soc` (50–100) |
| `set_charging_amps` | `charging_amps` (1–80) |
| `set_sentry_mode` | `sentryMode` (`true`/`false`) |

Two global modifiers control what happens when the car is asleep:

- `wake_seconds` (1–60, TeslaFi's documented maximum — maps to `&wake=X`):
  TeslaFi sends a wake and pauses up to that many seconds before issuing the
  command; the request timeout is extended to cover the wait. Note this costs
  a wake request from the monthly quota (see below).
- `no_wake: true` (maps to `&noWake=true`): the command is **not sent at all**
  while the vehicle is sleeping.

> **Wake-conserving default — car commands never wake a sleeping car.**
> For **car commands** (honk, lights, climate, seat/wheel heaters, presets,
> charging, charge port, locks, sentry — everything that acts on the vehicle
> itself), passing **neither** `wake_seconds` **nor** `no_wake` sends
> `noWake=true` automatically: a sleeping car is never woken implicitly, so
> no monthly wake request is ever spent without you asking for it. If the car
> was asleep, the tool output states the command was **not** sent and lists
> the options (retry with `wake_seconds`, or wait until the car wakes).
> To wake the car, pass `wake_seconds`; to restore TeslaFi's own default
> (wake the car and pause up to 15 s), pass `no_wake: false` explicitly.
> Account-side commands (`wake`, `wake_up`, `sleep`, `enableLogging`,
> `disableLogging`, `command_count`) are handled by TeslaFi itself and never
> take `noWake` (`no_wake: true` on them is rejected locally).

The two modifiers are mutually exclusive; supplying both is rejected locally
with a clear error.

#### Command quotas

TeslaFi allows **500 command requests and 50 wake requests per month**,
resetting on the 1st. A command issued while the car is asleep costs
**1 command + 1 wake**; if the wake quota is exhausted while the car is
asleep, the command is not sent and the API returns an error. Every command
and data response embeds a `tesla_request_counter` object
(`{"commands": N, "wakes": N, ...}`), updated immediately on API command
calls and otherwise every 30 minutes. This server surfaces it as a
`Quota: N/500 commands, M/50 wakes used this month` line in the
`tesla_send_command` and `tesla_get_current_data` markdown output (and it is
present in the structured output whenever TeslaFi includes it); the
`command_count` command returns the counters on demand.

The server is quota-careful on top of that:

- **Wake-conserving default** — car commands never spend a wake request
  implicitly; see the wake-conserving default above.
- **High-usage warnings** — the server remembers the last
  `tesla_request_counter` it saw (from any command or data response,
  in memory only). Once usage reaches **80%** of an allowance
  (≥ 400/500 commands or ≥ 40/50 wakes), every `tesla_send_command`
  markdown result is prefixed with a warning line such as
  `WARNING: 43/50 monthly wake requests used`.
- **Proactive rate-limit pacing** — data responses also embed a `rate_limit`
  object (`{"limit": 15, "remaining": N, "reset_in_seconds": N}`). When the
  last response reported `remaining: 0`, the server waits out the remainder
  of the reported reset window (capped at 60 s) before the next request,
  instead of firing one that is guaranteed to be rejected with HTTP 429.
- **Exhausted-allowance errors are terminal** — a TeslaFi error indicating
  the monthly command or wake allowance is used up is never retried, and is
  surfaced as an actionable message: the command was **not** sent, the last
  known usage, that allowances reset on the 1st of the month, and that extra
  requests can be purchased from TeslaFi support. (TeslaFi does not document
  the exact error payload, so the match is heuristic; ordinary auth or
  malformed-request errors are never classified this way.)

## Performance notes

- **History caching** — `history.php` responses (drives and charges) are cached
  in memory for 60 seconds by default (`TESLAFI_CACHE_TTL_SECONDS`; `0`
  disables), keyed by endpoint + date range, so pagination and the
  commute-analysis tools reuse a single fetch. Failures are never cached, and
  nothing is written to disk.
- **Request spacing** — outbound requests to TeslaFi are spaced at least 1
  second apart, to stay within TeslaFi's per-minute API request limits.
- **Proactive rate-limit pacing** — when TeslaFi's embedded `rate_limit`
  object last reported `remaining: 0`, the next request waits out the
  remainder of the reported reset window (capped at 60 s) instead of firing a
  guaranteed HTTP 429. The pacing state is in-memory only.
- **Retries** — transient failures are retried up to 2 times with exponential
  backoff and jitter. An HTTP 429 is retried only when TeslaFi supplies a
  `Retry-After` of at most 60 s; a 429 without that header, or asking for a
  longer wait, fails immediately with a rate-limit error (mentioning the
  requested wait) instead of blocking the client. Reads are retried freely on
  network errors and 5xx. Vehicle commands are only retried for failures where
  the request provably never reached TeslaFi (DNS/connection errors, 429
  rejections with an honored `Retry-After`) — never for mid-flight errors such
  as timeouts or resets, so a command cannot be executed twice.
- **Wake handling** — `wake_seconds` (1–60 s) extends the default 30 s request
  timeout by the wake window, so wake-assisted commands don't time out
  spuriously.

## Privacy & Security

- **Stateless** — no database, no persistent state between requests. The only
  cache is a short-lived in-memory one (see `TESLAFI_CACHE_TTL_SECONDS`).
- **Zero disk writes** — the server never writes your vehicle data, token, or
  anything else to disk.
- **Zero telemetry** — no analytics, no crash reporting, no phoning home.
- **No data retention** — responses are passed to your MCP client and then
  discarded.
- **Single network destination** — the only host this server ever contacts is
  `www.teslafi.com`, over HTTPS. HTTP redirects are never followed
  (`maxRedirects: 0`), so even a server-issued redirect cannot send the
  token-bearing request to another host or downgrade it to plain HTTP. Proxy
  environment variables (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`) are ignored
  (`proxy: false`), so requests always go directly to `www.teslafi.com`.
- **Read-only by default** — vehicle commands require the explicit
  `TESLAFI_ENABLE_COMMANDS=true` opt-in described above.
- **Token handling** — your token is never written to logs, error messages, or
  tool output. Note that TeslaFi's API design places the token in URL query
  parameters; see [SECURITY.md](SECURITY.md) for what that means and how it is
  mitigated.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run dev     # run from source with auto-reload
npm run build   # compile TypeScript to dist/
npm test        # run the test suite
```

> **Note:** `npm test` requires **Node 20 or newer** — the vitest toolchain
> does not run on Node 18. Node 18 is only supported for *running* the built
> server.

A helper script dumps a real sample of your TeslaFi data so field mappings can
be verified against your account:

```bash
npm run build
TESLA_API_TOKEN=xxxx npm run inspect -- --month 2026-07
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Requirements

- Node.js 18 or newer to run the built server (development and `npm test`
  require Node 20 or newer — see [Development](#development))
- A TeslaFi account and API token

## License

[MIT](LICENSE) © 2026 Matt Stevens
