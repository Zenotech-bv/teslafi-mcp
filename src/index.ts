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
 *   TESLAFI_CACHE_TTL_SECONDS               - Optional. In-memory history cache
 *     TTL in seconds (default: 60). Memory only - nothing is written to disk.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import TeslaFIAPI, { TeslaFiRecord } from "./services/tesla-api.js";
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
  version: "2.1.0"
});

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
  const value = (process.env.TESLAFI_ENABLE_COMMANDS ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
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

/** Compact summary of a raw TeslaFi drive record (mirrors the markdown view). */
function summarizeDrive(d: TeslaFiRecord) {
  return {
    id: d.id ?? null,
    date: firstNonEmpty(d.date, d.startDate),
    start_location: d.startingLocationName || d.startingAddress || "Unknown",
    end_location: d.locationName || d.address || "Unknown",
    distance_km: firstNonEmpty(d.kilometers),
    distance_mi: firstNonEmpty(d.miles)
  };
}

/** Compact summary of a raw TeslaFi charge record (mirrors the markdown view). */
function summarizeCharge(c: TeslaFiRecord) {
  return {
    id: c.id ?? null,
    date: firstNonEmpty(c.date, c.startDate),
    location: c.locationName || c.address || "Unknown",
    energy_added_kwh: firstNonEmpty(
      c.totalEnergyAdded,
      c.energyAdded,
      c.chargerKWH
    )
  };
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
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

Returns: total_trips, home_to_work_trips, work_to_home_trips, other_trips, and matching trips
(the matched-trip list is capped at 500 entries).

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

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(result, null, 2), result);
      }

      const lines = [
        `# Trip Analysis: ${monthName(params.year, params.month)}`,
        "",
        `## Summary`,
        `- **Total Trips**: ${result.total_trips}`,
        `- **Home → Work**: ${result.home_to_work_trips}`,
        `- **Work → Home**: ${result.work_to_home_trips}`,
        `- **Other Trips**: ${result.other_trips}`,
        ""
      ];

      if (result.trips.length > 0) {
        lines.push(`## Commute Trips (${result.trips.length})`, "");
        for (const trip of result.trips) {
          lines.push(`- **${trip.start_location}** → **${trip.end_location}**`);
          lines.push(`  - Date: ${new Date(trip.start_date).toLocaleString()}`);
          lines.push(`  - Distance: ${trip.distance.toFixed(1)} ${trip.distance_unit}`);
          lines.push(`  - Duration: ${trip.duration_minutes} minutes`);
          lines.push("");
        }
        if (result.trips_truncated) {
          lines.push(
            `*Matched-trip list truncated to the first ${result.trips.length} trips; ` +
              `the summary counts above cover the full month.*`,
            ""
          );
        }
      } else {
        lines.push(
          `No commute trips found matching "${params.home_location}" → "${params.work_location}".`
        );
      }

      return toolResult(lines.join("\n"), result);
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

Each trip includes start/end locations, distance, and duration. Raw TeslaFi records
are only embedded when include_raw is true.

Args:
  - year (number): Calendar year (e.g., 2026)
  - month (number): Calendar month (1-12)
  - limit (number): Max trips to return (1-500, default: 50)
  - offset (number): Skip first N trips for pagination (default: 0)
  - include_raw (boolean): Embed raw TeslaFi records (default: false)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

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
      const paginated = trips.slice(params.offset, params.offset + params.limit);

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
        trips: paginated
      };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const lines = [
        `# Trips: ${monthName(params.year, params.month)}`,
        "",
        `**Total**: ${output.total_trips} | **Showing**: ${output.returned_trips}`,
        ""
      ];

      if (paginated.length === 0) {
        lines.push("No trips found for this month.");
      } else {
        for (const trip of paginated) {
          lines.push(`## Trip ${trip.id}`);
          lines.push(`- **From**: ${trip.start_location}`);
          lines.push(`- **To**: ${trip.end_location}`);
          lines.push(`- **Date**: ${new Date(trip.start_date).toLocaleString()}`);
          lines.push(`- **Distance**: ${trip.distance.toFixed(1)} ${trip.distance_unit}`);
          lines.push(`- **Duration**: ${trip.duration_minutes} minutes`);
          lines.push("");
        }
      }

      if (output.has_more) {
        lines.push(
          `*More results available. Use offset=${output.next_offset} to see more.*`
        );
      }

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

      const output = { count: locations.length, locations };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const lines = ["# Known Locations", ""];
      if (locations.length === 0) {
        lines.push("No named locations found in drive history for this range.");
      } else {
        for (const loc of locations) {
          lines.push(
            `- **${loc.name}** — ${loc.visits} visits (${loc.as_start} starts, ${loc.as_end} ends)`
          );
        }
      }

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

Returns state, battery, range, charging, climate, and location fields.

Args:
  - source (string): 'current' (latest, may be sparse while the car sleeps),
    'lastGood' (last point with full charge data), or 'lastGoodTemp' (last point with temperatures).
    Default: 'current'.
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

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(data, null, 2), data);
      }

      const pick = (key: string) =>
        data[key] === undefined || data[key] === null || data[key] === ""
          ? "—"
          : String(data[key]);

      const lines = [
        `# Vehicle Data (${params.source})`,
        "",
        `- **Name**: ${pick("display_name")}`,
        `- **State**: ${pick("state")} / ${pick("carState")}`,
        `- **Battery**: ${pick("battery_level")}% (usable ${pick("usable_battery_level")}%)`,
        `- **Est. range**: ${pick("est_battery_range")}`,
        `- **Charging**: ${pick("charging_state")} — added ${pick("charge_energy_added")} kWh @ ${pick("charger_power")} kW`,
        `- **Charge limit**: ${pick("charge_limit_soc")}%`,
        `- **Odometer**: ${pick("odometer")}`,
        `- **Location**: ${pick("location")} (${pick("latitude")}, ${pick("longitude")})`,
        `- **Speed**: ${pick("speed")} | **Shift**: ${pick("shift_state")}`,
        `- **Inside/Outside temp**: ${pick("inside_temp")} / ${pick("outside_temp")}`,
        `- **Locked**: ${pick("locked")} | **Sentry**: ${pick("sentry_mode")}`,
        `- **Data timestamp**: ${pick("Date")}`
      ];

      return toolResult(lines.join("\n"), data);
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

