# Changelog

All notable changes to the TeslaFi MCP server are documented in this file.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [2.6.0] — 2026-07-20

### Added

- **Proactive, adaptive request pacing (in-memory token bucket).** Sustained
  load now *glides* within TeslaFi's advertised rate limit instead of bursting
  to the wall and stalling. A token bucket is derived from the `rate_limit`
  object TeslaFi embeds in responses — capacity ≈ the advertised `limit` and
  refill ≈ `limit / reset_in_seconds` tokens per second (e.g. a 15-token bucket
  refilling one token every ~4 s for the documented 15-requests-per-60 s
  budget). Each outbound request spends one token. This intentionally allows an
  **initial burst up to the advertised budget** — so short, typical
  interactions (a handful of tool calls) stay fast — and then **converges to the
  steady refill rate** under sustained use, pacing toward the window reset
  rather than slamming into `remaining: 0`. The newly-captured advertised
  `limit` (previously ignored) drives the sizing.

### Changed

- **Request spacing is now composed, not just fixed.** The pre-send wait is the
  maximum of three signals: the existing **1 s floor** between consecutive
  sends, the new **token-bucket wait**, and the existing **`remaining: 0`
  reset-window backstop** (capped at 60 s). All three remain in force — the 1 s
  floor, the `remaining === 0` hard wait, and the HTTP 429 `Retry-After` retry
  handling are unchanged backstops beneath the token bucket.

### Notes

- **Internal-only.** No tool, parameter, or output shape changed — this is
  purely internal pacing. State is **in-memory per process**, with **zero disk
  writes** and **no new network calls**.
- **Self-tuning with a safe fallback.** Capacity/refill are re-derived from the
  last-observed advertised limit+window. Before any `rate_limit` has been
  observed, or when the advertised limit/window is missing, zero, non-finite, or
  otherwise nonsensical, pacing falls back to the previous 1 s-floor-only
  behavior (never assuming a limit, never dividing by zero). Any single computed
  wait is capped at one window and never more than 60 s so a garbled advertised
  value cannot hang a request.

## [2.5.0] — 2026-07-20

### Fixed

- **Frequently-visited untagged locations were invisible to
  `tesla_get_locations`.** The location aggregation only counted endpoints with
  a non-empty `locationName`/`startingLocationName`, and only TeslaFi
  *dashboard-tagged* locations ever carry one. Any place the owner visited — even
  daily — that they had not separately geofenced+named inside TeslaFi Locations
  settings was silently dropped, with no count and no ranking. (A car-nav
  favorite is not the same thing as a TeslaFi-tagged Location and does not carry
  a `locationName`.) The aggregation now **falls back to the stable per-address
  key** (`locationKey` for the end endpoint, `startingLocationKey` for the start
  endpoint) when the name is empty, deriving a readable display name from the
  address (`address` / `startingAddress`) — so a place you visit often is
  surfaced with the correct visit count even when you never tagged it. Named and
  inferred groups are namespaced so they never collide, and an endpoint is
  skipped only when its name **and** key **and** address are all empty. Existing
  `visits` / `as_start` / `as_end` counting and the sort by `visits` descending
  are unchanged.

### Added

- **`named` flag on every location entry.** `LocationSummary` gains a boolean
  `named` field: `true` for owner-tagged TeslaFi locations (Home, Work, named
  Superchargers), `false` for addresses inferred from repeated raw visits. It is
  included in both the structured/JSON output and the markdown view (inferred
  entries are marked *"(inferred from address)"* with an explanatory note); JSON
  output stays pure and parseable.

### Notes

- `tesla_get_charges` was checked for the same gap. Its per-charge summary
  **already** falls back to the address (`locationName || address || "Unknown"`),
  so a charge at an untagged address is still labeled — no change was needed
  there; a regression test now pins that behavior.
- Behavior change (new inferred entries appear and every entry carries a new
  `named` field) but **backward-compatible**: all previously-returned tagged
  entries are still present, and the new field is purely additive. No tool
  parameters changed.

## [2.4.0] — 2026-07-20

### Added

- **Opt-in update check (off by default).** A new `TESLAFI_CHECK_UPDATES`
  environment variable (truthy only for `true`/`1`/`yes`, case-insensitive —
  the same rule as `TESLAFI_ENABLE_COMMANDS`) enables a lightweight check for a
  newer GitHub release. When on, the server makes a single **unauthenticated**
  `GET` to `api.github.com/repos/Zenotech-bv/teslafi-mcp/releases/latest`,
  compares the release tag to the running version using a numeric
  `major.minor.patch` comparison (so `10.0.0 > 9.9.9`; a leading `v` and any
  pre-release suffix are ignored), and — only when the release is strictly newer
  — appends a single one-line notice to data-tool markdown output, at most once
  per session. The notice never appears in `response_format: "json"` output, so
  JSON stays pure and parseable.
