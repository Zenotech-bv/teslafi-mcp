#!/usr/bin/env node
/**
 * TeslaFi field-inspection script.
 *
 * Hits your real TeslaFi account and dumps a sample of what each endpoint
 * returns, so you can confirm the field names the MCP server maps against
 * (see normalizeDrive() in src/services/tesla-api.ts).
 *
 * Usage:
 *   npm run build            # ensure dist/ is up to date first
 *   TESLA_API_TOKEN=xxxx node scripts/inspect-teslafi.mjs
 *
 * Optional flags:
 *   --month YYYY-MM          inspect a specific month (default: current month)
 *   --from YYYY-MM-DD        explicit range start (overrides --month)
 *   --to   YYYY-MM-DD        explicit range end   (overrides --month)
 *
 * Examples:
 *   node scripts/inspect-teslafi.mjs --month 2026-07
 *   node scripts/inspect-teslafi.mjs --from 2026-07-01 --to 2026-07-07
 */

import TeslaFIAPI, { monthToDateRange } from "../dist/services/tesla-api.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--month") args.month = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
  }
  return args;
}

function resolveRange(args) {
  if (args.from || args.to) {
    return { dateFrom: args.from, dateTo: args.to };
  }
  if (args.month) {
    const [y, m] = args.month.split("-").map(Number);
    if (!y || !m) {
      throw new Error(`Invalid --month "${args.month}" (expected YYYY-MM)`);
    }
    return monthToDateRange(y, m);
  }
  const now = new Date();
  return monthToDateRange(now.getFullYear(), now.getMonth() + 1);
}

function printKeys(label, record) {
  if (!record || typeof record !== "object") {
    console.log(`  (no ${label} record)`);
    return;
  }
  const keys = Object.keys(record).sort();
  console.log(`  ${keys.length} fields: ${keys.join(", ")}`);
}

function printSample(label, record) {
  console.log(`\n  Sample ${label} record (raw JSON):`);
  console.log(
    JSON.stringify(record, null, 2)
      .split("\n")
      .map((l) => "    " + l)
      .join("\n")
  );
}

async function main() {
  const token = process.env.TESLA_API_TOKEN || process.env.TESLAFI_API_TOKEN;
  if (!token) {
    console.error(
      "ERROR: set TESLA_API_TOKEN (or TESLAFI_API_TOKEN) before running."
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const range = resolveRange(args);
  const api = new TeslaFIAPI(token);

  console.log("=".repeat(70));
  console.log("TeslaFi inspection");
  console.log(`Date range: ${range.dateFrom} .. ${range.dateTo}`);
  console.log("=".repeat(70));

  // 1) Current / last-good data (feed.php)
  console.log("\n[1] feed.php — lastGood (live/last-known data)");
  try {
    const current = await api.getLastGoodData();
    printKeys("data", current);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }

  // 2) Drives (history.php)
  console.log("\n[2] history.php — drives");
  let firstDrive;
  try {
    const drives = await api.getDrives(range);
    console.log(`  Returned ${drives.length} drive record(s).`);
    if (drives.length > 0) {
      firstDrive = drives[0];
      printKeys("drive", firstDrive);
      printSample("drive", firstDrive);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }

  // 2b) Show how the MCP server normalizes a drive into a Trip
  if (firstDrive) {
    console.log("\n[2b] Normalized Trip (what the analysis tools see):");
    try {
      const [y, m] = range.dateFrom.split("-").map(Number);
      const trips = await api.getTripsForMonth(y, m);
      if (trips.length > 0) {
        const { raw, ...trip } = trips[0];
        console.log(
          JSON.stringify(trip, null, 2)
            .split("\n")
            .map((l) => "    " + l)
            .join("\n")
        );
        console.log(
          "\n  If start_location/end_location/distance/duration look wrong above,"
        );
        console.log(
          "  the raw field names differ — adjust normalizeDrive() or open an issue."
        );
      }
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }
  }

  // 3) Charges (history.php)
  console.log("\n[3] history.php — charges");
  try {
    const charges = await api.getCharges(range);
    console.log(`  Returned ${charges.length} charge record(s).`);
    if (charges.length > 0) {
      printKeys("charge", charges[0]);
      printSample("charge", charges[0]);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
