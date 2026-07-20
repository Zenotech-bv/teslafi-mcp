#!/usr/bin/env node
/**
 * MCP Server for TeslaFi
 *
 * Exposes the TeslaFi API to MCP clients:
 *   - Live / last-known vehicle data (feed.php)
 *   - Stored drive and charge history (history.php)
 *   - Home-to-work commute analysis built on drive history
 *   - Vehicle control commands (feed.php, opt-in)
 *
 * Environment variables:
 *   TESLA_API_TOKEN (or TESLAFI_API_TOKEN)  - Required. Your TeslaFi API token,
 *     generated at https://teslafi.com/api.php
 *   TESLAFI_ENABLE_COMMANDS                 - Optional. Set to "true" to enable
 *     the tesla_send_command tool. Off by default: the server is read-only
 *     out of the box.
 *   TESLAFI_UNITS                           - Optional. "metric" or "imperial"
 *     (case-insensitive) pins the default unit system for data-returning tools
 *     when a call does not pass `units`. Any other value (including the default
 *     "automatic") defers to the TeslaFi account's measure setting, then metric.
 *   TESLAFI_CACHE_TTL_SECONDS               - Optional. In-memory history cache
 *     TTL in seconds (default: 60). Memory only - nothing is written to disk.
 *   TESLAFI_CHECK_UPDATES                   - Optional. Set to "true" (or "1" /
 *     "yes") to opt in to a lightweight check for a newer GitHub release. Off
 *     by default: when unset/false NO GitHub request is ever made and the only
 *     network destination remains www.teslafi.com. When on, the server makes a
 *     single unauthenticated GET to api.github.com (no TeslaFi token or data
 *     sent) and, if a newer release exists, appends a one-line notice to
 *     data-tool markdown output once per session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import TeslaFIAPI, {
  envFlagEnabled,
  indicatesUnsentAsleep,
  normalizeFeedData,
  resolveUnits,
  selectDriveUnitFields,
  TeslaFiRecord,
  Trip,
  UnitSystem,
  UpdateChecker,
  VERSION
} from "./services/tesla-api.js";
import {
  AnalyzeHomeWorkTripsSchema,
  AnalyzeHomeWorkTripsInput,
  GetTripsForMonthSchema,
  GetTripsForMonthInput,
  GetLocationsSchema,
  GetLocationsInput,
  GetCurrentDataSchema,
  GetCurrentDataInput,
  GetDrivesSchema,
  GetDrivesInput,
  GetChargesSchema,
  GetChargesInput,
  SendCommandSchema,
  SendCommandInput
} from "./schemas.js";

// Initialize MCP server
const server = new McpServer({
  name: "teslafi-mcp",
  version: VERSION
});

/**
 * Opt-in update checker (off unless TESLAFI_CHECK_UPDATES is truthy). Exported
 * so tests can drive and reset it; the running server only fires it once at
 * startup and reads maybeUpdateNotice() synchronously in the data tools.
 */
export const updateChecker = new UpdateChecker(VERSION);

let teslaAPI: TeslaFIAPI;

// Initialize TeslaFi API with token from environment
function initializeTeslaAPI(): void {
  const token = process.env.TESLA_API_TOKEN || process.env.TESLAFI_API_TOKEN;
  if (!token) {
    throw new Error(
      "TESLA_API_TOKEN (or TESLAFI_API_TOKEN) environment variable is required. " +
        "Generate a token at https://teslafi.com/api.php"
    );
  }
  teslaAPI = new TeslaFIAPI(token);
}

/** Whether the tesla_send_command tool is enabled (off by default). */
function commandsEnabled(): boolean {
  return envFlagEnabled(process.env.TESLAFI_ENABLE_COMMANDS);
}

/**
 * The opt-in update notice as markdown lines to append (blank separator + the
 * one line), or an empty array. Off by default and shown at most once per
 * process; mirrors how the quota line is added to markdown output only (never
 * JSON), so JSON responses stay pure and parseable.
 */
function updateNoticeLines(): string[] {
  const notice = updateChecker.maybeUpdateNotice();
  return notice ? ["", notice] : [];
}

const COMMANDS_DISABLED_MESSAGE =
  "Vehicle commands are disabled: this server is read-only by default. " +
  'To enable the tesla_send_command tool, set the TESLAFI_ENABLE_COMMANDS environment variable to "true" ' +
  "(or turn on the 'Enable vehicle commands' setting in the extension configuration) and restart the server.";

/** Wrap a tool handler so thrown errors become a clean text response. */
function toolResult(textContent: string, structuredContent?: unknown) {
  return structuredContent === undefined
    ? { content: [{ type: "text" as const, text: textContent }] }
    : {
        content: [{ type: "text" as const, text: textContent }],
        structuredContent: structuredContent as Record<string, unknown>
      };
}