- **`enable_update_check` extension config.** `manifest.json` gains a plain
  boolean `user_config.enable_update_check` (title "Check for updates", default
  `false`), wired into `server.mcp_config.env` as `TESLAFI_CHECK_UPDATES`.
- **Single `VERSION` source of truth.** The running version is now a single
  exported constant consumed by both the `McpServer` constructor and the update
  comparison, kept in lockstep with `package.json` and `manifest.json` by a test.

### Security / privacy

- The update check is a **standalone** request that never touches the TeslaFi
  request pipeline: it sends **no** TeslaFi token, **no** `Authorization`
  header, and **no** TeslaFi data, and reuses the same `maxRedirects: 0` /
  `proxy: false` hardening. It is fire-and-forget (every failure — network
  error, timeout, 404 for a private repo, 403 rate limit, malformed JSON — is
  swallowed), in-memory only (zero disk writes), and **off by default**: when
  disabled, no GitHub request is ever made and the only network destination
  remains `www.teslafi.com`. A private repository returns 404 unauthenticated,
  so the notice only appears once the repository is public.

Not breaking: no tool parameters changed and all existing behavior is preserved.

## [2.3.0] — 2026-07-20

### Added

- **Selectable units on every data-returning tool.** `tesla_get_current_data`,
  `tesla_get_drives`, `tesla_get_charges`, `tesla_get_trips_for_month`,
  `tesla_analyze_home_work_trips`, and `tesla_get_locations` take an optional
  `units` argument — `"metric"`, `"imperial"`, or `"both"` — and every response
  now carries a top-level `units` field stating the applied system.
- **Effective-unit resolution.** When `units` is omitted it is resolved in
  order: the explicit argument, then the new `TESLAFI_UNITS` env var
  (`metric`/`imperial`, case-insensitive; other values ignored), then the
  TeslaFi account `measure` (remembered in memory from the most recent feed
  response), then metric. The OS locale is not visible to the server, so
  `TESLAFI_UNITS` is the documented way to pin a default.
- **`TESLAFI_UNITS` configuration.** Documented in the README config table and
  added to `manifest.json` `user_config` as an "Automatic / Metric / Imperial"
  select (default Automatic), wired into `server.mcp_config.env`.
- **Explicit unit fields everywhere.** Every physical quantity in the
  normalized/summary/structured output carries its unit as a field-name suffix
  (`_km`/`_mi`, `_kmh`/`_mph`, `_c`/`_f`, `_bar`/`_psi`, `_kwh`, `_m`/`_ft`,
  `_pct`); with `units: "both"` both suffixed fields are emitted. Every
  markdown renderer prints the unit next to every number. Live-feed values
  (Tesla-native regardless of account) are converted to the chosen system,
  while history records (which already carry both systems) have the pre-existing
  field selected — never re-converted — to avoid double conversion/rounding
  drift. Percentages, kWh, and currency are never converted, only labeled.
- **History coverage metadata.** `tesla_get_drives`, `tesla_get_charges`, and
  `tesla_get_trips_for_month` now return `date_range` (`{ earliest, latest }`,
  computed from the full fetched dataset before pagination — no extra network
  call) and `coverage_note`, so a client cannot mislabel a partial history
  fetch as a "lifetime" figure. The markdown reports counts honestly too
  (e.g. `2,526 drives on record (since 2023-12-18); showing 1–50`).

### Changed

- **BREAKING — output field names are now unit-suffixed.** Compact drive/charge
  summaries, trip objects, and the live-feed structured output changed shape:
  physical fields are renamed to unit-suffixed names for the applied system
  (e.g. the old drive `distance_km`/`distance_mi` pair is now emitted per the
  chosen `units`; `tesla_get_current_data` structured output is now a normalized
  object with suffixed fields plus passthrough of non-physical fields, rather
  than the raw feed record). `include_raw` still embeds the untouched raw
  record. Clients that read fixed field names must update to the suffixed names.

## [2.2.0] — 2026-07-19

### Added

- **Command allowlist aligned with TeslaFi's official API documentation.**
  The allowlist (now 24 commands) matches the command list on TeslaFi's
  logged-in API settings page, upgrading the provenance from community
  documentation (ha-teslafi) to the official source.
