# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.4.x | Yes |
| < 2.4 | No |

Only the latest release receives security fixes. Please upgrade before
reporting an issue against an older version.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's private vulnerability
reporting on this repository:

1. Go to <https://github.com/Zenotech-bv/teslafi-mcp/security/advisories>.
2. Click **Report a vulnerability** and describe the issue, impact, and
   reproduction steps.

Do **not** open a public issue for security problems. You can expect an
initial response within a few days.

## Known design constraints

### TeslaFi API token in URL query parameters

The TeslaFi API (`feed.php` and `history.php`) authenticates by passing your
API token as a **URL query parameter**. This is inherent to TeslaFi's API
design and cannot be changed by this server. The practical implications:

- The token may appear in places that log full URLs *outside* this server —
  for example intermediate proxies you configure yourself.
- Anyone with the token can read your vehicle data (and send commands, if you
  enabled them on TeslaFi's side).

Mitigations in place:

- All requests go to `www.teslafi.com` over **HTTPS**, so the full URL
  (including the token) is encrypted in transit; only the hostname is visible
  on the wire.
- HTTP redirects are **never followed** (`maxRedirects: 0` on every request):
  a redirect response is surfaced as an error instead, so a server-issued
  redirect can never re-send the token-bearing URL to a different host or over
  plain HTTP.
- Proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) are
  **ignored** (`proxy: false` on every request): the request always goes
  directly to `www.teslafi.com` instead of being routed through an
  environment-configured proxy.
- This server **never logs the token** and never includes it in error messages
  or tool output. Diagnostic output redacts it.
- The server is stateless and writes nothing to disk, so the token exists only
  in memory for the lifetime of the process.

If you believe your token has been exposed, regenerate it at
<https://teslafi.com/api.php> (Settings → TeslaFi API).

### Vehicle commands

The `tesla_send_command` tool is disabled by default and requires a double
opt-in: `TESLAFI_ENABLE_COMMANDS=true` (accepted truthy values: `true`, `1`,
`yes`) on this server **and** per-command enablement on TeslaFi's Commands
tab. Keep both off if you only need read-only access.

Even when enabled, commands are validated against a fixed local allowlist
(matching TeslaFi's official API documentation): unknown commands and unknown
parameter keys are rejected by this server before any network request, and
the reserved `token`, `command`, `wake`, and `noWake` query keys can never be
supplied as command parameters. Commands are also never
retried once the request may have reached TeslaFi, so a transient network
error cannot cause a command to execute twice.

### Opt-in update check (second network destination)

By default the only host this server contacts is `www.teslafi.com`. The
`TESLAFI_CHECK_UPDATES` opt-in (off by default; accepted truthy values `true`,
`1`, `yes`) adds **one** additional destination: a single **unauthenticated**
`GET` to `api.github.com` to read the latest release tag.

- It carries **no credentials and no data** — no TeslaFi token, no
  `Authorization` header, and no vehicle data — and is built on a hardcoded URL,
  never from user input.
- It uses the same hardening as the TeslaFi requests: no redirects
  (`maxRedirects: 0`) and no proxy (`proxy: false`).
- It is fire-and-forget: every failure is swallowed and can never affect a tool
  result, and the outcome is held in memory only (nothing is written to disk).
- When the flag is not truthy, **no** GitHub request is ever made, preserving
  the single-destination (`www.teslafi.com`-only) property.
