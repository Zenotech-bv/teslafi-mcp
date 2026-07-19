# Changelog

All notable changes to the TeslaFi MCP server are documented in this file.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [2.1.0] — 2026-07-19

### Added

- **Local command allowlist with per-command parameter validation.**
  `tesla_send_command` validates against a fixed allowlist of 18 TeslaFi
  commands. Unknown commands, parameter keys not valid for the given command,
  and the reserved keys `token` / `command` / `wake` are rejected by the server
  itself, before any network request. The allowlist lookup uses an own-property
  check, so prototype-inherited names (`constructor`, `__proto__`, ...) are
  rejected like any other unknown command. The allowlist is sourced from
  community documentation (the ha-teslafi Home Assistant integration) plus
  commands verified against a live TeslaFi account, since TeslaFi's own API
  docs are login-gated.
- **Opt-in gating for vehicle commands.** The `TESLAFI_ENABLE_COMMANDS`
  environment variable (truthy values: `true`, `1`, `yes`; case-insensitive)
  controls whether `tesla_send_command` does anything. See the BREAKING notes
  below.
- **Retry with backoff and request spacing.** Outbound TeslaFi requests are
  spaced at least 1 s apart. Transient failures are retried up to 2 times with
  exponential backoff and jitter. An HTTP 429 is retried only when TeslaFi
  supplies a `Retry-After` of at most 60 s; a 429 without that header, or
  asking for a longer wait, fails immediately with a rate-limit error. Reads
  are retried freely on network errors and 5xx; commands are only retried for
  failures where the request provably never reached TeslaFi (DNS/connection
  errors, 429 rejections with an honored `Retry-After`) — never for mid-flight
  errors, so a command cannot run twice.
- **Redirects are never followed and proxies are never used.** Every outbound
  request sets `maxRedirects: 0` and `proxy: false`, enforcing that the only
  network destination is `www.teslafi.com` over HTTPS: a server-issued
  redirect surfaces as an error instead of re-sending the token-bearing URL to
  another host or over plain HTTP, and `HTTP_PROXY`/`HTTPS_PROXY` environment
  variables are ignored instead of routing the request through a proxy.
- **In-memory TTL cache for history.** `history.php` responses (drives and
  charges) are cached for 60 seconds by default, configurable via
  `TESLAFI_CACHE_TTL_SECONDS` (`0` disables). Keyed by endpoint + date range;
  failures are not cached; nothing is ever written to disk.
- **`include_raw` parameter** (default `false`) on `tesla_get_drives`,
  `tesla_get_charges`, and `tesla_get_trips_for_month`, to opt in to embedding
  the full raw TeslaFi records.
- **Bounded analysis output.** `tesla_analyze_home_work_trips` caps the
  embedded matched-trip list at 500 entries and reports `trips_truncated`;
  summary counts still cover the entire month.
- **CI and tests.** A GitHub Actions workflow builds and tests on Node 20 and
  22, plus a build-only check on Node 18 (the oldest supported runtime; the
  vitest toolchain requires Node >= 20), and a vitest-based `npm test` script.

### Changed

- **BREAKING:** `tesla_get_drives` and `tesla_get_charges` structured output
  now returns compact per-record summaries (drives: `id`, `date`,
  `start_location`, `end_location`, `distance_km`, `distance_mi`; charges:
  `id`, `date`, `location`, `energy_added_kwh`) instead of full raw TeslaFi
  records. Pass `include_raw: true` to get each raw record embedded under a
  `raw` key.
- **BREAKING:** the MCP server name changed from `tesla-mcp-server` to
  `teslafi-mcp`. Update any client configuration that references the server by
  name.
- **BREAKING:** `tesla_send_command` is now **disabled by default**. Set
  `TESLAFI_ENABLE_COMMANDS=true` (or enable the "Enable vehicle commands"
  extension setting) to use it; commands must additionally be enabled
  per-command on TeslaFi's Commands tab. When disabled, the tool returns an
  instructive error without contacting TeslaFi.

### Fixed

- **Parameter injection / token override.** User-supplied command parameters
  could override the `token` and `command` query parameters sent to TeslaFi.
  Reserved keys are now rejected outright, and the token is applied after user
  parameters so it can never be overridden.
- **Token leak via fatal-error logging.** Axios errors embed the full request
  URL — including the `token=` query parameter — and were previously logged
  verbatim on fatal errors. All errors are now converted to sanitized
  messages: the token value, `token=` query fragments, and TeslaFi request
  URLs are redacted before anything is logged or returned.
- **Malformed responses silently treated as empty.** HTML error pages and
  plain-text bodies from `history.php` were parsed as an empty result set,
  making outages look like "no drives found". Malformed payloads now raise a
  descriptive error, distinguished from genuinely empty results. The same
  guard applies to `tesla_send_command`: a plain-text feed.php body (e.g. a
  login page) is surfaced as an error — with a warning that the command may
  still have executed — instead of being rendered as a successful result.
- **Wake timeout mismatch.** The HTTP timeout did not account for TeslaFi's
  wake-and-wait window, so commands using a wake wait could time out before
  TeslaFi answered. `wake_seconds` now extends the request timeout to cover
  the wait.
- **Understated dependency floors.** `@modelcontextprotocol/sdk` was declared
  as `^1.6.1` although the server uses `registerTool` with ZodObject input
  schemas, which requires SDK >= 1.23.0 (which in turn requires zod >= 3.25).
  The declared ranges now match the real minimums (`^1.23.0` / `^3.25.0`).
- **Misleading startup log.** The startup message misrepresented the server's
  configuration. It now reports the active token source variable
  (`TESLA_API_TOKEN` or `TESLAFI_API_TOKEN`) and whether vehicle commands are
  enabled — never the token value itself.

### Removed

- **Personal data scrubbed.** Real tokens, real location names, and
  machine-specific paths were removed from code, docs, and examples;
  placeholders such as "Home" and "Acme HQ" are used throughout.
- **Personal helper scripts moved out of the repository.** The generic
  field-inspection helpers (`scripts/inspect-teslafi.mjs`,
  `scripts/debug-history.mjs`) remain, and both redact the token in their
  output.

## [2.0.0]

Prior baseline release (published as `tesla-mcp-server`): live vehicle data,
drive and charge history, commute analysis, and always-available vehicle
commands — without the gating, allowlisting, caching, retry, and sanitization
work listed above.
