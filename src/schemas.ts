import { z } from "zod";
import {
  MAX_WAKE_SECONDS,
  TESLAFI_COMMAND_NAMES
} from "./services/tesla-api.js";

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
          "{ \"charge_limit_soc\": 80 } for set_charge_limit (50-100), " +
          "{ \"charging_amps\": 16 } for set_charging_amps, " +
          "{ \"temp\": 21.5 } for set_temps (Celsius, one decimal allowed), " +
          "{ \"heater\": 0, \"level\": 3 } for seat_heater (heater: 0=driver, " +
          "1=passenger, 2=rear left, 4=rear center, 5=rear right - there is " +
          "no 3; level: 0-3, 0=off), " +
          "{ \"number\": 1, \"statement\": true } for preset, " +
          "{ \"time\": 30 } for sleep (minutes), " +
          "{ \"sentryMode\": true } for set_sentry_mode, " +
          "{ \"statement\": true } for steering_wheel_heater and set_preconditioning_max. " +
          "Unknown keys are rejected."
      ),
    wake_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_WAKE_SECONDS)
      .optional()
      .describe(
        "If the car is asleep, TeslaFi sends a wake and pauses up to this " +
          `many seconds (1-${MAX_WAKE_SECONDS}, the official maximum) before ` +
          "the command. Costs 1 of the 50 monthly wake requests, and is the " +
          "only way a car command will wake a sleeping car (see no_wake). " +
          "Mutually exclusive with no_wake."
      ),
    no_wake: z
      .boolean()
      .optional()
      .describe(
        "If true, the command is NOT sent at all when the vehicle is " +
          "sleeping (TeslaFi's noWake=true). This is already the DEFAULT " +
          "for car commands: car commands never wake a sleeping car unless " +
          "you pass wake_seconds or no_wake: false (which restores " +
          "TeslaFi's own default of waking the car and pausing up to 15s). " +
          "Not applicable to the account-side commands wake, wake_up, " +
          "sleep, enableLogging, disableLogging, and command_count. " +
          "Mutually exclusive with wake_seconds."
      ),
    response_format: responseFormat
  })
  .strict();

export type SendCommandInput = z.infer<typeof SendCommandSchema>;
