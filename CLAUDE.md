# TeslaFi MCP — Claude Code cold-start guide

This file orients a fresh **Claude Code** session (and the human running it) on
this repository. Claude Code loads it automatically; you can also read it
top-to-bottom as a maintainer's onboarding brief. If you are evaluating or
adopting this project (e.g. **TeslaFi**), start here — it is MIT-licensed and
yours to run, fork, rebrand, or ship without restriction.

A good first prompt for a new session:

> "Read CLAUDE.md, then give me a 5-line summary of the architecture and run the
> test suite so I know the tree is healthy."

---

## What this is

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
the [TeslaFi](https://teslafi.com) API to MCP clients (Claude Desktop, etc.), so
a user can ask an assistant about their vehicle in natural language. It is
packaged both as a plain Node server and as an **MCPB extension bundle**
(`.mcpb`) for one-click install into Claude Desktop.

Seven tools: `tesla_get_current_data`, `tesla_get_drives`, `tesla_get_charges`,
`tesla_get_trips_for_month`, `tesla_analyze_home_work_trips`,
`tesla_get_locations`, and `tesla_send_command` (vehicle control — disabled by
default).

## Quick start

Requirements: **Node 20+** (18+ runs the built server, but the test toolchain
needs 20+), and a TeslaFi API token from <https://teslafi.com/api.php>.

```bash
git clone https://github.com/Zenotech-bv/teslafi-mcp.git
cd teslafi-mcp
npm install
npm run build      # tsc -> dist/
npm test           # vitest run — all HTTP is mocked, nothing hits the network
```

Run the server standalone:

```bash
TESLA_API_TOKEN=your_token node dist/index.js     # speaks MCP over stdio
```

Rebuild the extension bundle:

```bash
npx @anthropic-ai/mcpb pack   # -> teslafi-mcp.mcpb (gitignored)
```

## Architecture map

| Path | Role |
| --- | --- |
| `src/services/tesla-api.ts` | The TeslaFi client and all business logic: HTTP with retry/backoff, rate-limit pacing, in-memory history cache, the command allowlist, quota tracking, the units system, and the `UpdateChecker`. Also the exported `VERSION` constant. Most changes land here. |
| `src/index.ts` | MCP server wiring: registers the 7 tools, parses args through the Zod schemas, renders markdown vs JSON output, and surfaces quota/update notices. |
| `src/schemas.ts` | Zod input schemas for every tool. All `.strict()` — unknown keys are rejected. |
| `tests/tesla-api.test.ts`, `tests/server-tools.test.ts` | vitest suite (~360 tests). Every test mocks axios; none contact the real API. |
| `manifest.json` | MCPB extension manifest: metadata, tool list, and `user_config` (token + toggles). |
| `package.json`, `tsconfig.json`, `.mcpbignore` | Build config and bundle-exclusion rules. |
| `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md` | User- and contributor-facing docs. |

## Invariants — do NOT break these

These are the project's guarantees. They are load-bearing; every change must
preserve them, and the test suite enforces most of them.

1. **Stateless, zero disk writes, zero telemetry.** All caching is in-memory and
   short-lived. The server never writes vehicle data, tokens, or anything else
   to disk, and phones no home.
2. **Network destinations are exactly two, and the second is opt-in.**
   `www.teslafi.com` always; `api.github.com` *only* when a user sets
   `TESLAFI_CHECK_UPDATES` (off by default). Every outbound request sets
   `maxRedirects: 0` and `proxy: false`.
3. **Token hygiene.** The TeslaFi token never appears in logs, error messages,
   or tool output, and is **never** sent to GitHub (the update check is a
   separate, unauthenticated request — never route it through the TeslaFi
   request pipeline, which appends the token as a query param).
4. **Commands are read-only by default.** `tesla_send_command` is gated behind
   `TESLAFI_ENABLE_COMMANDS` (accepts `true`/`1`/`yes`). Commands are validated
   against a fixed **official 24-command allowlist** (matching TeslaFi's API
   docs) using an own-property lookup; unknown commands and the reserved param
   keys `token`/`command`/`wake`/`noWake` are rejected locally before any
   network call.
5. **Respect the quota.** TeslaFi allows 500 commands + **50 wakes** per month.
   Car commands **never wake a sleeping car** unless the caller explicitly
   passes `wake_seconds` or `no_wake: false`. The client tracks usage from
   `tesla_request_counter`, warns at 80%, paces itself under the rate limit, and
   treats an allowance-exhausted error as terminal (no retry).
6. **Units are explicit.** Live-feed values are Tesla-native and get *converted*;
   history records carry both systems and get *selected* (never double-converted).
   Every structured field carries a unit suffix; every markdown number prints its
   unit; JSON output stays pure/parseable.
7. **Tests mock all HTTP.** Never write a test that contacts the real TeslaFi or
   GitHub API. Use the existing axios-mock patterns.

The single source of truth for the running version is the exported `VERSION`
constant in `src/services/tesla-api.ts`; it must equal `package.json` and
`manifest.json` versions (a test asserts this).

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `TESLA_API_TOKEN` / `TESLAFI_API_TOKEN` | — (required) | TeslaFi API token. |
| `TESLAFI_ENABLE_COMMANDS` | off | Enables `tesla_send_command` (`true`/`1`/`yes`). |
| `TESLAFI_UNITS` | account default | `metric` / `imperial` default when a call omits `units`. |
| `TESLAFI_CACHE_TTL_SECONDS` | `60` | History cache TTL; `0` disables. |
| `TESLAFI_CHECK_UPDATES` | off | Opt-in GitHub release check (contacts api.github.com, no token/data). |

In the extension, each maps to a `user_config` entry in `manifest.json`.

## Common tasks (and where they live)

- **Add or change a supported command** → the allowlist and per-command param
  rules in `src/services/tesla-api.ts`, plus tests and the README command tables.
- **Adjust unit handling** → the units helpers (`resolveUnits`,
  `normalizeFeedData`, `selectDriveUnitFields`) in `src/services/tesla-api.ts`.
- **Rebrand / re-own** (name, author, repo URL) → `package.json`,
  `manifest.json`, `README.md`, `LICENSE`. Keep the manifest `name` stable if you
  want Claude Desktop to treat new bundles as updates rather than a new extension.
- **Cut a release** → bump `VERSION` + `package.json` + `manifest.json`, then
  `npm run build && npm test`, `npx @anthropic-ai/mcpb pack`, and attach the
  `.mcpb` to a GitHub Release. CI (`.github/workflows/ci.yml`) builds and tests
  on Node 20/22.
- **Ship auto-updates to end users** → two routes: (a) submit the extension to
  Anthropic's official directory (real host-managed auto-update), or (b) publish
  the server to npm and have users install via `npx <pkg>@latest`. The built-in
  opt-in "new version available" notice (see `UpdateChecker`) is the lightweight
  third option already implemented.

## House rules for changes

- Keep the existing style: `.strict()` Zod schemas, the established error-message
  tone, small pure helpers that are unit-tested in isolation.
- `npm run build` must stay clean and `npm test` fully green before any commit.
- Never commit secrets; the repo has secret-scanning push protection enabled.
- See `CONTRIBUTING.md` for PR expectations and `SECURITY.md` for the security
  model and how to report issues.
