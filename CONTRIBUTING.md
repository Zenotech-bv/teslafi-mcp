# Contributing

Thanks for your interest in improving the TeslaFi MCP server.

## Development setup

```bash
git clone https://github.com/Zenotech-bv/teslafi-mcp.git
cd teslafi-mcp
npm install
npm run build
npm test
```

> **Note:** `npm test` requires **Node 20 or newer** — the vitest toolchain
> does not run on Node 18 (Node 18 is only supported for running the built
> server).

Useful scripts:

- `npm run dev` — run from source with auto-reload
- `npm run inspect -- --month YYYY-MM` — dump a sample of your own TeslaFi
  data to verify field mappings (requires `TESLA_API_TOKEN` in the
  environment)

## Pull requests

- Open an issue first for anything larger than a small fix, so we can agree
  on the approach.
- Keep PRs focused — one change per PR.
- Make sure `npm run build` and `npm test` pass before submitting.
- Preserve the project's privacy and safety invariants: the server must remain
  stateless, write nothing to disk, send no telemetry, contact only
  `www.teslafi.com`, and never expose the API token in logs, errors, or tool
  output. `tesla_send_command` must stay disabled unless
  `TESLAFI_ENABLE_COMMANDS` is truthy, and vehicle commands must keep their
  local allowlist, reserved-key rejection, and no-retry-after-send behavior.
  PRs that weaken any of these will not be merged.
- Never include a real API token, real location names, or personal data in
  code, tests, fixtures, or docs. Use placeholders (e.g. "Home", "Acme HQ").

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please use private vulnerability reporting,
not public issues.

## Code of conduct

Be kind and constructive; harassment or personal attacks are not tolerated.
