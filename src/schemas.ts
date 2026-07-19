import { z } from "zod";
import { TESLAFI_COMMAND_NAMES } from "./services/tesla-api.js";

/** Reusable output-format field. */
const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Output format: 'markdown' for human-readable or 'json' for machine-readable"
  );

/** Reusable YYYY-MM-DD date field. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

/** Reusable include-raw field: raw TeslaFi records are omitted by default. */
const includeRaw = z
  .boolean()
  .default(false)
  .describe(
    "Include the raw TeslaFi records in the response (default: false). " +
      "Raw records are large; only request them when needed."
  );

/**
 * Schema for analyzing home-to-work trips in a calendar month
 */
export const AnalyzeHomeWorkTripsSchema = z
  .object({
    year: z.number().int().min(2015).max(2100).describe("Year (e.g., 2026)"),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe("Month (1-12, e.g., 7 for July)"),
    home_location: z
      .string()
      .min(1)
      .max(100)
      .describe("Name of home location (e.g., 'Home')"),
    work_location: z
      .string()
      .min(1)
      .max(100)
      .describe("Name of work location (e.g., 'Acme HQ')"),
    response_format: responseFormat
  })
  .strict();

export type AnalyzeHomeWorkTripsInput = z.infer<
  typeof AnalyzeHomeWorkTripsSchema
>;

/**
 * Schema for getting detailed trip information for a specific month
 */
export const GetTripsForMonthSchema = z
  .object({
    year: z.number().int().min(2015).max(2100).describe("Year (e.g., 2026)"),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe("Month (1-12, e.g., 7 for July)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum number of trips to return (1-500, default: 50)"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of trips to skip for pagination (default: 0)"),
    include_raw: includeRaw,
    response_format: responseFormat
  })
  .strict();

export type GetTripsForMonthInput = z.infer<typeof GetTripsForMonthSchema>;

/**
 * Schema for getting available locations from TeslaFi drive history
 */
export const GetLocationsSchema = z
  .object({
    date_from: isoDate
      .optional()
      .describe("Only include drives on/after this date (YYYY-MM-DD)"),
    date_to: isoDate
      .optional()
      .describe("Only include drives on/before this date (YYYY-MM-DD)"),
    response_format: responseFormat
  })
  .strict();

export type GetLocationsInput = z.infer<typeof GetLocationsSchema>;

/**
 * Schema for getting current / last-known vehicle data (feed.php)
 */
export const GetCurrentDataSchema = z
  .object({
    source: z
      .enum(["current", "lastGood", "lastGoodTemp"])
      .default("current")
      .describe(
        "Which data point to fetch: 'current' (latest, may be sparse while sleeping), " +
          "'lastGood' (last point with full charge data), or 'lastGoodTemp' (last point with temperatures)"
      ),
    response_format: responseFormat
  })
  .strict();

export type GetCurrentDataInput = z.infer<typeof GetCurrentDataSchema>;

/**
 * Schema for retrieving stored drives (history.php)
 */
export const GetDrivesSchema = z
  .object({
    date_from: isoDate
      .optional()
      .describe("Only include drives on/after this date (YYYY-MM-DD)"),
    date_to: isoDate
      .optional()
      .describe("Only include drives on/before this date (YYYY-MM-DD)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum number of drives to return (1-500, default: 50)"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of drives to skip for pagination (default: 0)"),
    include_raw: includeRaw,
    response_format: responseFormat
  })
  .strict();

export type GetDrivesInput = z.infer<typeof GetDrivesSchema>;

/**
 * Schema for retrieving stored charges (history.php)
 */
export const GetChargesSchema = z
  .object({
    date_from: isoDate
      .optional()
      .describe("Only include charges on/after this date (YYYY-MM-DD)"),
    date_to: isoDate
      .optional()
      .describe("Only include charges on/before this date (YYYY-MM-DD)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum number of charges to return (1-500, default: 50)"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of charges to skip for pagination (default: 0)"),
    include_raw: includeRaw,
    response_format: responseFormat
  })
  .strict();

export type GetChargesInput = z.infer<typeof GetChargesSchema>;

/**
 * Schema for sending a vehicle control command (feed.php)
 */
export const SendCommandSchema = z
  .object({
    command: z
      .enum(TESLAFI_COMMAND_NAMES)
      .describe(
        "TeslaFi command name (must be one of the supported commands): " +
          `${TESLAFI_COMMAND_NAMES.join(", ")}. ` +
          "Must also be enabled on the TeslaFi Commands tab."
      ),
    params: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        "Extra command parameters, validated per command. Examples: " +
          "{ \"charge_limit_soc\": 80 } for set_charge_limit, " +
          "{ \"charging_amps\": 16 } for set_charging_amps, " +
          "{ \"temp\": 21 } (or driver_temp/passenger_temp) for set_temps, " +
          "{ \"sentryMode\": 1 } for set_sentry_mode, " +
          "{ \"statement\": true } for steering_wheel_heater and set_preconditioning_max. " +
          "Unknown keys are rejected."
      ),
    wake_seconds: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "If set, TeslaFi wakes the car first and waits up to this many seconds before the command"
      ),
    response_format: responseFormat
  })
  .strict();

export type SendCommandInput = z.infer<typeof SendCommandSchema>;