function errorResult(error: unknown) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  return toolResult(`Error: ${errorMsg}`);
}

/**
 * Render TeslaFi's embedded monthly quota counter ("tesla_request_counter",
 * present on command and data responses) as a concise markdown line, or null
 * when the field is absent or malformed. TeslaFi allows 500 command requests
 * and 50 wake requests per month, reset on the 1st. Never throws.
 */
function quotaLine(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const counter = (data as Record<string, unknown>).tesla_request_counter;
  if (counter === null || typeof counter !== "object" || Array.isArray(counter)) {
    return null;
  }
  const commands = Number((counter as Record<string, unknown>).commands);
  const wakes = Number((counter as Record<string, unknown>).wakes);
  if (!Number.isFinite(commands) || !Number.isFinite(wakes)) {
    return null;
  }
  return `Quota: ${commands}/500 commands, ${wakes}/50 wakes used this month`;
}

/** Warn when monthly usage reaches 80% of an allowance. */
const COMMAND_WARN_THRESHOLD = 400; // of 500 monthly command requests
const WAKE_WARN_THRESHOLD = 40; // of 50 monthly wake requests

/**
 * Warning lines for high monthly usage, based on the last-known
 * tesla_request_counter tracked by the API client (updated from every
 * response that carries one — command and data responses alike). Empty when
 * no counters have been seen or usage is below both thresholds.
 */
function quotaWarnings(): string[] {
  const usage = teslaAPI.getQuotaUsage();
  if (!usage) {
    return [];
  }
  const warnings: string[] = [];
  if (usage.commands >= COMMAND_WARN_THRESHOLD) {
    warnings.push(
      `WARNING: ${usage.commands}/500 monthly command requests used`
    );
  }
  if (usage.wakes >= WAKE_WARN_THRESHOLD) {
    warnings.push(`WARNING: ${usage.wakes}/50 monthly wake requests used`);
  }
  return warnings;
}

/**
 * Feedback appended when TeslaFi reports a command was not sent because the
 * vehicle was asleep with noWake in effect (the wake-conserving default for
 * car commands).
 */
const ASLEEP_UNSENT_NOTE =
  "The command was NOT sent: the vehicle was asleep and noWake was in effect " +
  "(the default for car commands — a sleeping car is never woken implicitly). " +
  "Either retry with wake_seconds to wake the car first (this costs 1 of the " +
  "50 monthly wake requests), or wait until the car is awake and send the " +
  "command again.";

function monthName(year: number, month: number): string {
  return new Date(year, month - 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric"
  });
}

/**
 * First value that is not undefined, null, or an empty string, else null.
 * TeslaFi frequently returns "" for absent fields (e.g. date vs startDate,
 * totalEnergyAdded vs chargerKWH), so nullish coalescing alone would let an
 * empty string mask a populated fallback field.
 */
function firstNonEmpty(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Units helpers (shared by the renderers)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective unit system for a tool call: explicit `units` arg,
 * then TESLAFI_UNITS, then the account measure remembered from the last feed
 * response, then metric.
 */
function resolveToolUnits(explicit?: string): UnitSystem {
  return resolveUnits(
    explicit,
    process.env.TESLAFI_UNITS,
    teslaAPI.getAccountMeasure()
  );
}

const DASH = "—";

/** Format a plain (non-physical) field, or a dash when empty. */
function fStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return v === undefined || v === null || v === "" ? DASH : String(v);
}

/** Format a single-unit physical field ("72 %", "18.6 kWh"), or a dash. */
function fSingle(
  obj: Record<string, unknown>,
  key: string,
  unit: string
): string {
  const v = obj[key];
  return v === undefined || v === null ? DASH : `${v} ${unit}`;
}

/**
 * Format a dual-system physical field from its unit-suffixed keys, honoring
 * the applied system: one value for metric/imperial, both (joined by " / ")
 * for "both". Absent values render as a dash — never a bare number.
 */
function fDual(
  obj: Record<string, unknown>,
  base: string,
  units: UnitSystem,
  metricSuffix: string,
  metricUnit: string,
  imperialSuffix: string,
  imperialUnit: string
): string {
  const parts: string[] = [];
  if (units !== "imperial") {
    const v = obj[`${base}_${metricSuffix}`];
    parts.push(v === undefined || v === null ? DASH : `${v} ${metricUnit}`);
  }
  if (units !== "metric") {
    const v = obj[`${base}_${imperialSuffix}`];
    parts.push(v === undefined || v === null ? DASH : `${v} ${imperialUnit}`);
  }
  return parts.join(" / ");
}

