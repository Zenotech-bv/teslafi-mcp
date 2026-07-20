/**
 * Unit tests for the TeslaFi API client (src/services/tesla-api.ts).
 *
 * All HTTP is mocked at the axios module boundary - no test ever contacts the
 * real teslafi.com. Fake timers drive the 1s request-spacing gate, retry
 * backoff, and the history cache TTL so the suite stays fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError } from "axios";
import TeslaFIAPI, {
  barToPsi,
  CAR_COMMANDS,
  cToF,
  envFlagEnabled,
  indicatesUnsentAsleep,
  inferLocationName,
  isMonthlyAllowanceError,
  isNewerVersion,
  MAX_ANALYSIS_TRIPS,
  miToKm,
  monthToDateRange,
  mphToKmh,
  mToFt,
  normalizeFeedData,
  parseSemver,
  psiToBar,
  resolveUnits,
  selectDriveUnitFields,
  TESLAFI_COMMAND_NAMES,
  TESLAFI_COMMAND_PARAMS,
  UpdateChecker,
  VERSION
} from "../src/services/tesla-api.js";

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: vi.fn() };
});

const mockAxios = axios as unknown as ReturnType<typeof vi.fn>;

const TOKEN = "SECRET-TOKEN-abc123";
const FEED_URL = "https://www.teslafi.com/feed.php";
const HISTORY_URL = "https://www.teslafi.com/history.php";

/** Config object axios was called with on call #n (default: last call). */
function axiosConfig(n = -1): Record<string, any> {
  const call = mockAxios.mock.calls.at(n);
  if (!call) throw new Error("axios was not called");
  return call[0] as Record<string, any>;
}

/** AxiosError with no response (network-level failure). */
function netError(code: string, message = `request failed: ${code}`): AxiosError {
  return new AxiosError(message, code, {
    url: `${FEED_URL}?token=${TOKEN}&command=lastGood`
  } as any);
}

/** AxiosError with an HTTP response. config.url deliberately embeds the token. */
function httpError(
  status: number,
  opts: { headers?: Record<string, string>; statusText?: string } = {}
): AxiosError {
  const config = { url: `${FEED_URL}?token=${TOKEN}&command=lastGood` } as any;
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_RESPONSE",
    config,
    {},
    {
      status,
      statusText: opts.statusText ?? "",
      headers: opts.headers ?? {},
      data: "",
      config
    } as any
  );
}

/**
 * Await a promise that is expected to reject, while draining fake timers
 * (throttle spacing / retry backoff). Returns the rejection error.
 */
async function settleRejects(p: Promise<unknown>): Promise<Error> {
  const guarded = p.then(
    () => {
      throw new Error("expected promise to reject, but it resolved");
    },
    (e: unknown) => e as Error
  );
  await vi.runAllTimersAsync();
  return guarded;
}

