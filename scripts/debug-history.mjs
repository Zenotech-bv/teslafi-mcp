#!/usr/bin/env node
/**
 * Raw diagnostic for TeslaFi history.php.
 *
 * Bypasses the MCP client's parsing and prints exactly what TeslaFi returns,
 * across a few parameter variants, so we can see why drives/charges came back
 * empty.
 *
 * Usage:
 *   TESLA_API_TOKEN=xxxx node scripts/debug-history.mjs
 */

import axios from "axios";

const token = process.env.TESLA_API_TOKEN || process.env.TESLAFI_API_TOKEN;
if (!token) {
  console.error("ERROR: set TESLA_API_TOKEN (or TESLAFI_API_TOKEN).");
  process.exit(1);
}

const HISTORY = "https://www.teslafi.com/history.php";
const FEED = "https://www.teslafi.com/feed.php";

async function hit(label, url, params) {
  console.log("\n" + "-".repeat(70));
  console.log(label);
  console.log("params:", JSON.stringify({ ...params, token: "<redacted>" }));
  try {
    const res = await axios.get(url, {
      params,
      timeout: 30000,
      // Same hardening as the real client (src/services/tesla-api.ts):
      // never follow redirects (a 3xx could re-send the token-bearing URL
      // elsewhere) and never route through HTTP(S)_PROXY env proxies.
      maxRedirects: 0,
      proxy: false,
      // Accept any status so we can see error bodies too.
      validateStatus: () => true,
      // Don't let axios auto-parse, so we see the raw text shape.
      transformResponse: [(d) => d]
    });
    console.log("HTTP", res.status, "| content-type:", res.headers["content-type"]);
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    console.log("body length:", body.length);
    console.log("body (first 1200 chars):");
    console.log(body.slice(0, 1200));
    // Try to interpret as JSON
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json)) {
        console.log(`=> parsed JSON array, length ${json.length}`);
      } else if (json && typeof json === "object") {
        console.log("=> parsed JSON object, top-level keys:", Object.keys(json).join(", "));
      }
    } catch {
      console.log("=> body is NOT valid JSON (likely HTML or a plain message)");
    }
  } catch (err) {
    console.log("REQUEST FAILED:", err.message);
  }
}

// 1) Sanity: feed.php with token works (we know it does) — confirms auth style.
await hit("[A] feed.php command=lastGood (auth sanity check)", FEED, {
  token,
  command: "lastGood"
});

// 2) drives, no date filter at all
await hit("[B] history.php command=drives (no dates)", HISTORY, {
  token,
  command: "drives"
});

// 3) drives, current-month range (what the MCP server sends)
await hit("[C] history.php command=drives + dateFrom/dateTo", HISTORY, {
  token,
  command: "drives",
  dateFrom: "2026-07-01",
  dateTo: "2026-07-31"
});

// 4) drives, very wide range
await hit("[D] history.php command=drives + wide range", HISTORY, {
  token,
  command: "drives",
  dateFrom: "2025-01-01",
  dateTo: "2026-12-31"
});

// 5) charges, no date filter
await hit("[E] history.php command=charges (no dates)", HISTORY, {
  token,
  command: "charges"
});

console.log("\nDone.");