- **Six new commands plus a quota probe:** `wake` (resume TeslaFi polling:
  idle timer 0, polling on), `sleep` (optional `time` in minutes),
  `enableLogging`, `disableLogging`, `seat_heater` (`heater`: 0/1/2/4/5 —
  there is no seat 3; `level`: 0–3), `preset` (`number`, optional
  `statement`), and `command_count`, which returns the current command/wake
  quota counters and is treated as read-only (retried like a read, never like
  a mutating command).
- **`no_wake` parameter** on `tesla_send_command`, mapping to TeslaFi's
  `noWake=true` global modifier: the command is not sent at all when the
  vehicle is sleeping. Mutually exclusive with `wake_seconds` (a clear local
  error is raised when both are set). `noWake` also joined the reserved
  parameter keys.
- **Local parameter value validation.** Out-of-range values are rejected
  before any network request (so they never cost a quota request):
  `seat_heater` `heater` must be one of {0, 1, 2, 4, 5} and `level` 0–3,
  `charge_limit_soc` 50–100, `charging_amps` 1–80, `set_temps` `temp`
  15–28 °C, `sleep` `time` 1–1440 minutes, `preset` `number` a small positive
  integer.
- **Monthly quota surfacing.** TeslaFi allows 500 command + 50 wake requests
  per month (reset on the 1st; a command while the car is asleep costs
  1 command + 1 wake). When a response embeds `tesla_request_counter`, the
  `tesla_send_command` and `tesla_get_current_data` markdown output now ends
  with a `Quota: N/500 commands, M/50 wakes used this month` line, and the
  counter rides along in structured output. The counter is preserved across
  `{ response: ... }` envelope unwrapping, and its absence never causes a
  failure.
- **Quota tracking with high-usage warnings.** The server keeps the
  last-known `tesla_request_counter` (commands/wakes + timestamp) in memory,
  updated from every command **and** data response that carries one. Once
  usage reaches 80% of an allowance (≥ 400/500 commands or ≥ 40/50 wakes),
  every `tesla_send_command` markdown result is prefixed with a warning line
  (e.g. `WARNING: 43/50 monthly wake requests used`). Absent or malformed
  counters never cause a failure. All state is in-memory, per process.
- **Proactive rate-limit pacing.** The `rate_limit` object embedded in data
  responses (`remaining`, `reset_in_seconds`) is remembered; when the last
  response reported `remaining: 0`, the next outbound request waits out the
  remainder of the reported reset window (capped at 60 s) instead of firing a
  guaranteed HTTP 429. The existing 1 s minimum spacing and all existing
  retry/429 handling are unchanged.
- **Quota-exhausted errors are terminal and actionable.** TeslaFi errors
  indicating the monthly command or wake allowance is exceeded (matched
  permissively — the exact payload is undocumented) are never retried and are
  surfaced with an actionable message: the command was NOT sent, the last
  known usage when available, allowances reset on the 1st of the month, and
  extra requests are purchasable from TeslaFi support. Auth and
  malformed-request errors are never classified this way.
- **Asleep feedback.** When a command is not sent because the car was asleep
  under `noWake` (matched permissively on TeslaFi's unsent/asleep phrasing),
  the tool output states the command was NOT sent and explains the choices:
  retry with `wake_seconds` (costs 1 of the 50 monthly wakes) or wait until
  the car is awake.

### Changed

- **BREAKING — car commands no longer wake a sleeping car by default.** For
  the car-affecting commands (honk, lights, climate, seat/wheel heaters,
  presets, charging, charge port, locks, sentry), passing **neither**
  `wake_seconds` **nor** `no_wake` now sends `noWake=true` automatically: if
  the car is asleep the command is **not sent** and no wake request is spent.
  Pass `wake_seconds` to wake the car, or `no_wake: false` to restore
  TeslaFi's own default (wake + pause up to 15 s). Account-side commands
  (`wake`, `wake_up`, `sleep`, `enableLogging`, `disableLogging`,
  `command_count`) are exempt and never take `noWake`; `no_wake: true` on
  them is now rejected locally.
- **BREAKING:** `wake_seconds` is now capped at **60** (was 120), matching
  the official documented maximum for the `&wake=X` modifier. Calls passing
  61–120 are rejected at both the schema and the service layer.
- Documentation (README, tool description) now cites TeslaFi's official API
  documentation as the allowlist source and documents the command quotas,
  the seat-heater position map, and the conditioning prerequisites for
  `seat_heater`, `steering_wheel_heater`, and `preset`.

### Removed

- **BREAKING:** `honk_horn` — not an official TeslaFi command. Use `honk`.
- **BREAKING:** `driver_temp` / `passenger_temp` on `set_temps` — the
  official documentation supports only `temp` (Celsius, one decimal allowed).

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