/** Distance markdown from an object carrying distance_km / distance_mi. */
function distanceMd(obj: Record<string, unknown>, units: UnitSystem): string {
  return fDual(obj, "distance", units, "km", "km", "mi", "mi");
}

/** Extract a YYYY-MM-DD prefix from a TeslaFi timestamp or ISO string. */
function ymd(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const match = String(value).trim().match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

interface DateRange {
  earliest: string | null;
  latest: string | null;
}

/**
 * Compute the earliest/latest record date across the FULL fetched dataset
 * (before any pagination slicing). No extra network call is made — this only
 * scans records already fetched for the query.
 */
function computeDateRange(
  records: TeslaFiRecord[],
  getDate: (r: TeslaFiRecord) => unknown
): DateRange {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const record of records) {
    const day = ymd(getDate(record));
    if (!day) {
      continue;
    }
    if (earliest === null || day < earliest) {
      earliest = day;
    }
    if (latest === null || day > latest) {
      latest = day;
    }
  }
  return { earliest, latest };
}

/**
 * A short, honest note so a client cannot mislabel a partial history fetch as
 * a lifetime figure. `what` names the record kind; `excludes` is the quantity
 * ("distance" / "energy") that predates the TeslaFi join date.
 */
function coverageNote(
  what: string,
  earliest: string | null,
  excludes: string
): string {
  const e = earliest ?? "unknown";
  return (
    `TeslaFi history covers only ${what} since you joined TeslaFi ` +
    `(earliest record here: ${e}). A 'lifetime' figure derived from these ` +
    `records excludes any ${excludes} before that date.`
  );
}

/** Compact summary of a raw TeslaFi drive record (mirrors the markdown view). */
function summarizeDrive(d: TeslaFiRecord, units: UnitSystem) {
  return {
    id: d.id ?? null,
    date: firstNonEmpty(d.date, d.startDate),
    start_location: d.startingLocationName || d.startingAddress || "Unknown",
    end_location: d.locationName || d.address || "Unknown",
    // Per-system physical fields selected from TeslaFi's pre-existing fields.
    ...selectDriveUnitFields(d, units)
  };
}

/** Compact summary of a raw TeslaFi charge record (mirrors the markdown view). */
function summarizeCharge(c: TeslaFiRecord) {
  return {
    id: c.id ?? null,
    date: firstNonEmpty(c.date, c.startDate),
    location: c.locationName || c.address || "Unknown",
    // kWh is never converted between systems — only the unit label is fixed.
    energy_added_kwh: firstNonEmpty(
      c.totalEnergyAdded,
      c.energyAdded,
      c.chargerKWH
    )
  };
}

/**
 * Present a normalized Trip for output in the chosen system: physical distance
 * is emitted with explicit unit suffix(es), never as a bare number.
 */
function presentTrip(t: Trip, units: UnitSystem): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: t.id,
    start_date: t.start_date,
    end_date: t.end_date,
    start_location: t.start_location,
    end_location: t.end_location,
    duration_minutes: t.duration_minutes
  };
  if (units !== "imperial") {
    o.distance_km = t.distance_km ?? null;
  }
  if (units !== "metric") {
    o.distance_mi = t.distance_mi ?? null;
  }
  if (t.raw !== undefined) {
    o.raw = t.raw;
  }
  return o;
}

/**
 * Tool: Analyze home-to-work trips for a calendar month
 */