/** Await a promise expected to resolve, while draining fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

let api: TeslaFIAPI;

beforeEach(() => {
  vi.useFakeTimers();
  mockAxios.mockReset();
  delete process.env.TESLAFI_CACHE_TTL_SECONDS;
  delete process.env.TESLAFI_CHECK_UPDATES;
  api = new TeslaFIAPI(TOKEN);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TESLAFI_CACHE_TTL_SECONDS;
  delete process.env.TESLAFI_CHECK_UPDATES;
});

// ---------------------------------------------------------------------------
// Command allowlist + local validation (no network)
// ---------------------------------------------------------------------------

describe("command allowlist", () => {
  it("exposes exactly the 24 officially documented commands", () => {
    expect(TESLAFI_COMMAND_NAMES).toHaveLength(24);
    expect(new Set(TESLAFI_COMMAND_NAMES).size).toBe(24);
    expect(Object.keys(TESLAFI_COMMAND_PARAMS)).toEqual(
      TESLAFI_COMMAND_NAMES
    );
    // Commands added in the official-docs alignment.
    for (const name of [
      "wake",
      "sleep",
      "enableLogging",
      "disableLogging",
      "seat_heater",
      "preset",
      "command_count"
    ]) {
      expect(TESLAFI_COMMAND_NAMES).toContain(name);
    }
    // honk_horn is not an official TeslaFi command.
    expect(TESLAFI_COMMAND_NAMES).not.toContain("honk_horn");
  });

  it("rejects an unknown command locally, without a network call", async () => {
    await expect(api.sendCommand("self_destruct")).rejects.toThrow(
      /Unknown TeslaFi command "self_destruct"/
    );
    await expect(api.sendCommand("self_destruct")).rejects.toThrow(/wake_up/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('rejects the removed community alias "honk_horn" (official name: honk)', async () => {
    await expect(api.sendCommand("honk_horn")).rejects.toThrow(
      /Unknown TeslaFi command "honk_horn"/
    );
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each(["token", "command", "wake", "noWake"])(
    'rejects the reserved parameter key "%s" without a network call',
    async (key) => {
      await expect(
        api.sendCommand("set_charge_limit", { [key]: "evil" })
      ).rejects.toThrow(new RegExp(`Parameter "${key}" is reserved`));
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );

  it('points the caller at wake_seconds when "wake" is supplied', async () => {
    await expect(
      api.sendCommand("wake_up", { wake: 30 })
    ).rejects.toThrow(/Use wake_seconds instead/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('points the caller at no_wake when "noWake" is supplied', async () => {
    await expect(
      api.sendCommand("wake_up", { noWake: true })
    ).rejects.toThrow(/Use no_wake instead/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('rejects the removed set_temps params "driver_temp"/"passenger_temp"', async () => {
    await expect(
      api.sendCommand("set_temps", { driver_temp: 21 })
    ).rejects.toThrow(
      /Parameter "driver_temp" is not valid for command "set_temps"/
    );
    await expect(
      api.sendCommand("set_temps", { passenger_temp: 21 })
    ).rejects.toThrow(/Parameter "passenger_temp" is not valid/);
    // The official parameter is still accepted.
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("set_temps", { temp: 21.5 }));
    expect(axiosConfig().params.temp).toBe(21.5);
  });

  it("rejects a parameter that is valid for a different command", async () => {
    await expect(
      api.sendCommand("set_charge_limit", { charging_amps: 16 })
    ).rejects.toThrow(
      /Parameter "charging_amps" is not valid for command "set_charge_limit"/
    );
    await expect(
      api.sendCommand("set_charge_limit", { charging_amps: 16 })
    ).rejects.toThrow(/charge_limit_soc/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("rejects parameters on commands that take none", async () => {
    await expect(
      api.sendCommand("wake_up", { statement: true })
    ).rejects.toThrow(/takes no parameters/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    'rejects the prototype-inherited name "%s" as an unknown command, without a network call',
    async (name) => {
      // A plain bracket lookup on the allowlist object would resolve these
      // to inherited (truthy) values and forward them to TeslaFi; the
      // own-property check must reject them like any other unknown command.
      await expect(api.sendCommand(name)).rejects.toThrow(
        /Unknown TeslaFi command/
      );
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );
});

// ---------------------------------------------------------------------------
// Parameter value validation (no network)
// ---------------------------------------------------------------------------

describe("parameter value validation", () => {
  it("rejects seat_heater heater=3 (there is no seat 3), without a network call", async () => {
    await expect(
      api.sendCommand("seat_heater", { heater: 3, level: 2 })
    ).rejects.toThrow(/there is no seat 3/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each([[0], [1], [2], [4], [5]])(
    "accepts seat_heater heater=%d",
    async (heater) => {
      mockAxios.mockResolvedValue({ data: { response: { result: true } } });
      await settle(api.sendCommand("seat_heater", { heater, level: 3 }));
      expect(axiosConfig().params.heater).toBe(heater);
      expect(axiosConfig().params.level).toBe(3);
    }
  );

  it("accepts numeric-string seat_heater values (query-string API)", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("seat_heater", { heater: "4", level: "0" }));
    expect(axiosConfig().params.heater).toBe("4");
  });

  it.each([[-1], [4], [1.5]])(
    "rejects seat_heater level=%s (valid: 0-3)",
    async (level) => {
      await expect(
        api.sendCommand("seat_heater", { heater: 0, level })
      ).rejects.toThrow(/must be an integer between 0 and 3/);
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );

  it.each([[49], [101], [80.5]])(
    "rejects out-of-range charge_limit_soc %s (valid: 50-100)",
    async (soc) => {
      await expect(
        api.sendCommand("set_charge_limit", { charge_limit_soc: soc })
      ).rejects.toThrow(/must be an integer between 50 and 100/);
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );

  it.each([[0], [81]])(
    "rejects out-of-range charging_amps %s (valid: 1-80)",
    async (amps) => {
      await expect(
        api.sendCommand("set_charging_amps", { charging_amps: amps })
      ).rejects.toThrow(/must be an integer between 1 and 80/);
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );

  it("rejects a non-Celsius-range set_temps temp", async () => {
    await expect(
      api.sendCommand("set_temps", { temp: 70 }) // Fahrenheit confusion
    ).rejects.toThrow(/Celsius temperature between 15 and 28/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("accepts sleep with an optional time in minutes, and without one", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("sleep", { time: 30 }));
    expect(axiosConfig().params.command).toBe("sleep");
    expect(axiosConfig().params.time).toBe(30);

    await settle(api.sendCommand("sleep"));
    expect(axiosConfig().params).not.toHaveProperty("time");
  });

  it("rejects a non-positive sleep time", async () => {
    await expect(api.sendCommand("sleep", { time: 0 })).rejects.toThrow(
      /must be an integer between 1 and 1440/
    );
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("accepts a preset by number, with the optional email confirmation", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("preset", { number: 2, statement: true }));
    expect(axiosConfig().params.number).toBe(2);
    expect(axiosConfig().params.statement).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token handling (the spread-order fix)
// ---------------------------------------------------------------------------

describe("token handling", () => {
  it("sends the constructor token and command in the query params", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("set_charge_limit", { charge_limit_soc: 80 }));

    const cfg = axiosConfig();
    expect(cfg.url).toBe(FEED_URL);
    expect(cfg.method).toBe("GET");
    expect(cfg.params.token).toBe(TOKEN);
    expect(cfg.params.command).toBe("set_charge_limit");
    expect(cfg.params.charge_limit_soc).toBe(80);
  });

  it("never lets extra params override token or command, even if the allowlist were bypassed", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    // Call the internal request builder directly, simulating a hypothetical
    // allowlist bypass: the { ...extraParams, token } spread order must still
    // guarantee the real token (and the command argument) win.
    await settle(
      (api as any).feedRequest("wake_up", {
        token: "attacker-token",
        command: "door_unlock"
      })
    );

    const cfg = axiosConfig();
    expect(cfg.params.token).toBe(TOKEN);
    expect(cfg.params.command).toBe("wake_up");
    expect(JSON.stringify(cfg.params)).not.toContain("attacker-token");
  });

  it("cannot inject a token through the public sendCommand params", async () => {
    await expect(
      api.sendCommand("wake_up", { token: "attacker-token" })
    ).rejects.toThrow(/reserved/);
    expect(mockAxios).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error hygiene: the token and request URL never leak
// ---------------------------------------------------------------------------

describe("error hygiene", () => {
  it("HTTP 401 produces a clean credential error without token, URL, or the AxiosError", async () => {
    mockAxios.mockRejectedValue(httpError(401));
    const err = await settleRejects(api.getCurrentData());

    expect(err.message).toBe(
      "Invalid TeslaFi API token. Please check your credentials."
    );
    expect(err).not.toBeInstanceOf(AxiosError);
    expect((err as any).config).toBeUndefined();
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("feed.php");
  });

  it("sanitizes token and full request URL out of unknown axios error messages", async () => {
    // An unknown axios error code falls through to the raw-message branch;
    // the message deliberately embeds the full request URL with the token.
    const leaky = new AxiosError(
      `something odd happened for ${FEED_URL}?token=${TOKEN}&command=lastGood during send`,
      "ERR_FR_TOO_MANY_REDIRECTS",
      { url: `${FEED_URL}?token=${TOKEN}` } as any
    );
    mockAxios.mockRejectedValue(leaky);
    const err = await settleRejects(api.getCurrentData());

    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("feed.php");
    expect(err.message).not.toContain("token=SECRET");
    expect(err.message).toContain("[request URL redacted]");
    expect(err).not.toBeInstanceOf(AxiosError);
    expect((err as any).config).toBeUndefined();
  });

  it("sanitizes the token out of non-axios error messages", async () => {
    mockAxios.mockRejectedValue(
      new Error(`weird failure while using ${TOKEN} internally`)
    );
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
  });

  it("sanitizes the token out of TeslaFi envelope failure reasons", async () => {
    mockAxios.mockResolvedValue({
      data: {
        response: { result: false, reason: `bad request token=${TOKEN}` }
      }
    });
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("token=[redacted]");
  });

  it("HTTP 403 explains the TeslaFi Commands tab", async () => {
    mockAxios.mockRejectedValue(httpError(403));
    const err = await settleRejects(api.sendCommand("door_lock"));
    expect(err.message).toMatch(/Access denied/);
    expect(err.message).toMatch(/Commands tab/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("HTTP 404 maps to an endpoint-not-found error", async () => {
    mockAxios.mockRejectedValue(httpError(404));
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/endpoint not found/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("surfaces TeslaFi error envelopes", async () => {
    mockAxios.mockResolvedValue({
      data: { error: "invalid_token", error_description: "bad things" }
    });
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toBe("TeslaFi API error: invalid_token - bad things");
  });

  it("surfaces the unauthorized envelope with a clean message", async () => {
    mockAxios.mockResolvedValue({
      data: { response: { result: "unauthorized" } }
    });
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toMatch(/token is unauthorized/);
    expect(err.message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Malformed vs genuinely-empty responses
// ---------------------------------------------------------------------------

describe("history payload normalization (toRecordArray)", () => {
  it("throws a descriptive error for an HTML page", async () => {
    mockAxios.mockResolvedValue({
      data: "<html><body>TeslaFi is down</body></html>"
    });
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/HTML page instead of JSON drive history/);
  });

  it("throws a descriptive error for plain text", async () => {
    mockAxios.mockResolvedValue({ data: "unexpected maintenance message" });
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/non-JSON response instead of drive history/);
    expect(err.message).toMatch(/not an empty result/);
  });

  it("throws a descriptive error for a null body", async () => {
    mockAxios.mockResolvedValue({ data: null });
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/empty or malformed response for drive history/);
  });

  it("throws for an object of non-record values", async () => {
    mockAxios.mockResolvedValue({ data: { unexpected: "shape" } });
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/unexpected payload shape for drive history/);
  });

  it("names charge history in charge errors", async () => {
    mockAxios.mockResolvedValue({ data: "<html></html>" });
    const err = await settleRejects(api.getCharges());
    expect(err.message).toMatch(/charge history/);
  });

  it("returns [] for a genuinely-empty { count: 0 } result", async () => {
    mockAxios.mockResolvedValue({ data: { count: 0 } });
    await expect(settle(api.getDrives())).resolves.toEqual([]);
  });

  it("returns [] for an empty array and an empty object", async () => {
    mockAxios.mockResolvedValue({ data: [] });
    await expect(settle(api.getDrives())).resolves.toEqual([]);

    mockAxios.mockResolvedValue({ data: {} });
    const other = new TeslaFIAPI(TOKEN); // separate instance: no shared cache
    await expect(settle(other.getCharges())).resolves.toEqual([]);
  });

  it("unwraps { count, results } payloads", async () => {
    const records = [{ id: "1" }, { id: "2" }];
    mockAxios.mockResolvedValue({ data: { count: 2, results: records } });
    await expect(settle(api.getDrives())).resolves.toEqual(records);
  });

  it("unwraps responses keyed by id", async () => {
    mockAxios.mockResolvedValue({
      data: { "101": { id: "101" }, "102": { id: "102" } }
    });
    await expect(settle(api.getDrives())).resolves.toEqual([
      { id: "101" },
      { id: "102" }
    ]);
  });
});

describe("getCurrentData payload validation", () => {
  it("rejects a plain-string body with a descriptive error", async () => {
    mockAxios.mockResolvedValue({ data: "You are not logged in" });
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toMatch(/plain text/);
    expect(err.message).toMatch(/instead of a vehicle data object/);
  });

  it("rejects an array body", async () => {
    mockAxios.mockResolvedValue({ data: [1, 2, 3] });
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toMatch(/unexpected payload/);
  });

  it("rejects a null body", async () => {
    mockAxios.mockResolvedValue({ data: null });
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toMatch(/unexpected payload/);
  });

  it("unwraps a { response: {...} } envelope", async () => {
    mockAxios.mockResolvedValue({
      data: { response: { battery_level: 55 } }
    });
    await expect(settle(api.getCurrentData())).resolves.toEqual({
      battery_level: 55
    });
  });
});

describe("sendCommand payload validation", () => {
  it("rejects a plain-text body instead of framing it as success", async () => {
    mockAxios.mockResolvedValue({ data: "You are not logged in" });
    const err = await settleRejects(api.sendCommand("wake_up"));
    expect(err.message).toMatch(/plain text/);
    expect(err.message).toMatch(/command "wake_up"/);
    expect(err.message).toMatch(/may still have been executed/);
  });

  it("rejects an array body", async () => {
    mockAxios.mockResolvedValue({ data: [1, 2, 3] });
    const err = await settleRejects(api.sendCommand("honk"));
    expect(err.message).toMatch(/unexpected payload/);
  });

  it("rejects a null body", async () => {
    mockAxios.mockResolvedValue({ data: null });
    const err = await settleRejects(api.sendCommand("door_lock"));
    expect(err.message).toMatch(/unexpected payload/);
    expect(err.message).toMatch(/may still have been executed/);
  });
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

describe("retry policy", () => {
  it("retries a read after a transient network error, then succeeds", async () => {
    mockAxios
      .mockRejectedValueOnce(netError("ENOTFOUND"))
      .mockResolvedValueOnce({ data: { count: 0 } });

    await expect(settle(api.getDrives())).resolves.toEqual([]);
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("waits at least the backoff before the read retry", async () => {
    mockAxios
      .mockRejectedValueOnce(netError("ENOTFOUND"))
      .mockResolvedValueOnce({ data: { count: 0 } });

    const p = api.getDrives();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    // Backoff for attempt 0 is 500ms + jitter; nothing may fire before 498ms.
    await vi.advanceTimersByTimeAsync(497);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual([]);
  });

  it("gives up after 2 retries (3 attempts) for reads", async () => {
    mockAxios.mockRejectedValue(netError("ENOTFOUND"));
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/Could not reach TeslaFi \(network error\)/);
    expect(mockAxios).toHaveBeenCalledTimes(3);
  });

  it("also retries reads on 5xx and mid-flight resets", async () => {
    mockAxios
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(netError("ECONNRESET"))
      .mockResolvedValueOnce({ data: { count: 0 } });
    await expect(settle(api.getDrives())).resolves.toEqual([]);
    expect(mockAxios).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a command on ECONNRESET (may already have executed)", async () => {
    mockAxios.mockRejectedValue(netError("ECONNRESET"));
    const err = await settleRejects(api.sendCommand("door_unlock"));
    expect(err.message).toMatch(/Could not reach TeslaFi/);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a command on a 5xx response", async () => {
    mockAxios.mockRejectedValue(
      httpError(503, { statusText: "Service Unavailable" })
    );
    const err = await settleRejects(api.sendCommand("charge_start"));
    expect(err.message).toBe(
      "TeslaFi API error: HTTP 503 Service Unavailable"
    );
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("retries a command on a pre-connection DNS failure (not yet sent)", async () => {
    mockAxios
      .mockRejectedValueOnce(netError("ENOTFOUND"))
      .mockResolvedValueOnce({ data: { response: { result: true } } });
    await expect(
      settle(api.sendCommand("door_lock"))
    ).resolves.toEqual({ result: true });
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After on 429 before retrying", async () => {
    mockAxios
      .mockRejectedValueOnce(
        httpError(429, { headers: { "retry-after": "5" } })
      )
      .mockResolvedValueOnce({ data: { count: 0 } });

    const p = api.getDrives();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4997); // t ~= 4998 < 5000
    expect(mockAxios).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10); // past the 5s Retry-After
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual([]);
  });

  it("retries a command on 429 (rate limiter rejected it before execution)", async () => {
    mockAxios
      .mockRejectedValueOnce(
        httpError(429, { headers: { "retry-after": "1" } })
      )
      .mockResolvedValueOnce({ data: { response: { result: true } } });
    await expect(settle(api.sendCommand("honk"))).resolves.toEqual({
      result: true
    });
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 429 whose Retry-After exceeds the 60s cap, and reports the wait", async () => {
    mockAxios.mockRejectedValue(
      httpError(429, { headers: { "retry-after": "120" } })
    );
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/rate limit exceeded/);
    expect(err.message).toMatch(/wait 120s/);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429 at exactly the 60s cap", async () => {
    mockAxios
      .mockRejectedValueOnce(
        httpError(429, { headers: { "retry-after": "60" } })
      )
      .mockResolvedValueOnce({ data: { count: 0 } });
    await expect(settle(api.getDrives())).resolves.toEqual([]);
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 429 without Retry-After", async () => {
    mockAxios.mockRejectedValue(httpError(429));
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/rate limit exceeded/);
    expect(err.message).not.toMatch(/asked to wait/);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Single-destination hardening: www.teslafi.com is the only destination, ever
// (no redirects, no env-configured proxies)
// ---------------------------------------------------------------------------

describe("redirect and proxy hardening", () => {
  it("sets maxRedirects: 0 and proxy: false on every feed.php request", async () => {
    mockAxios.mockResolvedValue({ data: { battery_level: 72 } });
    await settle(api.getCurrentData());
    expect(axiosConfig().maxRedirects).toBe(0);
    expect(axiosConfig().proxy).toBe(false);
  });

  it("sets maxRedirects: 0 and proxy: false on every history.php request", async () => {
    mockAxios.mockResolvedValue({ data: { count: 0 } });
    await settle(api.getDrives());
    expect(axiosConfig().maxRedirects).toBe(0);
    expect(axiosConfig().proxy).toBe(false);
  });

  it("sets maxRedirects: 0 and proxy: false on command requests", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("wake_up"));
    expect(axiosConfig().maxRedirects).toBe(0);
    expect(axiosConfig().proxy).toBe(false);
  });

  it("keeps proxy: false on retried requests", async () => {
    mockAxios
      .mockRejectedValueOnce(netError("ENOTFOUND"))
      .mockResolvedValueOnce({ data: { count: 0 } });
    await settle(api.getDrives());
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(axiosConfig(0).proxy).toBe(false);
    expect(axiosConfig(1).proxy).toBe(false);
  });

  it("surfaces a redirect response as a clean error, without retrying", async () => {
    mockAxios.mockRejectedValue(
      httpError(302, { statusText: "Found" })
    );
    const err = await settleRejects(api.getDrives());
    expect(err.message).toMatch(/unexpected redirect \(HTTP 302\)/);
    expect(err.message).toMatch(/never follows redirects/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("feed.php");
    expect(mockAxios).toHaveBeenCalledTimes(1); // 3xx is never retried
  });

  it("maps permanent redirects (301) the same way", async () => {
    mockAxios.mockRejectedValue(httpError(301));
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toMatch(/unexpected redirect \(HTTP 301\)/);
    expect(err.message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// wake_seconds handling
// ---------------------------------------------------------------------------

describe("wake_seconds and no_wake", () => {
  it("scales the axios timeout and adds the wake param", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("wake_up", {}, 45));

    const cfg = axiosConfig();
    expect(cfg.timeout).toBe(30000 + 45 * 1000);
    expect(cfg.params.wake).toBe(45);
  });

  it("uses the default timeout and no wake param without wake_seconds", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("wake_up"));

    const cfg = axiosConfig();
    expect(cfg.timeout).toBe(30000);
    expect(cfg.params).not.toHaveProperty("wake");
  });

  it("accepts the official maximum of 60", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("wake_up", {}, 60));
    expect(axiosConfig().params.wake).toBe(60);
    expect(axiosConfig().timeout).toBe(30000 + 60 * 1000);
  });

  it.each([[61], [120], [0], [-5], [10.5]])(
    "rejects wake_seconds=%s at the service layer, without a network call",
    async (seconds) => {
      await expect(api.sendCommand("wake_up", {}, seconds)).rejects.toThrow(
        /wake_seconds must be an integer between 1 and 60/
      );
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );

  it("maps no_wake to the noWake=true query param", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("charge_start", {}, undefined, true));

    const cfg = axiosConfig();
    expect(cfg.params.noWake).toBe("true");
    expect(cfg.params).not.toHaveProperty("wake");
    expect(cfg.timeout).toBe(30000); // no wake window to cover
  });

  it("omits noWake entirely when no_wake is explicitly false (TeslaFi's own default)", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("charge_start", {}, undefined, false));
    expect(axiosConfig().params).not.toHaveProperty("noWake");
    expect(axiosConfig().params).not.toHaveProperty("wake");
  });

  it("rejects wake_seconds combined with no_wake, without a network call", async () => {
    await expect(
      api.sendCommand("charge_start", {}, 30, true)
    ).rejects.toThrow(/wake_seconds and no_wake are mutually exclusive/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("reports the wake-extended timeout in command timeout errors", async () => {
    mockAxios.mockRejectedValue(netError("ECONNABORTED"));
    const err = await settleRejects(api.sendCommand("wake_up", {}, 45));
    expect(err.message).toMatch(/timed out after 75s/);
    expect(err.message).toMatch(/may still have been executed/);
    expect(mockAxios).toHaveBeenCalledTimes(1); // mutating: no timeout retry
  });

  it("reports the default timeout for read timeouts, with retries", async () => {
    mockAxios.mockRejectedValue(netError("ECONNABORTED"));
    const err = await settleRejects(api.getCurrentData());
    expect(err.message).toMatch(/timed out after 30s/);
    expect(err.message).toMatch(/Please try again/);
    expect(mockAxios).toHaveBeenCalledTimes(3); // reads retry timeouts
  });
});

// ---------------------------------------------------------------------------
// Wake-conserving default: car commands never wake a sleeping car implicitly
// ---------------------------------------------------------------------------

describe("wake-conserving default (CAR_COMMANDS)", () => {
  const EXEMPT_COMMANDS = [
    "wake",
    "wake_up",
    "sleep",
    "enableLogging",
    "disableLogging",
    "command_count"
  ] as const;

  it("partitions the 24-command allowlist into 18 car + 6 account-side commands", () => {
    expect(CAR_COMMANDS.size).toBe(18);
    for (const name of TESLAFI_COMMAND_NAMES) {
      const isCar = CAR_COMMANDS.has(name);
      const isExempt = (EXEMPT_COMMANDS as readonly string[]).includes(name);
      // Every command is in exactly one group.
      expect(isCar !== isExempt, `${name} must be car XOR account-side`).toBe(
        true
      );
    }
  });

  it.each([...CAR_COMMANDS].map((c) => [c]))(
    "defaults %s to noWake=true when neither wake_seconds nor no_wake is given",
    async (command) => {
      mockAxios.mockResolvedValue({ data: { response: { result: true } } });
      await settle(api.sendCommand(command));
      expect(axiosConfig().params.noWake).toBe("true");
      expect(axiosConfig().params).not.toHaveProperty("wake");
    }
  );

  it.each(EXEMPT_COMMANDS.map((c) => [c]))(
    "never appends noWake to the account-side command %s",
    async (command) => {
      mockAxios.mockResolvedValue({ data: { response: { result: true } } });
      await settle(api.sendCommand(command));
      expect(axiosConfig().params).not.toHaveProperty("noWake");
    }
  );

  it("sends wake=X without noWake when wake_seconds is given for a car command", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("charge_start", {}, 20));
    expect(axiosConfig().params.wake).toBe(20);
    expect(axiosConfig().params).not.toHaveProperty("noWake");
  });

  it("rejects no_wake=true on an account-side command locally, without a network call", async () => {
    await expect(
      api.sendCommand("wake_up", {}, undefined, true)
    ).rejects.toThrow(/no_wake does not apply to the account-side command/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("silently ignores the no-op no_wake=false on an account-side command", async () => {
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    await settle(api.sendCommand("command_count", {}, undefined, false));
    expect(axiosConfig().params).not.toHaveProperty("noWake");
  });
});

// ---------------------------------------------------------------------------
// Request spacing gate
// ---------------------------------------------------------------------------

describe("request spacing", () => {
  it("spaces outbound requests at least 1s apart", async () => {
    mockAxios.mockResolvedValue({ data: { count: 0 } });
    const p1 = api.getDrives({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    const p2 = api.getDrives({ dateFrom: "2026-02-01", dateTo: "2026-02-28" });

    await vi.advanceTimersByTimeAsync(1);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(997); // t ~= 998ms
    expect(mockAxios).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10); // past 1000ms
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await Promise.all([p1, p2]);
  });
});

// ---------------------------------------------------------------------------
// Proactive rate-limit pacing (rate_limit.remaining / reset_in_seconds)
// ---------------------------------------------------------------------------

describe("proactive rate-limit pacing", () => {
  /** feed.php body carrying a rate_limit object. */
  const rlBody = (remaining: unknown, resetInSeconds: unknown) => ({
    data: {
      battery_level: 50,
      rate_limit: { limit: 15, remaining, reset_in_seconds: resetInSeconds }
    }
  });

  it("waits out the reported reset window when remaining hits 0", async () => {
    mockAxios.mockResolvedValue(rlBody(0, 30));
    await settle(api.getCurrentData());
    expect(mockAxios).toHaveBeenCalledTimes(1);

    const p = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(28_000);
    expect(mockAxios).toHaveBeenCalledTimes(1); // still inside the 30s window
    await vi.advanceTimersByTimeAsync(2_100); // past the 30s window
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await p;
  });

  it("does not wait once the reset window has already elapsed", async () => {
    mockAxios.mockResolvedValue(rlBody(0, 5));
    await settle(api.getCurrentData());
    await vi.advanceTimersByTimeAsync(6_000); // window (5s) elapsed while idle

    const p = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockAxios).toHaveBeenCalledTimes(2); // fired immediately
    await p;
  });

  it("caps the pacing wait at 60s even when the reported window is longer", async () => {
    mockAxios.mockResolvedValue(rlBody(0, 300));
    await settle(api.getCurrentData());

    const p = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(mockAxios).toHaveBeenCalledTimes(1); // inside the 60s cap
    await vi.advanceTimersByTimeAsync(1_200); // past the cap, far before 300s
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await p;
  });

  it("applies only the 1s spacing while remaining > 0", async () => {
    mockAxios.mockResolvedValue(rlBody(1, 30));
    await settle(api.getCurrentData());

    const p = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(1_100); // just the existing 1s spacing
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await p;
  });

  it("ignores a malformed rate_limit object instead of failing or waiting", async () => {
    mockAxios.mockResolvedValue(rlBody("not-a-number", "soon"));
    await settle(api.getCurrentData());

    const p = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(1_100); // nothing beyond the 1s spacing
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await p;
  });
});