Returns compact drive summaries. Raw TeslaFi records are only embedded when
include_raw is true. Optionally filter by date range.

Args:
  - date_from (string, optional): Start date (YYYY-MM-DD)
  - date_to (string, optional): End date (YYYY-MM-DD)
  - limit (number): Max drives to return (1-500, default: 50)
  - offset (number): Skip first N for pagination (default: 0)
  - include_raw (boolean): Embed raw TeslaFi records (default: false)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

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
      const paginated = drives.slice(
        params.offset,
        params.offset + params.limit
      );
      const items = paginated.map((d) =>
        params.include_raw ? { ...summarizeDrive(d), raw: d } : summarizeDrive(d)
      );

      const output = {
        total: drives.length,
        returned: paginated.length,
        offset: params.offset,
        limit: params.limit,
        has_more: drives.length > params.offset + params.limit,
        drives: items
      };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const lines = [
        `# Drives`,
        "",
        `**Total**: ${output.total} | **Showing**: ${output.returned}`,
        ""
      ];
      if (paginated.length === 0) {
        lines.push("No drives found for this range.");
      } else {
        for (const d of paginated) {
          const start = d.startingLocationName || d.startingAddress || "Unknown";
          const end = d.locationName || d.address || "Unknown";
          const date = firstNonEmpty(d.date, d.startDate) ?? "";
          // Apply the empty-string convention: kilometers "" must fall
          // through to miles (a miles-unit account sends "" for kilometers).
          const km = firstNonEmpty(d.kilometers);
          const mi = firstNonEmpty(d.miles);
          const dist =
            km != null ? `${km} km` : mi != null ? `${mi} mi` : "—";
          lines.push(`- **${start}** → **${end}** — ${dist} (${date})`);
        }
      }
      if (output.has_more) {
        lines.push(
          "",
          `*More available. Use offset=${params.offset + params.limit}.*`
        );
      }

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

Returns compact charge summaries. Raw TeslaFi records are only embedded when
include_raw is true. Optionally filter by date range.

Args:
  - date_from (string, optional): Start date (YYYY-MM-DD)
  - date_to (string, optional): End date (YYYY-MM-DD)
  - limit (number): Max charges to return (1-500, default: 50)
  - offset (number): Skip first N for pagination (default: 0)
  - include_raw (boolean): Embed raw TeslaFi records (default: false)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

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
        charges: items
      };

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(output, null, 2), output);
      }

      const lines = [
        `# Charges`,
        "",
        `**Total**: ${output.total} | **Showing**: ${output.returned}`,
        ""
      ];
      if (paginated.length === 0) {
        lines.push("No charges found for this range.");
      } else {
        for (const c of paginated) {
          const loc = c.locationName || c.address || "Unknown";
          const date = firstNonEmpty(c.date, c.startDate) ?? "";
          const added =
            firstNonEmpty(c.totalEnergyAdded, c.energyAdded, c.chargerKWH) ??
            "—";
          lines.push(`- **${loc}** — +${added} kWh (${date})`);
        }
      }
      if (output.has_more) {
        lines.push(
          "",
          `*More available. Use offset=${params.offset + params.limit}.*`
        );
      }

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

Supported commands and parameters (validated locally; unknown commands and
parameters are rejected without a network call):
  - wake_up
  - door_lock / door_unlock
  - charge_start / charge_stop
  - charge_port_door_open / charge_port_door_close
  - set_charge_limit            params: { "charge_limit_soc": 80 }
  - set_charging_amps           params: { "charging_amps": 16 }
  - auto_conditioning_start / auto_conditioning_stop
  - set_temps                   params: { "temp": 21 } or { "driver_temp": 21, "passenger_temp": 21 }
  - set_preconditioning_max     params: { "statement": true }
  - set_sentry_mode             params: { "sentryMode": 1 }
  - steering_wheel_heater       params: { "statement": true }
  - honk / honk_horn / flash_lights

Args:
  - command (string): Command name from the list above (required)
  - params (object, optional): Command parameters (see above)
  - wake_seconds (number, optional): Wake the car first, waiting up to N seconds (1-120)
  - response_format (string): 'markdown' or 'json' (default: 'markdown')

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
        params.wake_seconds
      );

      if (params.response_format === "json") {
        return toolResult(JSON.stringify(result, null, 2), result);
      }

      const lines = [
        `# Command: ${params.command}`,
        "",
        "```json",
        JSON.stringify(result, null, 2),
        "```"
      ];
      return toolResult(lines.join("\n"), result);
    } catch (error) {
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

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log which configuration is active - never the token value itself.
    const tokenSource = process.env.TESLA_API_TOKEN
      ? "TESLA_API_TOKEN"
      : "TESLAFI_API_TOKEN";
    const commandState = commandsEnabled()
      ? "enabled (TESLAFI_ENABLE_COMMANDS)"
      : "disabled (read-only; set TESLAFI_ENABLE_COMMANDS=true to enable)";
    console.error(
      `TeslaFi MCP server running. Token source: ${tokenSource}. ` +
        `Vehicle commands: ${commandState}.`
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