server.registerTool(
  "tesla_analyze_home_work_trips",
  {
    title: "Analyze Home-to-Work Trips",
    description: `Analyze TeslaFi drive history to count commutes between home and work in a calendar month.

Identifies drives that start at a home location and end at a work location (or vice versa),
matching location names loosely (case-insensitive substring match).

Args:
  - year (number): Calendar year (e.g., 2026)
  - month (number): Calendar month (1-12, e.g., 7 for July)
  - home_location (string): Name of home location as it appears in TeslaFi (e.g., "Home")
  - work_location (string): Name of work location (e.g., "Acme HQ")
  - units (string): 'metric' | 'imperial' | 'both' for the distances (default: resolved
    from TESLAFI_UNITS, then your account measure setting, else metric)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Returns: total_trips, home_to_work_trips, work_to_home_trips, other_trips, and matching trips
(the matched-trip list is capped at 500 entries). Trip distances carry explicit unit fields
(distance_km / distance_mi).

Example: "Analyze trips from Home to Acme HQ for July 2026"`,
    inputSchema: AnalyzeHomeWorkTripsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params: AnalyzeHomeWorkTripsInput) => {
    try {
      const result = await teslaAPI.analyzeHomeWorkTrips(
        params.year,
        params.month,
        params.home_location,
        params.work_location
      );
      const units = resolveToolUnits(params.units);
      const trips = result.trips.map((t) => presentTrip(t, units));
      const output = { ...result, units, trips };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const lines = [
        `# Trip Analysis: ${monthName(params.year, params.month)}`,
        "",
        `**Units**: ${units}`,
        "",
        `## Summary`,
        `- **Total Trips**: ${result.total_trips}`,
        `- **Home → Work**: ${result.home_to_work_trips}`,
        `- **Work → Home**: ${result.work_to_home_trips}`,
        `- **Other Trips**: ${result.other_trips}`,
        ""
      ];

      if (trips.length > 0) {
        lines.push(`## Commute Trips (${trips.length})`, "");
        for (const trip of trips) {
          lines.push(`- **${trip.start_location}** → **${trip.end_location}**`);
          lines.push(
            `  - Date: ${new Date(String(trip.start_date)).toLocaleString()}`
          );
          lines.push(`  - Distance: ${distanceMd(trip, units)}`);
          lines.push(`  - Duration: ${trip.duration_minutes} minutes`);
          lines.push("");
        }
        if (result.trips_truncated) {
          lines.push(
            `*Matched-trip list truncated to the first ${trips.length} trips; ` +
              `the summary counts above cover the full month.*`,
            ""
          );
        }
      } else {
        lines.push(
          `No commute trips found matching "${params.home_location}" → "${params.work_location}".`
        );
      }

      lines.push(...updateNoticeLines());

      return toolResult(lines.join("\n"), output);
    } catch (error) {
      return errorResult(error);
    }
  }
);

/**
 * Tool: Get all trips for a calendar month
 */
server.registerTool(
  "tesla_get_trips_for_month",
  {
    title: "Get Trips for Month",
    description: `Retrieve all drives recorded in TeslaFi for a specific calendar month.

Each trip includes start/end locations, distance (with explicit unit fields), and duration.
Raw TeslaFi records are only embedded when include_raw is true.

Args:
  - year (number): Calendar year (e.g., 2026)
  - month (number): Calendar month (1-12)
  - limit (number): Max trips to return (1-500, default: 50)
  - offset (number): Skip first N trips for pagination (default: 0)
  - include_raw (boolean): Embed raw TeslaFi records (default: false)
  - units (string): 'metric' | 'imperial' | 'both' (default: resolved from TESLAFI_UNITS,
    then your account measure setting, else metric)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Also returns date_range and coverage_note describing which dates the fetched records
actually span, so a partial fetch is never mislabeled as "lifetime".

Example: "Show me all trips from July 2026"`,
    inputSchema: GetTripsForMonthSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params: GetTripsForMonthInput) => {
    try {
      const trips = await teslaAPI.getTripsForMonth(
        params.year,
        params.month,
        params.include_raw
      );
      const units = resolveToolUnits(params.units);
      const dateRange = computeDateRange(trips, (t) => t.start_date);
      const paginated = trips
        .slice(params.offset, params.offset + params.limit)
        .map((t) => presentTrip(t, units));

      const output = {
        year: params.year,
        month: params.month,
        total_trips: trips.length,
        returned_trips: paginated.length,
        offset: params.offset,
        limit: params.limit,
        has_more: trips.length > params.offset + params.limit,
        next_offset:
          trips.length > params.offset + params.limit
            ? params.offset + params.limit
            : undefined,
        units,
        date_range: dateRange,
        coverage_note: coverageNote("drives", dateRange.earliest, "distance"),
        trips: paginated
      };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const from = output.returned_trips > 0 ? params.offset + 1 : 0;
      const to = params.offset + output.returned_trips;
      const since = dateRange.earliest ? ` (since ${dateRange.earliest})` : "";
      const lines = [
        `# Trips: ${monthName(params.year, params.month)}`,
        "",
        `**${output.total_trips.toLocaleString("en-US")} trips on record${since}**; showing ${from}–${to}`,
        `**Units**: ${units}`,
        "",
        `*${output.coverage_note}*`,
        ""
      ];

      if (paginated.length === 0) {
        lines.push("No trips found for this month.");
      } else {
        for (const trip of paginated) {
          lines.push(`## Trip ${trip.id}`);
          lines.push(`- **From**: ${trip.start_location}`);
          lines.push(`- **To**: ${trip.end_location}`);
          lines.push(
            `- **Date**: ${new Date(String(trip.start_date)).toLocaleString()}`
          );
          lines.push(`- **Distance**: ${distanceMd(trip, units)}`);
          lines.push(`- **Duration**: ${trip.duration_minutes} minutes`);
          lines.push("");
        }
      }

      if (output.has_more) {
        lines.push(
          `*More results available. Use offset=${output.next_offset} to see more.*`
        );
      }

      lines.push(...updateNoticeLines());

      return toolResult(lines.join("\n"), output);
    } catch (error) {
      return errorResult(error);
    }
  }
);