// ---------------------------------------------------------------------------
// Adaptive token-bucket pacing (proactive, derived from rate_limit.limit)
// ---------------------------------------------------------------------------

describe("adaptive token-bucket pacing", () => {
  /** feed.php body carrying a full rate_limit object (limit + remaining + reset). */
  const rlBody = (
    limit: unknown,
    remaining: unknown,
    resetInSeconds: unknown
  ) => ({
    data: {
      battery_level: 50,
      rate_limit: { limit, remaining, reset_in_seconds: resetInSeconds }
    }
  });

  it("lets a handful of requests burst at the 1s floor after observing the limit", async () => {
    mockAxios.mockResolvedValue(rlBody(15, 15, 60));
    await settle(api.getCurrentData()); // req 1 seeds the bucket (capacity 15)
    expect(mockAxios).toHaveBeenCalledTimes(1);

    // Five follow-up requests each proceed at ~1s (well under the ~4s steady
    // rate): the seeded burst budget keeps short interactions fast. Each
    // response re-advertises limit=15 but must NOT reset the draining bucket.
    for (let i = 2; i <= 6; i++) {
      const p = api.getCurrentData();
      await vi.advanceTimersByTimeAsync(1_050);
      expect(mockAxios).toHaveBeenCalledTimes(i);
      await p;
    }
  });

  it("bursts up to the budget then paces sustained load to ~window/limit (~4s)", async () => {
    const sends: number[] = [];
    mockAxios.mockImplementation(() => {
      sends.push(Date.now());
      return Promise.resolve(rlBody(15, 15, 60));
    });

    // Fire many requests at once; they drain through the serializing gate.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      promises.push(api.getCurrentData());
    }
    await vi.runAllTimersAsync();
    await Promise.all(promises);

    expect(sends).toHaveLength(30);
    const gaps = sends.slice(1).map((t, i) => t - sends[i]);
    // Early gaps: the burst glides at roughly the 1s floor, far below 4s.
    expect(gaps[0]).toBeLessThan(1_500);
    expect(gaps[3]).toBeLessThan(1_500);
    // Late gaps: once the burst budget drains, requests converge to
    // window/limit = 60/15 = 4s (each 4s gap refills exactly one token).
    const lastGap = gaps[gaps.length - 1];
    expect(lastGap).toBeGreaterThanOrEqual(3_500);
    expect(lastGap).toBeLessThanOrEqual(4_500);
  });

  it("refills during idle so a single later request is not token-paced", async () => {
    // Small bucket (capacity 1, one token / 4s) so it drains in one request.
    mockAxios.mockResolvedValue(rlBody(1, 5, 4));
    await settle(api.getCurrentData()); // req 1 seeds bucket (capacity 1)

    const p2 = api.getCurrentData(); // req 2 spends the only token
    await vi.advanceTimersByTimeAsync(1_050);
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await p2;

    // Bucket is now empty; without idle the next request would wait ~4s. Idle
    // well past the window so the bucket refills back to capacity.
    await vi.advanceTimersByTimeAsync(10_000);

    const p3 = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(1_050); // only the 1s floor is needed
    expect(mockAxios).toHaveBeenCalledTimes(3);
    await p3;
  });

  it("empties the bucket then requires ~window/limit before the next send", async () => {
    // capacity 1, one token / 4s: request 2 drains it, request 3 must wait ~4s.
    mockAxios.mockResolvedValue(rlBody(1, 5, 4));
    await settle(api.getCurrentData()); // seed

    const p2 = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(1_050);
    expect(mockAxios).toHaveBeenCalledTimes(2); // burst token spent
    await p2;

    const p3 = api.getCurrentData();
    await vi.advanceTimersByTimeAsync(1_050); // the 1s floor alone is not enough
    expect(mockAxios).toHaveBeenCalledTimes(2); // still waiting for a token
    await vi.advanceTimersByTimeAsync(3_100); // ~4s total -> a token refilled
    expect(mockAxios).toHaveBeenCalledTimes(3);
    await p3;
  });

  it("stays on the 1s floor only while no rate_limit has been observed", async () => {
    mockAxios.mockResolvedValue({ data: { battery_level: 50 } }); // no rate_limit
    const p1 = api.getCurrentData();
    const p2 = api.getCurrentData();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(997); // t ~= 998ms
    expect(mockAxios).toHaveBeenCalledTimes(1); // no extra token-bucket wait
    await vi.advanceTimersByTimeAsync(10); // past 1000ms
    expect(mockAxios).toHaveBeenCalledTimes(2);
    await Promise.all([p1, p2]);
  });

  it.each([
    ["absent limit", { remaining: 5, reset_in_seconds: 60 }],
    ["zero limit", { limit: 0, remaining: 5, reset_in_seconds: 60 }],
    ["negative limit", { limit: -3, remaining: 5, reset_in_seconds: 60 }],
    ["non-finite limit", { limit: "lots", remaining: 5, reset_in_seconds: 60 }],
    ["zero window", { limit: 15, remaining: 5, reset_in_seconds: 0 }],
    ["non-finite window", { limit: 15, remaining: 5, reset_in_seconds: "soon" }]
  ])(
    "falls back to 1s-floor-only pacing for %s (no divide-by-zero, no hang)",
    async (_label, rateLimit) => {
      mockAxios.mockResolvedValue({
        data: { battery_level: 50, rate_limit: rateLimit }
      });
      await settle(api.getCurrentData()); // observe the (bad) advertised value

      const p = api.getCurrentData();
      await vi.advanceTimersByTimeAsync(1_050); // only the existing 1s spacing
      expect(mockAxios).toHaveBeenCalledTimes(2);
      await p;
    }
  );

  it("does not wedge when a retried read spends a token on each attempt", async () => {
    mockAxios.mockResolvedValue(rlBody(15, 5, 60));
    await settle(api.getCurrentData()); // seed bucket (capacity 15)

    // One transient failure then success: throttle() (and consumeToken) runs
    // twice for this single logical read. Must not deadlock the bucket.
    mockAxios.mockReset();
    mockAxios
      .mockRejectedValueOnce(netError("ETIMEDOUT"))
      .mockResolvedValue({ data: { count: 0 } });
    await expect(settle(api.getDrives())).resolves.toEqual([]);
    expect(mockAxios).toHaveBeenCalledTimes(2);

    // A further request still proceeds promptly (the bucket was not driven into
    // a negative wedge): plenty of burst budget remains.
    const p = api.getDrives({ dateFrom: "2026-03-01" });
    await vi.advanceTimersByTimeAsync(1_050);
    expect(mockAxios).toHaveBeenCalledTimes(3);
    await p;
  });
});

