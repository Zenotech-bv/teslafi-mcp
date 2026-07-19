import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";

const TESLAFI_FEED_URL = "https://www.teslafi.com/feed.php";
const TESLAFI_HISTORY_URL = "https://www.teslafi.com/history.php";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
/** Hard cap on live history-cache entries, regardless of TTL. */
const MAX_CACHE_ENTRIES = 50;
const MIN_REQUEST_SPACING_MS = 1000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 60000;

/**
 * Allowlist of TeslaFi feed.php commands and the extra query parameters each
 * command accepts. Unknown commands and unknown parameter keys are rejected
 * locally, before any network request is made.
 *
 * Sources: the official list at https://teslafi.com/api.php requires a login,
 * so this set was verified against the ha-teslafi Home Assistant integration
 * (github.com/jhansche/ha-teslafi), plus the commands this codebase had
 * previously confirmed against a live TeslaFi account (set_sentry_mode,
 * honk_horn, driver_temp/passenger_temp for set_temps).
 */
export const TESLAFI_COMMAND_PARAMS = {
  wake_up: [],
  honk: [],
  honk_horn: [],
  flash_lights: [],
  door_lock: [],
  door_unlock: [],
  charge_start: [],
  charge_stop: [],
  charge_port_door_open: [],
  charge_port_door_close: [],
  set_charge_limit: ["charge_limit_soc"],
  set_charging_amps: ["charging_amps"],
  auto_conditioning_start: [],
  auto_conditioning_stop: [],
  set_temps: ["temp", "driver_temp", "passenger_temp"],
  set_preconditioning_max: ["statement"],
  set_sentry_mode: ["sentryMode"],
  steering_wheel_heater: ["statement"]
} as const;

export type TeslaFiCommand = keyof typeof TESLAFI_COMMAND_PARAMS;

export const TESLAFI_COMMAND_NAMES = Object.keys(TESLAFI_COMMAND_PARAMS) as [
  TeslaFiCommand,
  ...TeslaFiCommand[]
];

/** Query keys the caller may never supply directly. */
const RESERVED_PARAM_KEYS = new Set(["token", "command", "wake"]);

/** Normalized trip shape used by the commute-analysis tools. */
export interface Trip {
  id: number;
  start_date: string;
  end_date: string;
  start_location: string;
  end_location: string;
  distance: number;
  distance_unit: "km" | "mi";
  duration_minutes: number;
  /** The raw TeslaFi drive record; only included when explicitly requested. */
  raw?: TeslaFiRecord;
}

export interface TeslaFiRecord {
  [key: string]: any;
}

export type CurrentDataSource = "current" | "lastGood" | "lastGoodTemp";

export interface HistoryDateRange {
  /** Inclusive start date, format YYYY-MM-DD. */
  dateFrom?: string;
  /** Inclusive end date, format YYYY-MM-DD. */
  dateTo?: string;
}

export interface LocationSummary {
  name: string;
  visits: number;
  as_start: number;
  as_end: number;
}

/** Maximum matched trips embedded in a home/work analysis result. */
export const MAX_ANALYSIS_TRIPS = 500;

export interface HomeWorkAnalysis {
  total_trips: number;
  home_to_work_trips: number;
  work_to_home_trips: number;
  other_trips: number;
  trips: Trip[];
  /** True when the matched-trip list was capped at MAX_ANALYSIS_TRIPS. */
  trips_truncated: boolean;
}

interface HistoryCacheEntry {
  expires: number;
  promise: Promise<TeslaFiRecord[]>;
}

interface RequestContext {
  /** Human label for error messages, e.g. "drive history". */
  what: string;
  /** True when the request changes vehicle state (commands). */
  mutating: boolean;
  /** Effective request timeout, for timeout error messages. */
  timeoutMs: number;
}

/**
 * Client for the TeslaFi API.
 *
 * TeslaFi exposes two endpoints, both authenticated with your API token:
 *   - feed.php    : live/last-known vehicle data + vehicle control commands
 *   - history.php : stored drive and charge history
 *
 * The token is generated at https://teslafi.com/api.php. Control commands must
 * additionally be enabled on the "Commands" tab of that page or they return
 * "This command is not enabled".
 *
 * The client keeps a small in-memory TTL cache for history responses (never
 * written to disk), spaces outbound requests at least 1s apart, and retries
 * transient network failures with exponential backoff.
 */