/**
 * Tool: Get locations known from drive history
 */
server.registerTool(
  "tesla_get_locations",
  {
    title: "Get Known Locations",
    description: `List the locations recorded in your TeslaFi drive history.

Scans stored drives and returns unique named start/end locations with visit counts.
Use these names with tesla_analyze_home_work_trips.

Args:
  - date_from (string, optional): Only include drives on/after this date (YYYY-MM-DD)
  - date_to (string, optional): Only include drives on/before this date (YYYY-MM-DD)
  - units (string): 'metric' | 'imperial' | 'both'. Accepted for consistency and echoed
    in the response; visit counts are unitless, so it does not change the numbers.
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Example: "What locations does my car track?"`,
    inputSchema: GetLocationsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params: GetLocationsInput) => {
    try {
      const locations = await teslaAPI.getLocations({
        dateFrom: params.date_from,
        dateTo: params.date_to
      });
      const units = resolveToolUnits(params.units);

      const output = { count: locations.length, units, locations };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const lines = ["# Known Locations", "", `**Units**: ${units}`, ""];
      if (locations.length === 0) {
        lines.push("No named locations found in drive history for this range.");
      } else {
        for (const loc of locations) {
          lines.push(
            `- **${loc.name}** — ${loc.visits} visits (${loc.as_start} starts, ${loc.as_end} ends)`
          );
        }
      }

      lines.push(...updateNoticeLines());

      return toolResult(lines.join("\n"), output);
    } catch (error) {
      return errorResult(error);
    }
  }
);

/**
 * Tool: Get current / last-known vehicle data
 */
server.registerTool(
  "tesla_get_current_data",
  {
    title: "Get Current Vehicle Data",
    description: `Get live or last-known vehicle data from TeslaFi (feed.php).

Returns state, battery, range, charging, climate, and location fields. Physical quantities
carry explicit unit-suffixed field names (e.g. odometer_km / odometer_mi, inside_temp_c /
inside_temp_f, tpms_front_left_bar / tpms_front_left_psi). Live-feed numbers are Tesla-native
and are converted here to the chosen system.

Args:
  - source (string): 'current' (latest, may be sparse while the car sleeps),
    'lastGood' (last point with full charge data), or 'lastGoodTemp' (last point with temperatures).
    Default: 'current'.
  - units (string): 'metric' | 'imperial' | 'both' (default: resolved from TESLAFI_UNITS,
    then your account measure setting, else metric)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Example: "What's my car's battery level right now?"`,
    inputSchema: GetCurrentDataSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params: GetCurrentDataInput) => {
    try {
      const data = await teslaAPI.getCurrentData(params.source);
      // Resolve AFTER the fetch so this call's own account measure is available.
      const units = resolveToolUnits(params.units);
      const out = normalizeFeedData(data, units);

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(out, null, 2), out);
      }

      const lines = [
        `# Vehicle Data (${params.source})`,
        "",
        `**Units**: ${units}`,
        "",
        `- **Name**: ${fStr(out, "display_name")}`,
        `- **State**: ${fStr(out, "state")} / ${fStr(out, "carState")}`,
        `- **Battery**: ${fSingle(out, "battery_level_pct", "%")} (usable ${fSingle(
          out,
          "usable_battery_level_pct",
          "%"
        )})`,
        `- **Est. range**: ${fDual(out, "est_battery_range", units, "km", "km", "mi", "mi")}`,
        `- **Charging**: ${fStr(out, "charging_state")} — added ${fSingle(
          out,
          "charge_energy_added_kwh",
          "kWh"
        )} @ ${fSingle(out, "charger_power_kw", "kW")}`,
        `- **Charge limit**: ${fSingle(out, "charge_limit_soc_pct", "%")}`,
        `- **Odometer**: ${fDual(out, "odometer", units, "km", "km", "mi", "mi")}`,
        `- **Location**: ${fStr(out, "location")} (${fStr(out, "latitude")}, ${fStr(
          out,
          "longitude"
        )})`,
        `- **Speed**: ${fDual(out, "speed", units, "kmh", "km/h", "mph", "mph")} | **Shift**: ${fStr(
          out,
          "shift_state"
        )}`,
        `- **Inside/Outside temp**: ${fDual(
          out,
          "inside_temp",
          units,
          "c",
          "°C",
          "f",
          "°F"
        )} / ${fDual(out, "outside_temp", units, "c", "°C", "f", "°F")}`
      ];

      // Tyre pressures are only surfaced when the feed carried at least one.
      const tpmsBases = [
        ["tpms_front_left", "FL"],
        ["tpms_front_right", "FR"],
        ["tpms_rear_left", "RL"],
        ["tpms_rear_right", "RR"]
      ] as const;
      const hasTpms = tpmsBases.some(
        ([base]) =>
          out[`${base}_bar`] != null || out[`${base}_psi`] != null
      );
      if (hasTpms) {
        const parts = tpmsBases.map(
          ([base, label]) =>
            `${label} ${fDual(out, base, units, "bar", "bar", "psi", "psi")}`
        );
        lines.push(`- **Tyre pressures**: ${parts.join(" | ")}`);
      }

      lines.push(
        `- **Locked**: ${fStr(out, "locked")} | **Sentry**: ${fStr(out, "sentry_mode")}`,
        `- **Data timestamp**: ${fStr(out, "Date")}`
      );

      // Surface TeslaFi's monthly quota counter when the response embeds it
      // (it is part of `out`, so structured output carries it too).
      const quota = quotaLine(out);
      if (quota) {
        lines.push("", quota);
      }

      lines.push(...updateNoticeLines());

      return toolResult(lines.join("\n"), out);
    } catch (error) {
      return errorResult(error);
    }
  }
);

