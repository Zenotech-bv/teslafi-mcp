# TeslaFi MCP Server

[![CI](https://github.com/Zenotech-bv/teslafi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Zenotech-bv/teslafi-mcp/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[TeslaFi](https://teslafi.com) API. It lets MCP clients such as Claude Desktop
query your vehicle's live data, stored drive and charge history, and commute
patterns — and, only if you explicitly opt in, send vehicle commands.

Example: *"How many times did I drive from Home to Acme HQ last month, and what
did charging cost me?"*

## Tools

| Tool | Purpose |
| --- | --- |
| `tesla_get_current_data` | Live / last-known vehicle data (state, battery, range, charging, location). |
| `tesla_get_drives` | Stored drive history, with optional date-range filtering. |
| `tesla_get_charges` | Stored charge sessions, with optional date-range filtering. |
| `tesla_get_trips_for_month` | All drives in a given calendar month, normalized. |
| `tesla_analyze_home_work_trips` | Count home-to-work and work-to-home commutes in a month (e.g. Home ↔ Acme HQ). |
| `tesla_get_locations` | Unique named locations and visit counts derived from drive history. |
| `tesla_send_command` | Send a vehicle control command — **disabled by default**, see [Vehicle commands](#vehicle-commands-opt-in). |

### Compact output and `include_raw`

`tesla_get_drives`, `tesla_get_charges`, and `tesla_get_trips_for_month` return
**compact records by default**:

- Drives: `id`, `date`, `start_location`, `end_location`, `distance_km`, `distance_mi`
- Charges: `id`, `date`, `location`, `energy_added_kwh`
- Trips: a normalized shape with start/end location, ISO timestamps, distance,
  and duration

All three tools accept an optional `include_raw` boolean (default `false`).
Only when it is `true` is the full raw TeslaFi record embedded (under a `raw`
key) alongside each summary — raw records are large, so request them only when
you need fields the summaries don't carry.

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
| `TESLAFI_CACHE_TTL_SECONDS` | No | `60` | TTL of the in-memory history cache, in seconds. Set to `0` to disable caching; invalid values fall back to the default. |

\* One of the two token variables must be set; `TESLA_API_TOKEN` takes
precedence.

Note for extension-bundle users: the "Enable vehicle commands" checkbox maps to
`TESLAFI_ENABLE_COMMANDS`. When left off it passes the literal string `"false"`,
which is not in the truthy set (`true`/`1`/`yes`) and therefore keeps commands
disabled — only ticking the checkbox enables them.

### Vehicle commands (opt-in)

`tesla_send_command` is registered but **disabled by default**. When disabled,
calling it returns a clear error explaining how to enable it — nothing is sent
to your car. To use it you must:

1. Set `TESLAFI_ENABLE_COMMANDS=true` in the server's environment (or tick
   "Enable vehicle commands" when installing the extension bundle), **and**
2. Enable the individual commands on TeslaFi's **Commands** tab at
   <https://teslafi.com/api.php>.

#### Supported commands

Commands are validated against a **fixed local allowlist** — the 18 commands
below. Anything not on the list, any parameter key not valid for the given
command, and the reserved keys `token`, `command`, and `wake` are rejected by
this server itself, before any network request is made. TeslaFi's own API
documentation sits behind a login at <https://teslafi.com/api.php>, so this
allowlist is sourced from community documentation — the
[ha-teslafi](https://github.com/jhansche/ha-teslafi) Home Assistant
integration — plus commands verified against a live TeslaFi account.

Benign (wake, horn, lights, climate):

| Command | Parameters |
| --- | --- |
| `wake_up` | — |
| `honk` / `honk_horn` | — |
| `flash_lights` | — |
| `auto_conditioning_start` / `auto_conditioning_stop` | — |
| `set_temps` | `temp`, or `driver_temp` / `passenger_temp` |
| `set_preconditioning_max` | `statement` |
| `steering_wheel_heater` | `statement` |

Consequential (locks, charging, security):

| Command | Parameters |
| --- | --- |
| `door_lock` / `door_unlock` | — |
| `charge_start` / `charge_stop` | — |
| `charge_port_door_open` / `charge_port_door_close` | — |
| `set_charge_limit` | `charge_limit_soc` |
| `set_charging_amps` | `charging_amps` |
| `set_sentry_mode` | `sentryMode` |

To wake the car before a command, pass `wake_seconds` (1–120): TeslaFi wakes
the car and waits up to that long before issuing the command, and the request
timeout is extended to cover the wait.

## Performance notes

- **History caching** — `history.php` responses (drives and charges) are cached
  in memory for 60 seconds by default (`TESLAFI_CACHE_TTL_SECONDS`; `0`
  disables), keyed by endpoint + date range, so pagination and the
  commute-analysis tools reuse a single fetch. Failures are never cached, and
  nothing is written to disk.
- **Request spacing** — outbound requests to TeslaFi are spaced at least 1
  second apart, to stay within TeslaFi's per-minute API request limits.
- **Retries** — transient failures are retried up to 2 times with exponential
  backoff and jitter. An HTTP 429 is retried only when TeslaFi supplies a
  `Retry-After` of at most 60 s; a 429 without that header, or asking for a
  longer wait, fails immediately with a rate-limit error (mentioning the
  requested wait) instead of blocking the client. Reads are retried freely on
  network errors and 5xx. Vehicle commands are only retried for failures where
  the request provably never reached TeslaFi (DNS/connection errors, 429
  rejections with an honored `Retry-After`) — never for mid-flight errors such
  as timeouts or resets, so a command cannot be executed twice.
- **Wake handling** — `wake_seconds` extends the default 30 s request timeout
  by the wake window, so wake-assisted commands don't time out spuriously.

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