// ---------------------------------------------------------------------------
// Quota usage tracking (tesla_request_counter memory)
// ---------------------------------------------------------------------------

describe("quota usage tracking", () => {
  it("starts with no known usage", () => {
    expect(api.getQuotaUsage()).toBeNull();
  });

  it("remembers counters from data responses", async () => {
    mockAxios.mockResolvedValue({
      data: {
        battery_level: 72,
        tesla_request_counter: { commands: 123, wakes: 4 }
      }
    });
    await settle(api.getCurrentData());
    expect(api.getQuotaUsage()).toMatchObject({ commands: 123, wakes: 4 });
    expect(api.getQuotaUsage()?.at).toBeTypeOf("number");
  });

  it("remembers counters from command responses, including envelope placement", async () => {
    mockAxios.mockResolvedValue({
      data: {
        response: { result: true },
        tesla_request_counter: { commands: "42", wakes: "5" }
      }
    });
    await settle(api.sendCommand("honk"));
    expect(api.getQuotaUsage()).toMatchObject({ commands: 42, wakes: 5 });
  });

  it("keeps the previous counters when a later response has malformed ones", async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          battery_level: 72,
          tesla_request_counter: { commands: 10, wakes: 2 }
        }
      })
      .mockResolvedValueOnce({
        data: {
          battery_level: 71,
          tesla_request_counter: { commands: "many", wakes: null }
        }
      });
    await settle(api.getCurrentData());
    await settle(api.getCurrentData());
    expect(api.getQuotaUsage()).toMatchObject({ commands: 10, wakes: 2 });
  });
});

// ---------------------------------------------------------------------------
// Monthly allowance exhaustion: terminal, actionable errors
// ---------------------------------------------------------------------------