/**
 * Tool: Get stored drives
 */
server.registerTool(
  "tesla_get_drives",
  {
    title: "Get Drives",
    description: `Retrieve stored drive history from TeslaFi (history.php).

Returns compact drive summaries with explicit unit-suffixed fields (distance_km/distance_mi,
efficiency_wh_km/efficiency_wh_mi, speed_avg_kmh/speed_avg_mph, speed_max_*). Raw TeslaFi
records are only embedded when include_raw is true. Optionally filter by date range.

Args:
  - date_from (string, optional): Start date (YYYY-MM-DD)
  - date_to (string, optional): End date (YYYY-MM-DD)
  - limit (number): Max drives to return (1-500, default: 50)
  - offset (number): Skip first N for pagination (default: 0)
  - include_raw (boolean): Embed raw TeslaFi records (default: false)
  - units (string): 'metric' | 'imperial' | 'both' (default: resolved from TESLAFI_UNITS,
    then your account measure setting, else metric)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Also returns date_range and coverage_note: TeslaFi history only goes back to your join
date, so a "lifetime" total from these records excludes any distance before then.

Example: "Show my drives between 2026-07-01 and 2026-07-07"`,
    inputSchema: GetDrivesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params: GetDrivesInput) => {
    try {
      const drives = await teslaAPI.getDrives({
        dateFrom: params.date_from,
        dateTo: params.date_to
      });
      const units = resolveToolUnits(params.units);
      const dateRange = computeDateRange(drives, (d) =>
        firstNonEmpty(d.date, d.startDate)
      );
      const paginated = drives.slice(
        params.offset,
        params.offset + params.limit
      );
      const items = paginated.map((d) =>
        params.include_raw
          ? { ...summarizeDrive(d, units), raw: d }
          : summarizeDrive(d, units)
      );

      const output = {
        total: drives.length,
        returned: paginated.length,
        offset: params.offset,
        limit: params.limit,
        has_more: drives.length > params.offset + params.limit,
        units,
        date_range: dateRange,
        coverage_note: coverageNote("drives", dateRange.earliest, "distance"),
        drives: items
      };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const from = output.returned > 0 ? params.offset + 1 : 0;
      const to = params.offset + output.returned;
      const since = dateRange.earliest ? ` (since ${dateRange.earliest})` : "";
      const lines = [
        `# Drives`,
        "",
        `**${output.total.toLocaleString("en-US")} drives on record${since}**; showing ${from}–${to}`,
        `**Units**: ${units}`,
        "",
        `*${output.coverage_note}*`,
        ""
      ];
      if (paginated.length === 0) {
        lines.push("No drives found for this range.");
      } else {
        for (const d of items) {
          const start = d.start_location;
          const end = d.end_location;
          const date = d.date ?? "";
          lines.push(
            `- **${start}** → **${end}** — ${distanceMd(d, units)} (${date})`
          );
        }
      }
      if (output.has_more) {
        lines.push(
          "",
          `*More available. Use offset=${params.offset + params.limit}.*`
        );
      }

      lines.push(...updateNoticeLines());

      return toolResult(lines.join("\n"), output);
    } catch (error) {
      return errorResult(error);
    }
  }
);

/**
 * Tool: Get stored charges
 */