class TeslaFIAPI {
  private apiToken: string;
  private cacheTtlMs: number;
  private historyCache = new Map<string, HistoryCacheEntry>();
  private lastRequestAt = 0;
  private requestGate: Promise<void> = Promise.resolve();

  constructor(apiToken: string) {
    this.apiToken = apiToken;
    // Treat unset, empty, and whitespace-only values as "not configured":
    // Number("") and Number("   ") are 0, which would otherwise silently
    // disable the cache instead of falling back to the default.
    const raw = process.env.TESLAFI_CACHE_TTL_SECONDS?.trim();
    const ttlSeconds = raw ? Number(raw) : NaN;
    this.cacheTtlMs =
      Number.isFinite(ttlSeconds) && ttlSeconds >= 0
        ? ttlSeconds * 1000
        : DEFAULT_CACHE_TTL_SECONDS * 1000;
  }

  // ---------------------------------------------------------------------------
  // feed.php — live / last-known data
  // ---------------------------------------------------------------------------

  /**
   * Get vehicle data from feed.php.
   *
   * @param source
   *   - "current"      : the latest data point (mostly empty while the car sleeps)
   *   - "lastGood"     : the last data point that contains full charge data
   *   - "lastGoodTemp" : the last data point that contains temperature data
   */
  async getCurrentData(
    source: CurrentDataSource = "current"
  ): Promise<TeslaFiRecord> {
    const command =
      source === "lastGood"
        ? "lastGood"
        : source === "lastGoodTemp"
          ? "lastGoodTemp"
          : "";

    const data = await this.feedRequest(command);

    // feed.php occasionally returns plain text (login page, error string)
    // instead of a JSON object. Surface that instead of rendering blanks.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(
        "TeslaFi feed.php returned " +
          (typeof data === "string"
            ? "plain text"
            : "an unexpected payload") +
          " instead of a vehicle data object. This usually means TeslaFi " +
          "rejected the request or is temporarily unavailable. Try again shortly."
      );
    }
    return data;
  }

  /** Convenience: the last data point with complete charge data. */
  async getLastGoodData(): Promise<TeslaFiRecord> {
    return this.getCurrentData("lastGood");
  }

  /** Convenience: the last data point with temperature data. */
  async getLastGoodTempData(): Promise<TeslaFiRecord> {
    return this.getCurrentData("lastGoodTemp");
  }

  // ---------------------------------------------------------------------------
  // feed.php — vehicle control commands
  // ---------------------------------------------------------------------------

  /**
   * Send a vehicle command through feed.php.
   *
   * The command must be in the local allowlist (TESLAFI_COMMAND_PARAMS) and
   * must be enabled on the TeslaFi "Commands" tab. Parameter keys are
   * validated per command; unknown or reserved keys are rejected before any
   * network request is made.
   *
   * @param command Command name (must be a known TeslaFi command).
   * @param params  Extra command parameters (e.g. { charge_limit_soc: 80 }).
   * @param wakeSeconds If set, TeslaFi will attempt to wake the car first and
   *   wait up to this many seconds before issuing the command. The request
   *   timeout is extended to cover this wait.
   */
  async sendCommand(
    command: string,
    params: Record<string, string | number | boolean> = {},
    wakeSeconds?: number
  ): Promise<TeslaFiRecord> {
    // Own-property check: a plain bracket lookup would resolve prototype-
    // inherited names ("constructor", "__proto__", "toString", ...) to truthy
    // values and let them slip past the allowlist as command names.
    const allowedParams = Object.prototype.hasOwnProperty.call(
      TESLAFI_COMMAND_PARAMS,
      command
    )
      ? (TESLAFI_COMMAND_PARAMS[command as TeslaFiCommand] as readonly string[])
      : undefined;
    if (!allowedParams) {
      throw new Error(
        `Unknown TeslaFi command "${command}". Supported commands: ` +
          `${TESLAFI_COMMAND_NAMES.join(", ")}.`
      );
    }

    const extra: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(params)) {
      if (RESERVED_PARAM_KEYS.has(key)) {
        throw new Error(
          `Parameter "${key}" is reserved and cannot be supplied directly.` +
            (key === "wake" ? " Use wake_seconds instead." : "")
        );
      }
      if (!allowedParams.includes(key)) {
        throw new Error(
          `Parameter "${key}" is not valid for command "${command}". ` +
            (allowedParams.length > 0
              ? `Valid parameters: ${allowedParams.join(", ")}.`
              : "This command takes no parameters.")
        );
      }
      extra[key] = value;
    }

    if (typeof wakeSeconds === "number" && wakeSeconds > 0) {
      extra.wake = wakeSeconds;
    }
    const data = await this.feedRequest(command, extra, wakeSeconds);

    // Like getCurrentData: feed.php occasionally returns plain text (login
    // page, error string) instead of a JSON object. Surface that as an error
    // instead of framing a malformed response as a successful command result.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(
        "TeslaFi feed.php returned " +
          (typeof data === "string"
            ? "plain text"
            : "an unexpected payload") +
          ` instead of a result object for command "${command}". The command ` +
          "may still have been executed by TeslaFi - check the vehicle state " +
          "before retrying."
      );
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // history.php — drives & charges
  // ---------------------------------------------------------------------------

  /**
   * Get stored drives from history.php, optionally filtered by date range.
   * Returns the raw TeslaFi drive records (fields vary by account).
   */
  async getDrives(range: HistoryDateRange = {}): Promise<TeslaFiRecord[]> {
    return this.historyRequest("drives", range);
  }

  /**
   * Get stored charges from history.php, optionally filtered by date range.
   * Returns the raw TeslaFi charge records (fields vary by account).
   */
  async getCharges(range: HistoryDateRange = {}): Promise<TeslaFiRecord[]> {
    return this.historyRequest("charges", range);
  }

  /**
   * Get drives for a specific calendar month, normalized to the Trip shape.
   *
   * @param includeRaw When true, each Trip carries the raw TeslaFi record.
   */
  async getTripsForMonth(
    year: number,
    month: number,
    includeRaw = false
  ): Promise<Trip[]> {
    const { dateFrom, dateTo } = monthToDateRange(year, month);
    const drives = await this.getDrives({ dateFrom, dateTo });
    return drives.map((drive, index) =>
      this.normalizeDrive(drive, index, includeRaw)
    );
  }

  /**
   * Analyze drives in a calendar month to count home <-> work commutes.
   * The embedded matched-trip list is capped at MAX_ANALYSIS_TRIPS entries.
   */
  async analyzeHomeWorkTrips(
    year: number,
    month: number,
    homeLocation: string,
    workLocation: string
  ): Promise<HomeWorkAnalysis> {
    const trips = await this.getTripsForMonth(year, month, false);

    const normalizeLocation = (loc: string): string => loc.toLowerCase().trim();

    const homeNorm = normalizeLocation(homeLocation);
    const workNorm = normalizeLocation(workLocation);

    const matches = (value: string, target: string): boolean =>
      target.length > 0 &&
      value.length > 0 &&
      (value.includes(target) || target.includes(value));

    let homeToWorkCount = 0;
    let workToHomeCount = 0;
    let truncated = false;
    const matchedTrips: Trip[] = [];

    const pushMatch = (trip: Trip) => {
      if (matchedTrips.length < MAX_ANALYSIS_TRIPS) {
        matchedTrips.push(trip);
      } else {
        truncated = true;
      }
    };

    for (const trip of trips) {
      const startNorm = normalizeLocation(trip.start_location);
      const endNorm = normalizeLocation(trip.end_location);

      if (matches(startNorm, homeNorm) && matches(endNorm, workNorm)) {
        homeToWorkCount++;
        pushMatch(trip);
      } else if (matches(startNorm, workNorm) && matches(endNorm, homeNorm)) {
        workToHomeCount++;
        pushMatch(trip);
      }
    }

    return {
      total_trips: trips.length,
      home_to_work_trips: homeToWorkCount,
      work_to_home_trips: workToHomeCount,
      other_trips: trips.length - homeToWorkCount - workToHomeCount,
      trips: matchedTrips,
      trips_truncated: truncated
    };
  }

  /**
   * Derive the set of known locations from stored drive history.
   */
  async getLocations(range: HistoryDateRange = {}): Promise<LocationSummary[]> {
    const drives = await this.getDrives(range);
    const byName = new Map<string, LocationSummary>();

    const record = (name: string, role: "start" | "end") => {
      const clean = (name || "").trim();
      if (!clean || clean.toLowerCase() === "unknown") {
        return;
      }
      const existing =
        byName.get(clean) ??
        { name: clean, visits: 0, as_start: 0, as_end: 0 };
      existing.visits++;
      if (role === "start") {
        existing.as_start++;
      } else {
        existing.as_end++;
      }
      byName.set(clean, existing);
    };

    for (const drive of drives) {
      // Only count named saved locations, not raw street addresses.
      record(getField(drive, ["startingLocationName"], ""), "start");
      record(getField(drive, ["locationName"], ""), "end");
    }

    return Array.from(byName.values()).sort((a, b) => b.visits - a.visits);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Normalize a raw TeslaFi history.php drive record into the Trip shape.
   *
   * TeslaFi drive fields (confirmed against a live account):
   *   date                 -> start timestamp ("YYYY-MM-DD HH:MM:SS")
   *   startingLocationName -> named start location (may be "", then startingAddress)
   *   locationName         -> named end location (may be "", then address)
   *   miles / kilometers   -> distance in each unit
   *   dayDriveHours/Minutes-> drive duration
   */
  private normalizeDrive(
    drive: TeslaFiRecord,
    index: number,
    includeRaw: boolean
  ): Trip {
    const startRaw = getField(
      drive,
      ["date", "startDate", "start_date"],
      ""
    );
    const startDate = parseTeslaFiDate(startRaw);

    // Duration from dayDriveHours + dayDriveMinutes, else from timestamps.
    const hours = Number(getField(drive, ["dayDriveHours"], 0));
    const minutes = Number(getField(drive, ["dayDriveMinutes"], NaN));
    let durationMinutes = Number.isFinite(minutes)
      ? Math.round((Number.isFinite(hours) ? hours : 0) * 60 + minutes)
      : NaN;

    const endRaw = getField(drive, ["endDate", "end_date"], "");
    const endDate = endRaw
      ? parseTeslaFiDate(endRaw)
      : isValidDate(startDate) && Number.isFinite(durationMinutes)
        ? new Date(startDate.getTime() + durationMinutes * 60000)
        : new Date(NaN);

    if (!Number.isFinite(durationMinutes)) {
      const ms = endDate.getTime() - startDate.getTime();
      durationMinutes = Number.isFinite(ms) ? Math.round(ms / 60000) : 0;
    }

    // Distance: prefer kilometers, fall back to miles.
    const km = parseNum(getField(drive, ["kilometers"], ""));
    const mi = parseNum(getField(drive, ["miles", "distance"], ""));
    const useKm = Number.isFinite(km);
    const distance = useKm ? km : Number.isFinite(mi) ? mi : 0;

    const trip: Trip = {
      id: Number(getField(drive, ["id"], index)),
      start_date: isValidDate(startDate)
        ? startDate.toISOString()
        : String(startRaw),
      end_date: isValidDate(endDate) ? endDate.toISOString() : String(endRaw),
      start_location: getField(
        drive,
        ["startingLocationName", "startingAddress"],
        "Unknown"
      ),
      end_location: getField(drive, ["locationName", "address"], "Unknown"),
      distance,
      distance_unit: useKm ? "km" : "mi",
      duration_minutes: Number.isFinite(durationMinutes) ? durationMinutes : 0
    };
    if (includeRaw) {
      trip.raw = drive;
    }
    return trip;
  }

  private async feedRequest(
    command: string,
    extraParams: Record<string, string | number | boolean> = {},
    wakeSeconds?: number
  ): Promise<TeslaFiRecord> {
    // Extend the timeout to cover TeslaFi's wake-and-wait window plus buffer.
    const timeoutMs =
      DEFAULT_TIMEOUT_MS +
      (typeof wakeSeconds === "number" && wakeSeconds > 0
        ? wakeSeconds * 1000
        : 0);
    const mutating = command !== "" && command !== "lastGood" && command !== "lastGoodTemp";
    const context: RequestContext = {
      what: mutating ? `command "${command}"` : "vehicle data",
      mutating,
      timeoutMs
    };

    try {
      // The token (and command) are applied AFTER the spread so user-supplied
      // parameters can never override them.
      const params: Record<string, string | number | boolean> = {
        ...extraParams,
        token: this.apiToken
      };
      if (command) {
        params.command = command;
      } else {
        delete params.command;
      }

      const response = await this.requestWithRetry(
        {
          method: "GET",
          url: TESLAFI_FEED_URL,
          params,
          timeout: timeoutMs
        },
        context
      );

      return this.unwrap(response.data);
    } catch (error) {
      throw this.handleError(error, context);
    }
  }

  private historyRequest(
    command: "drives" | "charges",
    range: HistoryDateRange
  ): Promise<TeslaFiRecord[]> {
    // In-memory TTL cache (never persisted) keyed by endpoint + query, so
    // pagination and tools that reuse the same history hit the network once.
    const key = `${command}|${range.dateFrom ?? ""}|${range.dateTo ?? ""}`;
    const cached = this.historyCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.promise;
    }

    const promise = this.fetchHistory(command, range);
    this.historyCache.set(key, {
      expires: Date.now() + this.cacheTtlMs,
      promise
    });
    // Do not cache failures.
    promise.catch(() => {
      if (this.historyCache.get(key)?.promise === promise) {
        this.historyCache.delete(key);
      }
    });
    this.pruneCache();
    return promise;
  }

  private async fetchHistory(
    command: "drives" | "charges",
    range: HistoryDateRange
  ): Promise<TeslaFiRecord[]> {
    const what = command === "drives" ? "drive history" : "charge history";
    const context: RequestContext = {
      what,
      mutating: false,
      timeoutMs: DEFAULT_TIMEOUT_MS
    };

    try {
      const params: Record<string, string> = {
        command,
        token: this.apiToken
      };
      if (range.dateFrom) {
        params.dateFrom = range.dateFrom;
      }
      if (range.dateTo) {
        params.dateTo = range.dateTo;
      }

      const response = await this.requestWithRetry(
        {
          method: "GET",
          url: TESLAFI_HISTORY_URL,
          params,
          timeout: DEFAULT_TIMEOUT_MS
        },
        context
      );

      return this.toRecordArray(this.unwrap(response.data), what);
    } catch (error) {
      throw this.handleError(error, context);
    }
  }

  /**
   * Keep the cache bounded: drop expired entries first, and if the map still
   * exceeds MAX_CACHE_ENTRIES (possible with a long TESLAFI_CACHE_TTL_SECONDS
   * where nothing has expired yet), evict the oldest-inserted live entries
   * until it fits. This guarantees the map cannot grow unbounded regardless
   * of the configured TTL.
   */
  private pruneCache(): void {
    if (this.historyCache.size <= MAX_CACHE_ENTRIES) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of this.historyCache) {
      if (entry.expires <= now) {
        this.historyCache.delete(key);
      }
    }
    // Still over the cap: evict in insertion order (oldest first). The entry
    // just inserted by historyRequest sits at the tail, so it survives.
    for (const key of this.historyCache.keys()) {
      if (this.historyCache.size <= MAX_CACHE_ENTRIES) {
        break;
      }
      this.historyCache.delete(key);
    }
  }

  /**
   * Perform an HTTP request with 1s minimum spacing between outbound requests
   * and bounded retry (max 2) with exponential backoff + jitter for transient
   * failures. HTTP 429 is retried only when TeslaFi supplies a Retry-After of
   * at most 60s; otherwise it fails immediately with a rate-limit error.
   *
   * Mutating requests (vehicle commands) are only retried for failures that
   * happen before the request reaches TeslaFi (DNS/connect errors and 429
   * rejections), never for mid-flight failures where the command may already
   * have been executed.
   *
   * Redirects are never followed (maxRedirects: 0): the only host this server
   * ever contacts is www.teslafi.com over HTTPS, and a server-issued redirect
   * must not be able to send the token-bearing request URL anywhere else (or
   * downgrade it to plain HTTP). For the same single-destination guarantee,
   * proxy support is disabled (proxy: false): axios would otherwise honor
   * HTTP_PROXY/HTTPS_PROXY environment variables and route the request
   * through that proxy instead of directly to www.teslafi.com.
   */
  private async requestWithRetry(
    config: AxiosRequestConfig,
    context: RequestContext
  ): Promise<AxiosResponse> {
    let attempt = 0;
    for (;;) {
      try {
        await this.throttle();
        return await axios({ ...config, maxRedirects: 0, proxy: false });
      } catch (error) {
        const verdict = classifyForRetry(error, context.mutating);
        if (!verdict.retryable || attempt >= MAX_RETRIES) {
          throw error;
        }
        let delayMs =
          500 * 2 ** attempt + Math.floor(Math.random() * 250);
        if (verdict.retryAfterMs !== undefined) {
          delayMs = Math.min(verdict.retryAfterMs, MAX_RETRY_AFTER_MS);
        }
        await sleep(delayMs);
        attempt++;
      }
    }
  }

  /** Enforce a minimum spacing between outbound requests (in-memory gate). */
  private throttle(): Promise<void> {
    const previous = this.requestGate;
    let release: () => void = () => undefined;
    this.requestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() => {
        const waitMs =
          MIN_REQUEST_SPACING_MS - (Date.now() - this.lastRequestAt);
        return waitMs > 0 ? sleep(waitMs) : undefined;
      })
      .then(() => {
        this.lastRequestAt = Date.now();
        release();
      });
  }

  /**
   * TeslaFi sometimes wraps payloads in a { response: ... } envelope and uses
   * that envelope to report errors. Unwrap it and surface any API-level error.
   */
  private unwrap(data: any): any {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (data.error) {
        throw new Error(
          this.sanitize(
            `TeslaFi API error: ${data.error}${
              data.error_description ? ` - ${data.error_description}` : ""
            }`
          )
        );
      }
      if ("response" in data) {
        const inner = data.response;
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          if (inner.result === "unauthorized") {
            throw new Error(
              "TeslaFi API token is unauthorized. Check your token and command permissions."
            );
          }
          if (inner.result === false) {
            throw new Error(
              this.sanitize(
                String(
                  inner.reason || inner.string || "TeslaFi API request failed."
                )
              )
            );
          }
        }
        return inner;
      }
    }
    return data;
  }

  /**
   * Normalize a drives/charges payload to an array of records, distinguishing
   * genuinely-empty results from malformed (HTML / plain-text) responses.
   */
  private toRecordArray(data: any, what: string): TeslaFiRecord[] {
    if (Array.isArray(data)) {
      return data;
    }
    if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.startsWith("<")) {
        throw new Error(
          `TeslaFi returned an HTML page instead of JSON ${what}. This usually ` +
            "means TeslaFi is down, the token was rejected, or the request " +
            "hit an error page. Try again shortly."
        );
      }
      throw new Error(
        `TeslaFi returned a non-JSON response instead of ${what}. ` +
          "This is a malformed response, not an empty result. Try again shortly."
      );
    }
    if (data && typeof data === "object") {
      // history.php returns { count, results: [...] } (optionally with dateFrom/dateTo).
      if (Array.isArray(data.results)) {
        return data.results as TeslaFiRecord[];
      }
      // A count of 0 without a results array is a genuinely empty result set.
      if ("count" in data && Number(data.count) === 0) {
        return [];
      }
      const values = Object.values(data);
      if (values.length === 0) {
        return [];
      }
      // Fallback: responses keyed by id, e.g. { "123": {...}, "124": {...} }
      if (values.every((v) => v && typeof v === "object")) {
        return values as TeslaFiRecord[];
      }
      throw new Error(
        `TeslaFi returned an unexpected payload shape for ${what}. ` +
          "This is a malformed response, not an empty result. Try again shortly."
      );
    }
    throw new Error(
      `TeslaFi returned an empty or malformed response for ${what}. ` +
        "Try again shortly."
    );
  }

  /**
   * Convert any thrown value into a safe Error. Never returns the original
   * AxiosError (its config embeds the request URL and token) and never puts
   * the token or a request URL into the message.
   */
  private handleError(error: unknown, context?: RequestContext): Error {
    if (error instanceof AxiosError) {
      if (error.response) {
        // Redirects are never followed (maxRedirects: 0), so a 3xx surfaces
        // here. Refusing to follow it is deliberate: a redirect could point
        // the token-bearing request URL at another host or at plain HTTP.
        if (error.response.status >= 300 && error.response.status < 400) {
          return new Error(
            `TeslaFi responded with an unexpected redirect (HTTP ${error.response.status}). ` +
              "For security this server never follows redirects, so the " +
              "request was not completed. Try again shortly."
          );
        }
        switch (error.response.status) {
          case 401:
            return new Error(
              "Invalid TeslaFi API token. Please check your credentials."
            );
          case 403:
            return new Error(
              "Access denied. The command may not be enabled on the TeslaFi Commands tab."
            );
          case 404:
            return new Error("TeslaFi API endpoint not found.");
          case 429: {
            const retryAfterMs = parseRetryAfterMs(
              error.response.headers?.["retry-after"]
            );
            const waitHint =
              retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS
                ? ` TeslaFi asked to wait ${Math.ceil(retryAfterMs / 1000)}s.`
                : "";
            return new Error(
              "TeslaFi rate limit exceeded (HTTP 429). TeslaFi enforces " +
                "per-minute API request limits; wait about a minute before " +
                "retrying." +
                waitHint
            );
          }
          default:
            return new Error(
              `TeslaFi API error: HTTP ${error.response.status}` +
                (error.response.statusText
                  ? ` ${this.sanitize(String(error.response.statusText))}`
                  : "")
            );
        }
      }
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        const seconds = context
          ? Math.round(context.timeoutMs / 1000)
          : Math.round(DEFAULT_TIMEOUT_MS / 1000);
        const commandWarning = context?.mutating
          ? " The command may still have been executed by TeslaFi - check the " +
            "vehicle state before retrying."
          : " Please try again.";
        return new Error(
          `Request to TeslaFi timed out after ${seconds}s.${commandWarning}`
        );
      }
      if (
        error.code === "ENOTFOUND" ||
        error.code === "EAI_AGAIN" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET"
      ) {
        return new Error(
          "Could not reach TeslaFi (network error). Check your internet " +
            "connection and try again."
        );
      }
      // Unknown axios error: use only the (sanitized) message, never the object.
      return new Error(
        this.sanitize(error.message || "TeslaFi request failed.")
      );
    }

    if (error instanceof Error) {
      return new Error(this.sanitize(error.message));
    }
    return new Error(this.sanitize(String(error)));
  }

  /**
   * Strip the API token and any request URL / token query parameter from a
   * message so they can never surface in logs or tool output.
   */
  private sanitize(message: string): string {
    if (!message) {
      return message;
    }
    let out = message;
    if (this.apiToken) {
      out = out.split(this.apiToken).join("[redacted]");
    }
    out = out.replace(/token=[^&\s"']+/gi, "token=[redacted]");
    out = out.replace(
      /https?:\/\/[^\s"']*teslafi\.com[^\s"']*/gi,
      "teslafi.com/[request URL redacted]"
    );
    return out;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryVerdict {
  retryable: boolean;
  retryAfterMs?: number;
}

/**
 * Decide whether a failed request may be retried.
 *
 * - 5xx responses and mid-flight socket errors (ECONNRESET, ETIMEDOUT,
 *   ECONNABORTED) are retried only for non-mutating requests.
 * - Pre-connection failures (DNS, connection refused) are always retryable.
 * - 429 is retryable only when Retry-After is present and within the cap
 *   (the rate limiter rejected the request, so it was not executed).
 */
function classifyForRetry(error: unknown, mutating: boolean): RetryVerdict {
  if (!(error instanceof AxiosError)) {
    return { retryable: false };
  }
  if (error.response) {
    const status = error.response.status;
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        error.response.headers?.["retry-after"]
      );
      if (retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS) {
        return { retryable: true, retryAfterMs };
      }
      return { retryable: false };
    }
    if (status >= 500 && status < 600) {
      return { retryable: !mutating };
    }
    return { retryable: false };
  }
  switch (error.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ECONNREFUSED":
      return { retryable: true };
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "ECONNABORTED":
      return { retryable: !mutating };
    default:
      return { retryable: false };
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP date) to milliseconds. */
function parseRetryAfterMs(header: unknown): number | undefined {
  if (typeof header !== "string" || header.trim() === "") {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function getField<T>(
  obj: TeslaFiRecord,
  keys: string[],
  fallback: T
): T {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value as T;
    }
  }
  return fallback;
}

function isValidDate(d: Date): boolean {
  return d instanceof Date && !isNaN(d.getTime());
}

/**
 * Parse a TeslaFi timestamp. TeslaFi returns "YYYY-MM-DD HH:MM:SS" in UTC, so
 * we anchor it to UTC explicitly (otherwise it would be read as local time and
 * shifted by the machine's timezone offset).
 */
function parseTeslaFiDate(value: unknown): Date {
  if (!value) {
    return new Date(NaN);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(" ", "T") + "Z");
  }
  return new Date(s);
}

/** Parse a TeslaFi numeric string that may contain thousands separators. */
function parseNum(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return parseFloat(value.replace(/,/g, ""));
  }
  return NaN;
}

/** Build a TeslaFi Y-m-d date range covering an entire calendar month. */
export function monthToDateRange(
  year: number,
  month: number
): { dateFrom: string; dateTo: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return {
    dateFrom: `${year}-${pad(month)}-01`,
    dateTo: `${year}-${pad(month)}-${pad(lastDay)}`
  };
}

export default TeslaFIAPI;