describe("monthly allowance exhaustion", () => {
  it("classifies an envelope wake-allowance error as terminal with an actionable message", async () => {
    mockAxios.mockResolvedValue({
      data: { response: { result: false, reason: "Monthly wake limit exceeded" } }
    });
    const err = await settleRejects(api.sendCommand("charge_start"));
    expect(err.message).toContain("NOT sent");
    expect(err.message).toContain("Monthly wake limit exceeded");
    expect(err.message).toMatch(/reset on the 1st of the month/);
    expect(err.message).toMatch(/purchased from TeslaFi support/);
    expect(mockAxios).toHaveBeenCalledTimes(1); // terminal: never retried
  });

  it("includes the last-known usage when available", async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          response: { result: true },
          tesla_request_counter: { commands: 480, wakes: 50 }
        }
      })
      .mockResolvedValueOnce({
        data: {
          response: {
            result: false,
            reason: "wake count exceeded for this month"
          }
        }
      });
    await settle(api.sendCommand("honk"));
    const err = await settleRejects(api.sendCommand("honk"));
    expect(err.message).toContain("480/500 commands");
    expect(err.message).toContain("50/50 wakes");
  });

  it("classifies a plain-text allowance body from a command", async () => {
    mockAxios.mockResolvedValue({
      data: "You have exceeded your monthly command allowance"
    });
    const err = await settleRejects(api.sendCommand("honk"));
    expect(err.message).toContain("NOT sent");
    expect(err.message).toMatch(/1st of the month/);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("also classifies top-level error envelopes mentioning the allowance", async () => {
    mockAxios.mockResolvedValue({
      data: { error: "quota_exceeded", error_description: "wake quota used up" }
    });
    const err = await settleRejects(api.sendCommand("door_lock"));
    expect(err.message).toContain("NOT sent");
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("does not misclassify ordinary command failures", async () => {
    mockAxios.mockResolvedValue({
      data: { response: { result: false, reason: "This command is not enabled" } }
    });
    const err = await settleRejects(api.sendCommand("honk"));
    expect(err.message).toBe("This command is not enabled");
    expect(err.message).not.toContain("allowance");
  });

  it("does not misclassify auth errors", async () => {
    mockAxios.mockResolvedValue({
      data: { response: { result: "unauthorized" } }
    });
    const err = await settleRejects(api.sendCommand("honk"));
    expect(err.message).toMatch(/token is unauthorized/);
    expect(err.message).not.toContain("allowance");
  });
});

// ---------------------------------------------------------------------------
// Permissive-match heuristics (undocumented TeslaFi payloads)
// ---------------------------------------------------------------------------

describe("isMonthlyAllowanceError heuristic", () => {
  it.each([
    ["Monthly wake limit exceeded"],
    ["You have exceeded your monthly command allowance"],
    ["wake count exceeded"],
    ["command limit reached for this account"],
    ["Quota exhausted"]
  ])("matches allowance phrasing: %s", (text) => {
    expect(isMonthlyAllowanceError(text)).toBe(true);
  });

  it.each([
    ["Invalid TeslaFi API token. Please check your credentials."],
    ["This command is not enabled"],
    ["You are not logged in"],
    ["bad request token=[redacted]"],
    ["Rate limit exceeded, try again in 30 seconds"],
    ["TeslaFi API request failed."],
    [""]
  ])("leaves ordinary errors alone: %s", (text) => {
    expect(isMonthlyAllowanceError(text)).toBe(false);
  });
});

describe("indicatesUnsentAsleep heuristic", () => {
  it.each([
    [{ response: { result: "unsent" } }],
    [{ result: "unsent", reason: "vehicle asleep" }],
    ["Vehicle is asleep - command not sent (noWake)"],
    ["Command was not sent: car is sleeping"]
  ])("matches unsent/asleep phrasing: %j", (value) => {
    expect(indicatesUnsentAsleep(value)).toBe(true);
  });

  it.each([
    [{ result: true, reason: "" }],
    ["Sleep attempt started"],
    ["Invalid TeslaFi API token. Please check your credentials."],
    [{ state: "asleep" }], // asleep alone, no unsent indication
    [""]
  ])("does not match ordinary responses: %j", (value) => {
    expect(indicatesUnsentAsleep(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// History TTL cache
// ---------------------------------------------------------------------------

describe("history cache", () => {
  const range = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };

  it("serves a second identical query from cache within the TTL", async () => {
    mockAxios.mockResolvedValue({ data: [{ id: "1" }] });
    const first = await settle(api.getDrives(range));
    const second = await settle(api.getDrives(range));

    expect(first).toEqual([{ id: "1" }]);
    expect(second).toEqual([{ id: "1" }]);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent identical queries onto one in-flight request", async () => {
    mockAxios.mockResolvedValue({ data: [{ id: "1" }] });
    const [a, b] = await settle(
      Promise.all([api.getDrives(range), api.getDrives(range)])
    );
    expect(a).toEqual(b);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("expires entries after the default 60s TTL", async () => {
    mockAxios.mockResolvedValue({ data: [{ id: "1" }] });
    await settle(api.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    await settle(api.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(1); // still cached at 59s

    await vi.advanceTimersByTimeAsync(2_000); // past 60s
    await settle(api.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("respects TESLAFI_CACHE_TTL_SECONDS", async () => {
    process.env.TESLAFI_CACHE_TTL_SECONDS = "300";
    const longApi = new TeslaFIAPI(TOKEN);
    mockAxios.mockResolvedValue({ data: [{ id: "1" }] });

    await settle(longApi.getDrives(range));
    await vi.advanceTimersByTimeAsync(120_000); // > default 60s, < 300s
    await settle(longApi.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200_000); // past 300s
    await settle(longApi.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it.each([["empty", ""], ["whitespace-only", "   "]])(
    "falls back to the default 60s TTL when TESLAFI_CACHE_TTL_SECONDS is %s (does NOT disable caching)",
    async (_label, value) => {
      process.env.TESLAFI_CACHE_TTL_SECONDS = value;
      const defaulted = new TeslaFIAPI(TOKEN);
      mockAxios.mockResolvedValue({ data: [{ id: "1" }] });

      // Number("") === 0 must not sneak through as "cache disabled":
      // a second identical query within the default TTL stays cached.
      await settle(defaulted.getDrives(range));
      await settle(defaulted.getDrives(range));
      expect(mockAxios).toHaveBeenCalledTimes(1);

      // And the default 60s expiry still applies.
      await vi.advanceTimersByTimeAsync(61_000);
      await settle(defaulted.getDrives(range));
      expect(mockAxios).toHaveBeenCalledTimes(2);
    }
  );

  it("falls back to the default TTL for non-numeric values", async () => {
    process.env.TESLAFI_CACHE_TTL_SECONDS = "not-a-number";
    const defaulted = new TeslaFIAPI(TOKEN);
    mockAxios.mockResolvedValue({ data: [{ id: "1" }] });

    await settle(defaulted.getDrives(range));
    await settle(defaulted.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("TESLAFI_CACHE_TTL_SECONDS=0 disables caching", async () => {
    process.env.TESLAFI_CACHE_TTL_SECONDS = "0";
    const uncached = new TeslaFIAPI(TOKEN);
    mockAxios.mockResolvedValue({ data: [{ id: "1" }] });

    await settle(uncached.getDrives(range));
    await settle(uncached.getDrives(range));
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("misses the cache for a different date window", async () => {
    mockAxios.mockResolvedValue({ data: [] });
    await settle(api.getDrives(range));
    await settle(api.getDrives({ dateFrom: "2026-06-01", dateTo: "2026-06-30" }));
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("caches drives and charges separately", async () => {
    mockAxios.mockResolvedValue({ data: [] });
    await settle(api.getDrives(range));
    await settle(api.getCharges(range));
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(axiosConfig(0).params.command).toBe("drives");
    expect(axiosConfig(1).params.command).toBe("charges");
  });

  it("does not cache failures", async () => {
    mockAxios
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValueOnce({ data: [{ id: "1" }] });

    await settleRejects(api.getDrives(range));
    await expect(settle(api.getDrives(range))).resolves.toEqual([{ id: "1" }]);
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  it("prunes expired entries once the cache exceeds 50 keys", async () => {
    process.env.TESLAFI_CACHE_TTL_SECONDS = "1";
    const pruning = new TeslaFIAPI(TOKEN);
    mockAxios.mockResolvedValue({ data: [] });

    // 52 distinct keys; the 1s request spacing means each prior entry has
    // expired (1s TTL) by the time the next lands. Insert #51 triggers the
    // size>50 prune of everything expired.
    for (let i = 0; i < 52; i++) {
      await settle(pruning.getDrives({ dateFrom: `range-${i}` }));
    }
    expect(mockAxios).toHaveBeenCalledTimes(52);
    expect((pruning as any).historyCache.size).toBeLessThanOrEqual(2);
  });

  it("caps live entries at 50 even when a long TTL keeps them all unexpired", async () => {
    // With a day-long TTL nothing expires during the test, so the size cap —
    // not TTL expiry — is what must keep the map bounded.
    process.env.TESLAFI_CACHE_TTL_SECONDS = "86400";
    const capped = new TeslaFIAPI(TOKEN);
    mockAxios.mockResolvedValue({ data: [] });

    for (let i = 0; i < 60; i++) {
      await settle(capped.getDrives({ dateFrom: `range-${i}` }));
    }
    expect(mockAxios).toHaveBeenCalledTimes(60);
    expect((capped as any).historyCache.size).toBeLessThanOrEqual(50);

    // The oldest key was evicted: re-querying it hits the network again...
    await settle(capped.getDrives({ dateFrom: "range-0" }));
    expect(mockAxios).toHaveBeenCalledTimes(61);

    // ...while the newest key is still served from the cache.
    await settle(capped.getDrives({ dateFrom: "range-59" }));
    expect(mockAxios).toHaveBeenCalledTimes(61);
  });
});

// ---------------------------------------------------------------------------
// Happy paths for every public service method
// ---------------------------------------------------------------------------

describe("service method happy paths", () => {
  const DRIVE = {
    id: "7",
    date: "2026-07-05 06:30:00",
    startingLocationName: "",
    startingAddress: "1 Church St",
    locationName: "Acme HQ",
    kilometers: "25.4",
    miles: "15.8",
    dayDriveHours: "0",
    dayDriveMinutes: "31"
  };

  it("getCurrentData('current') requests feed.php without a command param", async () => {
    mockAxios.mockResolvedValue({ data: { battery_level: 72 } });
    const data = await settle(api.getCurrentData());
    expect(data).toEqual({ battery_level: 72 });

    const cfg = axiosConfig();
    expect(cfg.url).toBe(FEED_URL);
    expect(cfg.params).not.toHaveProperty("command");
    expect(cfg.params.token).toBe(TOKEN);
  });

  it("getLastGoodData uses command=lastGood", async () => {
    mockAxios.mockResolvedValue({ data: { battery_level: 72 } });
    await settle(api.getLastGoodData());
    expect(axiosConfig().params.command).toBe("lastGood");
  });

  it("getLastGoodTempData uses command=lastGoodTemp", async () => {
    mockAxios.mockResolvedValue({ data: { inside_temp: "21.0" } });
    await settle(api.getLastGoodTempData());
    expect(axiosConfig().params.command).toBe("lastGoodTemp");
  });

  it("getDrives passes the date range to history.php", async () => {
    mockAxios.mockResolvedValue({ data: [DRIVE] });
    const drives = await settle(
      api.getDrives({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })
    );
    expect(drives).toEqual([DRIVE]);

    const cfg = axiosConfig();
    expect(cfg.url).toBe(HISTORY_URL);
    expect(cfg.params).toMatchObject({
      command: "drives",
      token: TOKEN,
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31"
    });
  });

  it("getDrives omits date params when no range is given", async () => {
    mockAxios.mockResolvedValue({ data: [] });
    await settle(api.getDrives());
    expect(axiosConfig().params).not.toHaveProperty("dateFrom");
    expect(axiosConfig().params).not.toHaveProperty("dateTo");
  });

  it("getCharges requests command=charges", async () => {
    const charge = { id: "9", date: "2026-07-03 22:00:00", locationName: "Home" };
    mockAxios.mockResolvedValue({ data: [charge] });
    const charges = await settle(api.getCharges());
    expect(charges).toEqual([charge]);
    expect(axiosConfig().params.command).toBe("charges");
  });

  it("getTripsForMonth normalizes drives (UTC dates, km preferred, duration)", async () => {
    mockAxios.mockResolvedValue({ data: [DRIVE] });
    const trips = await settle(api.getTripsForMonth(2026, 7));

    expect(axiosConfig().params).toMatchObject({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31"
    });
    expect(trips).toHaveLength(1);
    expect(trips[0]).toEqual({
      id: 7,
      start_date: "2026-07-05T06:30:00.000Z",
      end_date: "2026-07-05T07:01:00.000Z",
      start_location: "1 Church St", // startingAddress fallback
      end_location: "Acme HQ",
      distance: 25.4,
      distance_unit: "km",
      // Both systems are selected from TeslaFi's pre-existing fields (not
      // re-converted), so the unit-aware renderers can present either.
      distance_km: 25.4,
      distance_mi: 15.8,
      duration_minutes: 31
    });
    expect(trips[0]).not.toHaveProperty("raw");
  });

  it("getTripsForMonth falls back to miles when kilometers are missing", async () => {
    mockAxios.mockResolvedValue({
      data: [{ ...DRIVE, kilometers: "", miles: "15.8" }]
    });
    const trips = await settle(api.getTripsForMonth(2026, 7));
    expect(trips[0].distance).toBe(15.8);
    expect(trips[0].distance_unit).toBe("mi");
  });

  it("getTripsForMonth embeds raw records only when include_raw is true", async () => {
    mockAxios.mockResolvedValue({ data: [DRIVE] });
    const withRaw = await settle(api.getTripsForMonth(2026, 7, true));
    expect(withRaw[0].raw).toEqual(DRIVE);

    const fresh = new TeslaFIAPI(TOKEN);
    const withoutRaw = await settle(fresh.getTripsForMonth(2026, 7, false));
    expect(withoutRaw[0]).not.toHaveProperty("raw");
  });

  it("analyzeHomeWorkTrips counts commutes with loose, case-insensitive matching", async () => {
    mockAxios.mockResolvedValue({
      data: [
        { ...DRIVE, id: "1", startingLocationName: "My Home", locationName: "ACME HQ" },
        { ...DRIVE, id: "2", startingLocationName: "Acme HQ", locationName: "Home" },
        { ...DRIVE, id: "3", startingLocationName: "Home", locationName: "Supermarket" }
      ]
    });
    const result = await settle(
      api.analyzeHomeWorkTrips(2026, 7, "home", "acme hq")
    );
    expect(result.total_trips).toBe(3);
    expect(result.home_to_work_trips).toBe(1);
    expect(result.work_to_home_trips).toBe(1);
    expect(result.other_trips).toBe(1);
    expect(result.trips).toHaveLength(2);
    expect(result.trips_truncated).toBe(false);
  });

  it("analyzeHomeWorkTrips caps the matched-trip list at 500 and flags truncation", async () => {
    const drives = Array.from({ length: MAX_ANALYSIS_TRIPS + 2 }, (_, i) => ({
      ...DRIVE,
      id: String(i + 1),
      startingLocationName: "Home",
      locationName: "Acme HQ"
    }));
    mockAxios.mockResolvedValue({ data: drives });
    const result = await settle(
      api.analyzeHomeWorkTrips(2026, 7, "Home", "Acme HQ")
    );

    expect(MAX_ANALYSIS_TRIPS).toBe(500);
    expect(result.total_trips).toBe(502);
    expect(result.home_to_work_trips).toBe(502); // counts cover the full month
    expect(result.trips).toHaveLength(500); // embedded list is capped
    expect(result.trips_truncated).toBe(true);
  });

  it("getLocations aggregates tagged (named) locations, each flagged named=true", async () => {
    mockAxios.mockResolvedValue({
      data: [
        // startingAddress is blanked so empty/"unknown"-named endpoints with no
        // key or address are genuinely unidentifiable and skipped.
        { ...DRIVE, startingLocationName: "Home", startingAddress: "", locationName: "Acme HQ" },
        { ...DRIVE, startingLocationName: "Acme HQ", startingAddress: "", locationName: "Home" },
        // Empty end name, no key/address -> unidentifiable -> skipped.
        { ...DRIVE, startingLocationName: "Home", startingAddress: "", locationName: "" },
        // "unknown" start name, no key/address -> skipped.
        { ...DRIVE, startingLocationName: "unknown", startingAddress: "", locationName: "Home" }
      ]
    });
    const locations = await settle(
      api.getLocations({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })
    );

    expect(axiosConfig().params).toMatchObject({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31"
    });
    expect(locations).toEqual([
      { name: "Home", visits: 4, as_start: 2, as_end: 2, named: true },
      { name: "Acme HQ", visits: 2, as_start: 1, as_end: 1, named: true }
    ]);
  });

  it("surfaces frequently-visited UNTAGGED locations via locationKey (named=false)", async () => {
    const dorsettAddress = "9 Dorsett Road, Talbot Green, Pontyclun CF72 8XY, UK";
    const drive = (over: Record<string, unknown>) => ({ ...DRIVE, ...over });

    const drives = [
      // 9 drives Home -> 9 Dorsett Road (untagged end: name "", key set).
      ...Array.from({ length: 9 }, () =>
        drive({
          startingLocationName: "Home",
          locationName: "",
          locationKey: "9DorsettRo",
          address: dorsettAddress
        })
      ),
      // 9 drives 9 Dorsett Road (untagged start) -> Home.
      ...Array.from({ length: 9 }, () =>
        drive({
          startingLocationName: "",
          startingLocationKey: "9DorsettRo",
          startingAddress: dorsettAddress,
          locationName: "Home"
        })
      ),
      // 6 drives Home -> Supercharger (tagged).
      ...Array.from({ length: 6 }, () =>
        drive({
          startingLocationName: "Home",
          locationName: "Pontprennau Supercharger"
        })
      ),
      // 5 drives Supercharger -> Home.
      ...Array.from({ length: 5 }, () =>
        drive({
          startingLocationName: "Pontprennau Supercharger",
          locationName: "Home"
        })
      )
    ];
    expect(drives).toHaveLength(29);

    mockAxios.mockResolvedValue({ data: drives });
    const locations = await settle(api.getLocations());

    // The untagged Dorsett Road address is now surfaced, grouped by locationKey
    // across BOTH roles (9 as start + 9 as end), with a readable inferred name.
    const inferred = locations.filter((l) => !l.named);
    expect(inferred).toEqual([
      {
        name: "9 Dorsett Road, Talbot Green",
        visits: 18,
        as_start: 9,
        as_end: 9,
        named: false
      }
    ]);

    // Tagged locations still appear, flagged named=true.
    const home = locations.find((l) => l.name === "Home");
    expect(home).toMatchObject({ named: true, visits: 29, as_start: 15, as_end: 14 });
    const supercharger = locations.find(
      (l) => l.name === "Pontprennau Supercharger"
    );
    expect(supercharger).toMatchObject({ named: true, visits: 11 });

    // Sorted by visits desc.
    expect(locations.map((l) => l.name)).toEqual([
      "Home",
      "9 Dorsett Road, Talbot Green",
      "Pontprennau Supercharger"
    ]);
  });

  it("groups an untagged locationKey stably across start and end roles", async () => {
    mockAxios.mockResolvedValue({
      data: [
        // Same place (key "9DorsettRo") as an END on one drive...
        {
          ...DRIVE,
          startingLocationName: "Home",
          startingAddress: "",
          locationName: "",
          locationKey: "9DorsettRo",
          address: "9 Dorsett Road, Talbot Green"
        },
        // ...and as a START on another: they must merge into ONE entry.
        {
          ...DRIVE,
          startingLocationName: "",
          startingLocationKey: "9DorsettRo",
          startingAddress: "9 Dorsett Road, Talbot Green",
          locationName: "Home"
        }
      ]
    });
    const locations = await settle(api.getLocations());
    const inferred = locations.filter((l) => !l.named);
    expect(inferred).toHaveLength(1);
    expect(inferred[0]).toEqual({
      name: "9 Dorsett Road, Talbot Green",
      visits: 2,
      as_start: 1,
      as_end: 1,
      named: false
    });
  });

  it("skips an endpoint with no name, key, or address (unidentifiable)", async () => {
    mockAxios.mockResolvedValue({
      data: [
        {
          ...DRIVE,
          startingLocationName: "",
          startingAddress: "",
          startingLocationKey: "",
          locationName: "",
          address: "",
          locationKey: ""
        }
      ]
    });
    const locations = await settle(api.getLocations());
    expect(locations).toEqual([]);
  });

  it("sendCommand returns the unwrapped TeslaFi response", async () => {
    mockAxios.mockResolvedValue({
      data: { response: { result: true, reason: "" } }
    });
    await expect(
      settle(api.sendCommand("set_sentry_mode", { sentryMode: 1 }))
    ).resolves.toEqual({ result: true, reason: "" });
    expect(axiosConfig().params.sentryMode).toBe(1);
  });

  it("preserves a tesla_request_counter that sits on the response envelope", async () => {
    mockAxios.mockResolvedValue({
      data: {
        response: { result: true, reason: "" },
        tesla_request_counter: { commands: 12, wakes: 3 }
      }
    });
    await expect(settle(api.sendCommand("honk"))).resolves.toEqual({
      result: true,
      reason: "",
      tesla_request_counter: { commands: 12, wakes: 3 }
    });
  });

  it("never overwrites a tesla_request_counter already inside the response", async () => {
    mockAxios.mockResolvedValue({
      data: {
        response: {
          result: true,
          tesla_request_counter: { commands: 7, wakes: 1 }
        },
        tesla_request_counter: { commands: 999, wakes: 999 }
      }
    });
    const result = await settle(api.sendCommand("honk"));
    expect(result.tesla_request_counter).toEqual({ commands: 7, wakes: 1 });
  });
});

// ---------------------------------------------------------------------------
// command_count: officially a command, effectively read-only
// ---------------------------------------------------------------------------

describe("command_count", () => {
  it("requests feed.php with command=command_count", async () => {
    mockAxios.mockResolvedValue({
      data: { tesla_request_counter: { commands: 42, wakes: 5 } }
    });
    const result = await settle(api.sendCommand("command_count"));
    expect(result.tesla_request_counter).toEqual({ commands: 42, wakes: 5 });
    expect(axiosConfig().params.command).toBe("command_count");
  });

  it("is retried like a read on mid-flight failures (it changes nothing)", async () => {
    mockAxios
      .mockRejectedValueOnce(netError("ECONNRESET"))
      .mockResolvedValueOnce({
        data: { tesla_request_counter: { commands: 42, wakes: 5 } }
      });
    await expect(settle(api.sendCommand("command_count"))).resolves.toEqual({
      tesla_request_counter: { commands: 42, wakes: 5 }
    });
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// monthToDateRange helper
// ---------------------------------------------------------------------------

describe("monthToDateRange", () => {
  it("covers a 31-day month", () => {
    expect(monthToDateRange(2026, 7)).toEqual({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31"
    });
  });

  it("handles leap and non-leap February", () => {
    expect(monthToDateRange(2024, 2).dateTo).toBe("2024-02-29");
    expect(monthToDateRange(2026, 2).dateTo).toBe("2026-02-28");
  });

  it("zero-pads single-digit months", () => {
    expect(monthToDateRange(2026, 3)).toEqual({
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31"
    });
  });
});

// ---------------------------------------------------------------------------
// Units: resolution order (pure, no network)
// ---------------------------------------------------------------------------

describe("resolveUnits resolution order", () => {
  it("tier 1: an explicit arg wins over env and account measure", () => {
    expect(resolveUnits("imperial", "metric", "metric")).toBe("imperial");
    expect(resolveUnits("both", "metric", "imperial")).toBe("both");
    expect(resolveUnits("metric", "imperial", "imperial")).toBe("metric");
  });

  it("tier 2: TESLAFI_UNITS env is honored (case-insensitive, trimmed)", () => {
    expect(resolveUnits(undefined, "Imperial", "metric")).toBe("imperial");
    expect(resolveUnits(undefined, "  METRIC ", "imperial")).toBe("metric");
  });

  it("ignores an invalid/unknown env value and falls through", () => {
    // "automatic" is the manifest default sentinel: it must be ignored so the
    // account measure (tier 3) decides.
    expect(resolveUnits(undefined, "automatic", "imperial")).toBe("imperial");
    expect(resolveUnits(undefined, "furlongs", null)).toBe("metric");
    expect(resolveUnits(undefined, "", "metric")).toBe("metric");
    // env "both" is NOT a valid pin (env only pins metric/imperial).
    expect(resolveUnits(undefined, "both", "imperial")).toBe("imperial");
  });

  it("tier 3: account measure ('metric' -> metric; anything else -> imperial)", () => {
    expect(resolveUnits(undefined, undefined, "metric")).toBe("metric");
    expect(resolveUnits(undefined, undefined, "Metric")).toBe("metric");
    expect(resolveUnits(undefined, undefined, "imperial")).toBe("imperial");
    expect(resolveUnits(undefined, undefined, "us")).toBe("imperial");
  });

  it("tier 4: metric fallback when nothing is set", () => {
    expect(resolveUnits(undefined, undefined, undefined)).toBe("metric");
    expect(resolveUnits(null, null, null)).toBe("metric");
    expect(resolveUnits(undefined, undefined, "")).toBe("metric");
  });

  it("rejects an invalid explicit arg and falls through to lower tiers", () => {
    expect(resolveUnits("bogus", "imperial", "metric")).toBe("imperial");
    // The enum is case-sensitive: "BOTH" is not accepted, falls to measure.
    expect(resolveUnits("BOTH", undefined, "metric")).toBe("metric");
  });
});

// ---------------------------------------------------------------------------
// Units: live-feed conversions (Tesla-native -> chosen system)
// ---------------------------------------------------------------------------

describe("unit converters", () => {
  it("miToKm / mphToKmh use the 1.609344 factor (rounded to 1 dp for display)", () => {
    expect(miToKm(100)).toBe(160.9); // 160.9344 -> 160.9
    expect(miToKm(1)).toBe(1.6); // 1.609344 -> 1.6
    expect(mphToKmh(10)).toBe(16.1); // 16.09344 -> 16.1
  });

  it("cToF converts Celsius to Fahrenheit by formula", () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(cToF(20)).toBe(68);
  });

  it("psiToBar / barToPsi round-trip with the 14.5037738 factor", () => {
    expect(psiToBar(14.5037738)).toBeCloseTo(1, 2);
    expect(barToPsi(1)).toBeCloseTo(14.5, 1);
  });

  it("mToFt converts metres to feet", () => {
    expect(mToFt(100)).toBeCloseTo(328.1, 1);
  });
});

describe("normalizeFeedData live-feed conversions", () => {
  it("converts miles->km for metric and keeps miles for imperial", () => {
    const raw = { odometer: "100" };
    const m = normalizeFeedData(raw, "metric");
    expect(m.odometer_km).toBeCloseTo(160.9, 1);
    expect(m).not.toHaveProperty("odometer_mi");

    const im = normalizeFeedData(raw, "imperial");
    expect(im.odometer_mi).toBe(100);
    expect(im).not.toHaveProperty("odometer_km");
  });

  it("converts mph->km/h for speed", () => {
    expect(normalizeFeedData({ speed: "60" }, "metric").speed_kmh).toBeCloseTo(
      96.6,
      1
    );
    expect(normalizeFeedData({ speed: "60" }, "imperial").speed_mph).toBe(60);
  });

  it("prefers the provided *F field for imperial temperatures", () => {
    // A deliberately inconsistent *F value proves the *F field is used, not
    // the C->F formula (which would give 68).
    const im = normalizeFeedData(
      { inside_temp: "20", inside_tempF: "70" },
      "imperial"
    );
    expect(im.inside_temp_f).toBe(70);
    expect(im).not.toHaveProperty("inside_temp_c");
  });

  it("derives °F via formula when no *F field is present", () => {
    const im = normalizeFeedData(
      { passenger_temp_setting: "20" },
      "imperial"
    );
    expect(im.passenger_temp_setting_f).toBeCloseTo(68, 1);
  });

  it("keeps °C for metric and consumes the *F source field", () => {
    const m = normalizeFeedData(
      { inside_temp: "21.5", inside_tempF: "70" },
      "metric"
    );
    expect(m.inside_temp_c).toBe(21.5);
    expect(m).not.toHaveProperty("inside_temp_f");
    expect(m).not.toHaveProperty("inside_tempF"); // *F source consumed
    expect(m).not.toHaveProperty("inside_temp"); // no bare physical field
  });

  it("converts psi->bar for metric and keeps psi for imperial", () => {
    const m = normalizeFeedData({ tpms_front_left: "42" }, "metric");
    expect(m.tpms_front_left_bar).toBeCloseTo(42 / 14.5037738, 2);
    expect(normalizeFeedData({ tpms_front_left: "42" }, "imperial")
      .tpms_front_left_psi).toBe(42);
  });

  it("converts elevation metres->feet for imperial, keeps metres for metric", () => {
    expect(normalizeFeedData({ elevation: "100" }, "metric").elevation_m).toBe(
      100
    );
    expect(
      normalizeFeedData({ elevation: "100" }, "imperial").elevation_ft
    ).toBeCloseTo(328.1, 1);
  });

  it("never converts kWh or percent — only labels them (single field)", () => {
    const both = normalizeFeedData(
      { charge_energy_added: "18.6", battery_level: "72" },
      "both"
    );
    expect(both.charge_energy_added_kwh).toBe(18.6);
    expect(both.battery_level_pct).toBe(72);
    // No system-specific variants for kWh / percent.
    expect(both).not.toHaveProperty("charge_energy_added_kwh_mi");
    expect(both).not.toHaveProperty("battery_level_pct_mi");
  });

  it("both-mode emits BOTH suffixed fields for a converted quantity", () => {
    const both = normalizeFeedData({ odometer: "100" }, "both");
    expect(both.odometer_km).toBeCloseTo(160.9, 1);
    expect(both.odometer_mi).toBe(100);
  });

  it("passes non-physical fields through and stamps a top-level units", () => {
    const out = normalizeFeedData(
      { state: "online", display_name: "Car", measure: "metric" },
      "metric"
    );
    expect(out.state).toBe("online");
    expect(out.display_name).toBe("Car");
    expect(out.measure).toBe("metric");
    expect(out.units).toBe("metric");
  });

  it("emits null (never a bare value) for an empty physical field", () => {
    const out = normalizeFeedData({ odometer: "" }, "metric");
    expect(out.odometer_km).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Units: history field selection (records already carry BOTH systems)
// ---------------------------------------------------------------------------

describe("selectDriveUnitFields (history field selection)", () => {
  const REC = {
    kilometers: "40",
    miles: "24.85",
    whKilo: "150",
    whMile: "241",
    speedAVGK: "48",
    speedAVG: "30",
    speedMAXK: "100",
    speedMAX: "62",
    // Single-source history fields: °C only and bar only.
    temperatureAVG: "20",
    tpmsAvg: "2.9",
    driveKwh: "7.4"
  };

  it("metric selects TeslaFi's own metric fields (kilometers/whKilo/speedAVGK)", () => {
    const m = selectDriveUnitFields(REC, "metric");
    expect(m.distance_km).toBe(40);
    expect(m.efficiency_wh_km).toBe(150);
    expect(m.speed_avg_kmh).toBe(48);
    expect(m.speed_max_kmh).toBe(100);
    expect(m).not.toHaveProperty("distance_mi");
    expect(m).not.toHaveProperty("efficiency_wh_mi");
    // Single-source fields keep their native metric unit.
    expect(m.temperature_avg_c).toBe(20);
    expect(m.tpms_avg_bar).toBe(2.9);
    expect(m.drive_kwh).toBe(7.4);
    expect(m).not.toHaveProperty("temperature_avg_f");
    expect(m).not.toHaveProperty("tpms_avg_psi");
  });

  it("imperial selects TeslaFi's own imperial fields (miles/whMile/speedAVG)", () => {
    const im = selectDriveUnitFields(REC, "imperial");
    expect(im.distance_mi).toBe(24.85);
    expect(im.efficiency_wh_mi).toBe(241);
    expect(im.speed_avg_mph).toBe(30);
    expect(im.speed_max_mph).toBe(62);
    expect(im).not.toHaveProperty("distance_km");
    expect(im).not.toHaveProperty("speed_avg_kmh");
    // Single-source fields are CONVERTED for imperial (only these two, since
    // TeslaFi stores temps in °C and tyre pressure in bar).
    expect(im.temperature_avg_f).toBeCloseTo(68, 1); // 20 °C -> 68 °F
    expect(im.tpms_avg_psi).toBeCloseTo(2.9 * 14.5037738, 1); // bar -> psi
    expect(im.drive_kwh).toBe(7.4); // kWh never converts
    expect(im).not.toHaveProperty("temperature_avg_c");
    expect(im).not.toHaveProperty("tpms_avg_bar");
  });

  it("NEITHER path re-converts (selected values are TeslaFi's, not derived)", () => {
    const m = selectDriveUnitFields(REC, "metric");
    const im = selectDriveUnitFields(REC, "imperial");
    // Re-converting miles->km would give 24.85*1.609344 = 39.99..., not 40.
    expect(m.distance_km).toBe(40);
    // Re-converting speedAVGK->mph would give 48/1.609344 = 29.8, not 30.
    expect(im.speed_avg_mph).toBe(30);
  });

  it("both-mode returns both systems' selected fields", () => {
    const both = selectDriveUnitFields(REC, "both");
    expect(both.distance_km).toBe(40);
    expect(both.distance_mi).toBe(24.85);
    expect(both.efficiency_wh_km).toBe(150);
    expect(both.efficiency_wh_mi).toBe(241);
    expect(both.speed_avg_kmh).toBe(48);
    expect(both.speed_avg_mph).toBe(30);
  });

  it("missing per-system fields become null", () => {
    const m = selectDriveUnitFields({ kilometers: "10" }, "metric");
    expect(m.distance_km).toBe(10);
    expect(m.efficiency_wh_km).toBeNull();
    expect(m.speed_avg_kmh).toBeNull();
    expect(m.speed_max_kmh).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shared env-flag truthiness (TESLAFI_ENABLE_COMMANDS / TESLAFI_CHECK_UPDATES)
// ---------------------------------------------------------------------------

describe("envFlagEnabled", () => {
  it.each([["true"], ["TRUE"], [" true "], ["1"], ["yes"], ["YES"]])(
    "treats %j as enabled",
    (value) => {
      expect(envFlagEnabled(value)).toBe(true);
    }
  );

  it.each([
    [undefined],
    [null],
    [""],
    ["   "],
    ["false"],
    ["FALSE"],
    ["0"],
    ["no"],
    ["on"],
    ["enabled"]
  ])("treats %j as disabled", (value) => {
    expect(envFlagEnabled(value as string | null | undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semver numeric comparison (pure)
// ---------------------------------------------------------------------------

describe("semver compare (parseSemver / isNewerVersion)", () => {
  it("compares numerically, not lexically (10.0.0 > 9.9.9)", () => {
    expect(isNewerVersion("10.0.0", "9.9.9")).toBe(true);
    expect(isNewerVersion("9.9.9", "10.0.0")).toBe(false);
    expect(isNewerVersion("2.10.0", "2.9.9")).toBe(true);
    expect(isNewerVersion("2.0.10", "2.0.9")).toBe(true);
  });

  it("strips a leading v (either side)", () => {
    expect(isNewerVersion("v2.4.0", "2.3.0")).toBe(true);
    expect(isNewerVersion("2.4.0", "v2.3.0")).toBe(true);
    expect(isNewerVersion("V2.4.0", "v2.4.0")).toBe(false);
  });

  it("ignores a pre-release or build-metadata suffix", () => {
    expect(isNewerVersion("2.4.0-beta.1", "2.3.0")).toBe(true);
    expect(isNewerVersion("2.4.0+build.5", "2.3.0")).toBe(true);
    // A pre-release of the SAME core version is not strictly newer.
    expect(isNewerVersion("2.4.0-beta", "2.4.0")).toBe(false);
    expect(parseSemver("v2.4.0-rc.2")).toEqual({ major: 2, minor: 4, patch: 0 });
  });

  it("treats equal or older as no update", () => {
    expect(isNewerVersion("2.3.0", "2.3.0")).toBe(false);
    expect(isNewerVersion("2.2.9", "2.3.0")).toBe(false);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
  });

  it.each([
    ["garbage"],
    [""],
    ["   "],
    ["2.4"],
    ["2.4.0.1"],
    ["2.x.0"],
    ["v"]
  ])("treats malformed tag %j as no update", (tag) => {
    expect(isNewerVersion(tag, "2.3.0")).toBe(false);
    expect(parseSemver(tag)).toBeNull();
  });

  it("returns no update when the current version is malformed", () => {
    expect(isNewerVersion("2.4.0", "not-a-version")).toBe(false);
  });

  it.each([[undefined], [null], [42], [{}]])(
    "parseSemver returns null for non-string %j",
    (value) => {
      expect(parseSemver(value as unknown)).toBeNull();
    }
  );
});

// ---------------------------------------------------------------------------
// Opt-in update check (UpdateChecker): off by default, token-isolated,
// fire-and-forget, surfaced at most once
// ---------------------------------------------------------------------------

const GITHUB_URL =
  "https://api.github.com/repos/Zenotech-bv/teslafi-mcp/releases/latest";

describe("UpdateChecker: off by default", () => {
  it.each([
    ["unset", undefined],
    ['"false"', "false"],
    ['"0"', "0"],
    ['"no"', "no"],
    ["empty", ""]
  ])(
    "makes ZERO GitHub requests when TESLAFI_CHECK_UPDATES is %s",
    async (_label, value) => {
      if (value === undefined) {
        delete process.env.TESLAFI_CHECK_UPDATES;
      } else {
        process.env.TESLAFI_CHECK_UPDATES = value;
      }
      const checker = new UpdateChecker("2.3.0");
      await expect(settle(checker.checkForUpdate())).resolves.toBeNull();
      // The single-destination guarantee holds: no api.github.com request.
      expect(mockAxios).not.toHaveBeenCalled();
      expect(checker.maybeUpdateNotice()).toBeNull();
    }
  );
});

describe("UpdateChecker: token isolation and request shape", () => {
  it("targets api.github.com with UA+Accept, no redirects/proxy, no token or Authorization", async () => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
    mockAxios.mockResolvedValue({ data: { tag_name: "v99.0.0" } });
    const checker = new UpdateChecker("2.3.0");
    await settle(checker.checkForUpdate());

    expect(mockAxios).toHaveBeenCalledTimes(1);
    const cfg = axiosConfig();
    // Exactly api.github.com's URL — never teslafi.com.
    expect(cfg.url).toBe(GITHUB_URL);
    expect(String(cfg.url)).not.toContain("teslafi.com");
    expect(cfg.headers["User-Agent"]).toBe("teslafi-mcp-update-check");
    expect(cfg.headers.Accept).toBe("application/vnd.github+json");
    expect(cfg.maxRedirects).toBe(0);
    expect(cfg.proxy).toBe(false);
    expect(cfg.timeout).toBeLessThanOrEqual(5000);
    expect(cfg.timeout).toBeGreaterThan(0);
    // No TeslaFi token: no query params at all, and no token anywhere.
    expect(cfg.params).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain("token");
    expect(JSON.stringify(cfg)).not.toContain(TOKEN);
    // No Authorization header, in any casing.
    expect(cfg.headers.Authorization).toBeUndefined();
    expect(cfg.headers.authorization).toBeUndefined();
  });

  it("does not use the TeslaFi request pipeline (no token param even alongside a TeslaFi call)", async () => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
    mockAxios.mockImplementation(async (config: any) => {
      if (String(config?.url).includes("api.github.com")) {
        return { data: { tag_name: "v99.0.0" } };
      }
      return { data: { battery_level: 72 } };
    });
    // A normal TeslaFi call carries the token...
    await settle(api.getCurrentData());
    // ...the update check, made independently, does not.
    const checker = new UpdateChecker("2.3.0");
    await settle(checker.checkForUpdate());

    const githubCall = mockAxios.mock.calls.find((c) =>
      String((c[0] as any)?.url).includes("api.github.com")
    );
    expect(githubCall).toBeDefined();
    const cfg = githubCall![0] as any;
    expect(cfg.params).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain(TOKEN);
  });
});

describe("UpdateChecker: notice surfacing", () => {
  it("yields the one-line notice once, then null, for a strictly-newer release", async () => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
    mockAxios.mockResolvedValue({ data: { tag_name: "v99.1.2" } });
    const checker = new UpdateChecker("2.3.0");
    await settle(checker.checkForUpdate());

    const first = checker.maybeUpdateNotice();
    expect(first).toContain("A newer TeslaFi MCP release is available");
    expect(first).toContain("v99.1.2");
    expect(first).toContain("you have v2.3.0");
    expect(first).toContain(
      "https://github.com/Zenotech-bv/teslafi-mcp/releases"
    );
    // At most once per process.
    expect(checker.maybeUpdateNotice()).toBeNull();
  });

  it.each([["2.3.0"], ["2.2.0"], ["v2.3.0"], ["not-a-version"], [""]])(
    "shows no notice for a non-newer / malformed tag %j",
    async (tag) => {
      process.env.TESLAFI_CHECK_UPDATES = "true";
      mockAxios.mockResolvedValue({ data: { tag_name: tag } });
      const checker = new UpdateChecker("2.3.0");
      await settle(checker.checkForUpdate());
      expect(checker.maybeUpdateNotice()).toBeNull();
    }
  );

  it("caches the check for the process lifetime (one request only)", async () => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
    mockAxios.mockResolvedValue({ data: { tag_name: "v9.0.0" } });
    const checker = new UpdateChecker("2.3.0");
    await settle(checker.checkForUpdate());
    await settle(checker.checkForUpdate());
    await settle(checker.checkForUpdate());
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("reset() restores both the request and the notice for re-exercising", async () => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
    mockAxios.mockResolvedValue({ data: { tag_name: "v9.0.0" } });
    const checker = new UpdateChecker("2.3.0");
    await settle(checker.checkForUpdate());
    expect(checker.maybeUpdateNotice()).toContain("v9.0.0");
    expect(checker.maybeUpdateNotice()).toBeNull();

    checker.reset();
    await settle(checker.checkForUpdate());
    expect(mockAxios).toHaveBeenCalledTimes(2); // fresh request after reset
    expect(checker.maybeUpdateNotice()).toContain("v9.0.0"); // notice available again
  });

  it("suppresses the notice when the flag is turned off after a check", async () => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
    mockAxios.mockResolvedValue({ data: { tag_name: "v9.0.0" } });
    const checker = new UpdateChecker("2.3.0");
    await settle(checker.checkForUpdate());
    process.env.TESLAFI_CHECK_UPDATES = "false";
    expect(checker.maybeUpdateNotice()).toBeNull();
  });
});

describe("UpdateChecker: fire-and-forget failure swallowing", () => {
  beforeEach(() => {
    process.env.TESLAFI_CHECK_UPDATES = "true";
  });

  it.each([
    ["404 (private repo, unauthenticated)", () => httpError(404)],
    ["403 (rate limited)", () => httpError(403)],
    ["a redirect (302)", () => httpError(302)],
    ["timeout", () => netError("ECONNABORTED")],
    ["network error", () => netError("ENOTFOUND")]
  ])("swallows %s: resolves null, never throws, no notice", async (_label, make) => {
    mockAxios.mockRejectedValue(make());
    const checker = new UpdateChecker("2.3.0");
    await expect(settle(checker.checkForUpdate())).resolves.toBeNull();
    expect(checker.maybeUpdateNotice()).toBeNull();
  });

  it.each([
    ["a plain-text body", "You are not logged in"],
    ["an HTML page", "<html><body>rate limited</body></html>"],
    ["a null body", null],
    ["an array body", [1, 2, 3]],
    ["an object without tag_name", { name: "no tag here" }],
    ["a non-string tag_name", { tag_name: 12345 }],
    ["an empty tag_name", { tag_name: "" }]
  ])("swallows malformed JSON (%s): no notice, no throw", async (_label, data) => {
    mockAxios.mockResolvedValue({ data });
    const checker = new UpdateChecker("2.3.0");
    await expect(settle(checker.checkForUpdate())).resolves.toBeNull();
    expect(checker.maybeUpdateNotice()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inferLocationName: readable display name from a raw address (deterministic)
// ---------------------------------------------------------------------------

describe("inferLocationName", () => {
  it("takes the first one-to-two comma-separated segments", () => {
    expect(
      inferLocationName("9 Dorsett Road, Talbot Green, Pontyclun CF72 8XY, UK")
    ).toBe("9 Dorsett Road, Talbot Green");
  });

  it("trims each segment and ignores empty ones", () => {
    expect(inferLocationName("  A ,  B , C ")).toBe("A, B");
    expect(inferLocationName("A,,B")).toBe("A, B");
  });

  it("returns the full address when there is a single usable segment", () => {
    expect(inferLocationName("Somewhere")).toBe("Somewhere");
    expect(inferLocationName("Supercharger A1")).toBe("Supercharger A1");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(inferLocationName("")).toBe("");
    expect(inferLocationName("   ")).toBe("");
  });

  it("is deterministic across repeated calls", () => {
    const address = "12 High St, Cardiff, Wales";
    expect(inferLocationName(address)).toBe(inferLocationName(address));
    expect(inferLocationName(address)).toBe("12 High St, Cardiff");
  });
});

// ---------------------------------------------------------------------------
// VERSION source of truth
// ---------------------------------------------------------------------------

describe("VERSION constant", () => {
  it("is the exported single source of truth (2.6.0)", () => {
    expect(VERSION).toBe("2.6.0");
    // A default-constructed checker compares against VERSION.
    const checker = new UpdateChecker();
    expect(isNewerVersion("9.9.9", VERSION)).toBe(true);
    expect(isNewerVersion(VERSION, VERSION)).toBe(false);
    expect(checker).toBeInstanceOf(UpdateChecker);
  });
});