server.registerTool(
  "tesla_get_charges",
  {
    title: "Get Charges",
    description: `Retrieve stored charge history from TeslaFi (history.php).

Returns compact charge summaries (energy_added_kwh — kWh is never converted between systems).
Raw TeslaFi records are only embedded when include_raw is true. Optionally filter by date range.

Args:
  - date_from (string, optional): Start date (YYYY-MM-DD)
  - date_to (string, optional): End date (YYYY-MM-DD)
  - limit (number): Max charges to return (1-500, default: 50)
  - offset (number): Skip first N for pagination (default: 0)
  - include_raw (boolean): Embed raw TeslaFi records (default: false)
  - units (string): 'metric' | 'imperial' | 'both'. Charge energy is in kWh in either system;
    units is echoed in the response and applies to any raw distances you inspect.
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Also returns date_range and coverage_note: TeslaFi history only goes back to your join
date, so a "lifetime" total from these records excludes any energy before then.

Example: "How much did I charge in July 2026?"`,
    inputSchema: GetChargesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params: GetChargesInput) => {
    try {
      const charges = await teslaAPI.getCharges({
        dateFrom: params.date_from,
        dateTo: params.date_to
      });
      const units = resolveToolUnits(params.units);
      const dateRange = computeDateRange(charges, (c) =>
        firstNonEmpty(c.date, c.startDate)
      );
      const paginated = charges.slice(
        params.offset,
        params.offset + params.limit
      );
      const items = paginated.map((c) =>
        params.include_raw
          ? { ...summarizeCharge(c), raw: c }
          : summarizeCharge(c)
      );

      const output = {
        total: charges.length,
        returned: paginated.length,
        offset: params.offset,
        limit: params.limit,
        has_more: charges.length > params.offset + params.limit,
        units,
        date_range: dateRange,
        coverage_note: coverageNote(
          "charge sessions",
          dateRange.earliest,
          "energy"
        ),
        charges: items
      };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const from = output.returned > 0 ? params.offset + 1 : 0;
      const to = params.offset + output.returned;
      const since = dateRange.earliest ? ` (since ${dateRange.earliest})` : "";
      const lines = [
        `# Charges`,
        "",
        `**${output.total.toLocaleString("en-US")} charge sessions on record${since}**; showing ${from}–${to}`,
        `**Units**: ${units}`,
        "",
        `*${output.coverage_note}*`,
        ""
      ];
      if (paginated.length === 0) {
        lines.push("No charges found for this range.");
      } else {
        for (const c of items) {
          const loc = c.location;
          const date = c.date ?? "";
          const added = c.energy_added_kwh ?? null;
          lines.push(
            `- **${loc}** — ${added == null ? DASH : `+${added} kWh`} (${date})`
          );
        }
      }
      if (output.has_more) {
        lines.push(
          "",
          `*More available. Use offset=${params.offset + params.limit}.*`
        );
      }

      lines.push(...updateNoticeLines());

      return toolResult(lines.join("\n"), output);
    } catch (error) {
      return errorResult(error);
    }
  }
);

/**
 * Tool: Send a vehicle control command (opt-in via TESLAFI_ENABLE_COMMANDS)
 */
server.registerTool(
  "tesla_send_command",
  {
    title: "Send Vehicle Command",
    description: `Send a control command to the vehicle via TeslaFi (feed.php).

DISABLED by default: requires the TESLAFI_ENABLE_COMMANDS environment variable
set to "true" (the 'Enable vehicle commands' extension setting). The command
must also be enabled on the TeslaFi "Commands" tab (https://teslafi.com/api.php),
or it will fail. This changes vehicle state — use with care.

Supported commands and parameters, matching TeslaFi's official API
documentation (validated locally; unknown commands and parameters are
rejected without a network call):
  - wake                        (resume TeslaFi polling: idle timer 0, polling on)
  - wake_up                     (wake the vehicle)
  - sleep                       params: { "time": 30 } (optional, minutes for the sleep attempt)
  - enableLogging / disableLogging
  - command_count               (read-only: current command/wake quota usage)
  - honk / flash_lights
  - door_lock / door_unlock
  - charge_start / charge_stop
  - charge_port_door_open / charge_port_door_close
  - set_charge_limit            params: { "charge_limit_soc": 80 } (50-100)
  - set_charging_amps           params: { "charging_amps": 16 }
  - auto_conditioning_start / auto_conditioning_stop
  - set_temps                   params: { "temp": 21.5 } (Celsius, one decimal allowed)
  - seat_heater                 params: { "heater": 0, "level": 3 } (heater: 0=driver,
    1=passenger, 2=rear left, 4=rear center, 5=rear right — there is no 3;
    level: 0-3, 0=off; conditioning must be on first)
  - steering_wheel_heater       params: { "statement": true } (conditioning must be on first)
  - preset                      params: { "number": 1, "statement": true } (conditioning
    preset; statement=true emails a confirmation; the controls the preset
    drives must themselves be enabled)
  - set_preconditioning_max     params: { "statement": true } (Max Defrost; when
    turned off, conditioning remains on)
  - set_sentry_mode             params: { "sentryMode": true }

WAKE-CONSERVING DEFAULT: car commands (honk, lights, climate, charging,
locks, charge port, sentry) never wake a sleeping car unless you pass
wake_seconds or no_wake: false — with neither given, noWake=true is sent
automatically, and if the car is asleep the command is NOT sent (the output
says so and explains the options). Account-side commands (wake, wake_up,
sleep, enableLogging, disableLogging, command_count) are exempt and never
take noWake.

Args:
  - command (string): Command name from the list above (required)
  - params (object, optional): Command parameters (see above)
  - wake_seconds (number, optional): If the car is asleep, TeslaFi wakes it and
    waits up to N seconds (1-60, the official maximum) before the command.
    Costs a monthly wake request. Mutually exclusive with no_wake.
  - no_wake (boolean, optional): true sends TeslaFi's noWake=true (the command
    is NOT sent at all while the car sleeps) — already the default for car
    commands; false restores TeslaFi's own default (wake the car and pause up
    to 15s). Mutually exclusive with wake_seconds.
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Quotas: TeslaFi allows 500 command requests + 50 wake requests per month
(reset on the 1st). A command sent while the car is asleep costs 1 command +
1 wake; with the wake quota exhausted, the command is not sent and TeslaFi
returns an error — surfaced here as a terminal, actionable message (never
retried). Responses embed a tesla_request_counter object, surfaced as a
"Quota: ..." line; at >= 400/500 commands or >= 40/50 wakes a WARNING line
is prepended to the output.

Example: "Set my charge limit to 80%" → command=set_charge_limit, params={charge_limit_soc:80}`,
    inputSchema: SendCommandSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params: SendCommandInput) => {
    try {
      if (!commandsEnabled()) {
        return toolResult(`Error: ${COMMANDS_DISABLED_MESSAGE}`);
      }

      const result = await teslaAPI.sendCommand(
        params.command,
        params.params ?? {},
        params.wake_seconds,
        params.no_wake
      );

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(result, null, 2), result);
      }

      const lines: string[] = [];
      // High-usage warnings come first (>= 400/500 commands or 40/50 wakes),
      // fed by the client's last-known counters across all responses.
      const warnings = quotaWarnings();
      if (warnings.length > 0) {
        lines.push(...warnings, "");
      }
      lines.push(`# Command: ${params.command}`, "");
      if (indicatesUnsentAsleep(result)) {
        lines.push(ASLEEP_UNSENT_NOTE, "");
      }
      lines.push("```json", JSON.stringify(result, null, 2), "```");
      // Surface TeslaFi's monthly quota counter when the response embeds it
      // (it is part of `result`, so structured output carries it too).
      const quota = quotaLine(result);
      if (quota) {
        lines.push("", quota);
      }
      return toolResult(lines.join("\n"), result);
    } catch (error) {
      // TeslaFi may report "asleep, not sent" as an error envelope rather
      // than a result object; keep the explanatory feedback in that shape too.
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (indicatesUnsentAsleep(errorMsg)) {
        return toolResult(`Error: ${errorMsg}\n\n${ASLEEP_UNSENT_NOTE}`);
      }
      return errorResult(error);
    }
  }
);

/**
 * Main function - start the MCP server
 */
async function main(): Promise<void> {
  try {
    initializeTeslaAPI();

    // Opt-in, fire-and-forget: kick off the update check at startup so the
    // one-line notice can be surfaced by the first data tool that runs. When
    // TESLAFI_CHECK_UPDATES is not truthy this makes no network request at all,
    // and it never rejects, so startup is unaffected either way.
    void updateChecker.checkForUpdate();

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log which configuration is active - never the token value itself.
    const tokenSource = process.env.TESLA_API_TOKEN
      ? "TESLA_API_TOKEN"
      : "TESLAFI_API_TOKEN";
    const commandState = commandsEnabled()
      ? "enabled (TESLAFI_ENABLE_COMMANDS)"
      : "disabled (read-only; set TESLAFI_ENABLE_COMMANDS=true to enable)";
    const updateCheckState = envFlagEnabled(process.env.TESLAFI_CHECK_UPDATES)
      ? "enabled (TESLAFI_CHECK_UPDATES; unauthenticated api.github.com, no TeslaFi data)"
      : "disabled";
    console.error(
      `TeslaFi MCP server running. Token source: ${tokenSource}. ` +
        `Vehicle commands: ${commandState}. Update check: ${updateCheckState}.`
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Server error: ${errorMsg}`);
    process.exit(1);
  }
}

main().catch((error) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${errorMsg}`);
  process.exit(1);
});
