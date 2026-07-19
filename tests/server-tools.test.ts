/**
 * Tool-layer tests for the MCP server (src/index.ts).
 *
 * The MCP SDK server is replaced with a capturing fake so the real
 * registration code in index.ts runs and every tool handler can be invoked
 * directly. Tool arguments are parsed through the exact Zod schemas index.ts
 * registers, so schema defaults (include_raw=false, limit=50, ...) and
 * strictness are exercised as the SDK would apply them.
 *
 * All HTTP is mocked at the axios boundary - nothing contacts teslafi.com.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError } from "axios";

const captured = vi.hoisted(() => ({
  tools: new Map<
    string,
    { config: any; handler: (args: any) => Promise<any> }
  >()
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, config: any, handler: any) {
      captured.tools.set(name, { config, handler });
    }
    async connect() {
      /* no transport in tests */
    }
  }
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {}
}));

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: vi.fn() };
});

const mockAxios = axios as unknown as ReturnType<typeof vi.fn>;

const TOKEN = "server-test-token-XYZ";

const FEED_DATA = {
  display_name: "Test Car",
  state: "online",
  carState: "Idling",
  battery_level: 72,
  usable_battery_level: 70,
  est_battery_range: "301.4",
  charging_state: "Disconnected",
  charge_energy_added: "0.0",
  charger_power: "0",
  charge_limit_soc: 80,
  odometer: "12345.6",
  location: "Home",
  // Obviously fake coordinates (mid-ocean), per the placeholder policy.
  latitude: "12.34",
  longitude: "-56.78",
  speed: "",
  shift_state: "P",
  inside_temp: "21.5",
  outside_temp: "18.0",
  locked: "1",
  sentry_mode: "0",
  Date: "2026-07-19 10:00:00"
};

const DRIVES = [
  {
    id: "101",
    date: "2026-07-01 06:30:00",
    startingLocationName: "Home",
    locationName: "Acme HQ",
    startingAddress: "1 Home St",
    address: "2 Work Ave",
    kilometers: "25.4",
    miles: "15.8",
    dayDriveHours: "0",
    dayDriveMinutes: "31"
  },
  {
    id: "102",
    date: "2026-07-01 16:05:00",
    startingLocationName: "Acme HQ",
    locationName: "Home",
    startingAddress: "2 Work Ave",
    address: "1 Home St",
    kilometers: "26.1",
    miles: "16.2",
    dayDriveHours: "0",
    dayDriveMinutes: "34"
  },
  {
    // TeslaFi's empty-string convention: date is "" but startDate is set.
    id: "103",
    date: "",
    startDate: "2026-07-02 12:00:00",
    startingLocationName: "Home",
    locationName: "Supermarket",
    startingAddress: "1 Home St",
    address: "3 Shop Rd",
    kilometers: "3.2",
    miles: "2.0",
    dayDriveHours: "0",
    dayDriveMinutes: "9"
  }
];

const CHARGES = [
  {
    id: "201",
    date: "2026-07-03 22:00:00",
    locationName: "Home",
    address: "1 Home St",
    totalEnergyAdded: "41.3"
  },
  {
    // TeslaFi's empty-string convention: populated fallback fields must not
    // be masked by "" in the preferred fields (date, totalEnergyAdded).
    id: "202",
    date: "",
    startDate: "2026-07-10 13:00:00",
    locationName: "",
    address: "Supercharger A1",
    totalEnergyAdded: "",
    chargerKWH: "35.0"
  }
];

const ALL_TOOLS = [
  "tesla_analyze_home_work_trips",
  "tesla_get_charges",
  "tesla_get_current_data",
  "tesla_get_drives",
  "tesla_get_locations",
  "tesla_get_trips_for_month",
  "tesla_send_command"
];

/** Default axios routing: history vs feed vs command responses. */
function defaultRoute(config: any) {
  const params = config?.params ?? {};
  if (typeof config?.url === "string" && config.url.includes("history.php")) {
    const results = params.command === "drives" ? DRIVES : CHARGES;
    return { data: { count: results.length, results } };
  }
  if (
    params.command &&
    params.command !== "lastGood" &&
    params.command !== "lastGoodTemp"
  ) {
    return { data: { response: { result: true, reason: "" } } };
  }
  return { data: FEED_DATA };
}

/**
 * Invoke a registered tool the way the SDK would: parse args through the
 * registered Zod schema (applying defaults/strictness), then run the handler,
 * draining fake timers so the client's 1s spacing gate cannot stall the test.
 */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const entry = captured.tools.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  const parsed = entry.config.inputSchema.parse(args);
  const p = entry.handler(parsed);
  await vi.runAllTimersAsync();
  return await p;
}

function text(result: any): string {
  return result.content[0].text as string;
}

beforeAll(async () => {
  process.env.TESLA_API_TOKEN = TOKEN;
  delete process.env.TESLAFI_API_TOKEN;
  delete process.env.TESLAFI_ENABLE_COMMANDS;
  delete process.env.TESLAFI_CACHE_TTL_SECONDS;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Importing index.ts registers all tools on the fake server and runs main().
  await import("../src/index.js");
});

beforeEach(() => {
  vi.useFakeTimers();
  mockAxios.mockReset();
  mockAxios.mockImplementation(async (config: any) => defaultRoute(config));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TESLAFI_ENABLE_COMMANDS;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("registers exactly the 7 TeslaFi tools", () => {
    expect([...captured.tools.keys()].sort()).toEqual(ALL_TOOLS);
  });

  it("marks read tools read-only and the command tool destructive", () => {
    for (const name of ALL_TOOLS) {
      const { config } = captured.tools.get(name)!;
      if (name === "tesla_send_command") {
        expect(config.annotations.readOnlyHint).toBe(false);
        expect(config.annotations.destructiveHint).toBe(true);
      } else {
        expect(config.annotations.readOnlyHint).toBe(true);
        expect(config.annotations.destructiveHint).toBe(false);
      }
    }
  });

  it("uses strict schemas: unknown argument keys are rejected", () => {
    const { config } = captured.tools.get("tesla_get_drives")!;
    expect(() => config.inputSchema.parse({ bogus: 1 })).toThrow();
  });

  it("rejects unknown commands at the schema layer, before the handler runs", () => {
    const { config } = captured.tools.get("tesla_send_command")!;
    expect(() => config.inputSchema.parse({ command: "self_destruct" })).toThrow();
    // honk_horn was removed in the official-docs alignment (2.2.0).
    expect(() => config.inputSchema.parse({ command: "honk_horn" })).toThrow();
    expect(() => config.inputSchema.parse({ command: "wake_up" })).not.toThrow();
    // Commands added in the official-docs alignment parse fine.
    for (const command of ["wake", "sleep", "seat_heater", "preset", "command_count"]) {
      expect(() => config.inputSchema.parse({ command })).not.toThrow();
    }
  });

  it("caps wake_seconds at the official maximum of 60 in the schema", () => {
    const { config } = captured.tools.get("tesla_send_command")!;
    expect(() =>
      config.inputSchema.parse({ command: "wake_up", wake_seconds: 61 })
    ).toThrow();
    expect(() =>
      config.inputSchema.parse({ command: "wake_up", wake_seconds: 120 })
    ).toThrow(); // the pre-2.2.0 maximum is no longer accepted
    expect(() =>
      config.inputSchema.parse({ command: "wake_up", wake_seconds: 60 })
    ).not.toThrow();
  });

  it("accepts the no_wake boolean in the schema", () => {
    const { config } = captured.tools.get("tesla_send_command")!;
    expect(() =>
      config.inputSchema.parse({ command: "charge_start", no_wake: true })
    ).not.toThrow();
    expect(() =>
      config.inputSchema.parse({ command: "charge_start", no_wake: "yes" })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TESLAFI_ENABLE_COMMANDS gating
// ---------------------------------------------------------------------------

describe("TESLAFI_ENABLE_COMMANDS gating", () => {
  const disabledCases: Array<[string, string | undefined]> = [
    ["unset", undefined],
    ['the literal string "false" (extension toggle off)', "false"],
    ['"FALSE"', "FALSE"],
    ['"0"', "0"],
    ['empty string', ""],
    ['"no"', "no"]
  ];

  it.each(disabledCases)(
    "tesla_send_command is disabled when TESLAFI_ENABLE_COMMANDS is %s",
    async (_label, value) => {
      if (value === undefined) {
        delete process.env.TESLAFI_ENABLE_COMMANDS;
      } else {
        process.env.TESLAFI_ENABLE_COMMANDS = value;
      }

      const result = await callTool("tesla_send_command", {
        command: "wake_up"
      });
      const msg = text(result);
      expect(msg).toMatch(/^Error: Vehicle commands are disabled/);
      // The error must be instructive: name the env var and the value to set.
      expect(msg).toContain("TESLAFI_ENABLE_COMMANDS");
      expect(msg).toContain('"true"');
      expect(mockAxios).not.toHaveBeenCalled();
    }
  );

  it.each([["true"], ["TRUE"], [" true "], ["1"], ["yes"]])(
    "tesla_send_command is enabled when TESLAFI_ENABLE_COMMANDS=%j",
    async (value) => {
      process.env.TESLAFI_ENABLE_COMMANDS = value;
      const result = await callTool("tesla_send_command", {
        command: "wake_up"
      });
      expect(text(result)).toContain("# Command: wake_up");
      expect(mockAxios).toHaveBeenCalledTimes(1);
      const cfg = mockAxios.mock.calls[0][0] as any;
      expect(cfg.params.command).toBe("wake_up");
      expect(cfg.params.token).toBe(TOKEN);
    }
  );

  it("re-checks the flag on every call (flipping it off disables immediately)", async () => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
    await callTool("tesla_send_command", { command: "honk" });
    expect(mockAxios).toHaveBeenCalledTimes(1);

    process.env.TESLAFI_ENABLE_COMMANDS = "false";
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toMatch(/^Error: Vehicle commands are disabled/);
    expect(mockAxios).toHaveBeenCalledTimes(1); // no second network call
  });

  it("rejects reserved param keys through the full tool path, with no network call", async () => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
    const result = await callTool("tesla_send_command", {
      command: "wake_up",
      params: { token: "evil-token" }
    });
    expect(text(result)).toMatch(/^Error: Parameter "token" is reserved/);
    expect(text(result)).not.toContain("evil-token");
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("rejects invalid per-command params through the full tool path", async () => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
    const result = await callTool("tesla_send_command", {
      command: "set_charge_limit",
      params: { sentryMode: 1 }
    });
    expect(text(result)).toMatch(
      /^Error: Parameter "sentryMode" is not valid for command "set_charge_limit"/
    );
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("surfaces a malformed (plain-text) command response as an error, never as success", async () => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
    mockAxios.mockReset();
    // TeslaFi's login page / error string instead of a JSON result object.
    mockAxios.mockResolvedValue({ data: "You are not logged in" });

    const result = await callTool("tesla_send_command", { command: "wake_up" });
    const msg = text(result);
    expect(msg).toMatch(/^Error: /);
    expect(msg).toMatch(/plain text/);
    expect(msg).toMatch(/may still have been executed/);
    expect(msg).not.toContain("# Command:");
    // No success framing and no non-object structuredContent on the wire:
    // the MCP spec requires structuredContent to be an object when present.
    expect(result.structuredContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wake modifiers and quota surfacing through the full tool path
// ---------------------------------------------------------------------------

describe("tesla_send_command wake modifiers and quota", () => {
  beforeEach(() => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
  });

  it("passes no_wake through as noWake=true", async () => {
    await callTool("tesla_send_command", {
      command: "charge_start",
      no_wake: true
    });
    expect(mockAxios).toHaveBeenCalledTimes(1);
    const cfg = mockAxios.mock.calls[0][0] as any;
    expect(cfg.params.noWake).toBe("true");
    expect(cfg.params).not.toHaveProperty("wake");
  });

  it("rejects no_wake combined with wake_seconds locally, with no network call", async () => {
    const result = await callTool("tesla_send_command", {
      command: "charge_start",
      wake_seconds: 30,
      no_wake: true
    });
    expect(text(result)).toMatch(
      /^Error: wake_seconds and no_wake are mutually exclusive/
    );
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("rejects seat_heater heater=3 through the full tool path", async () => {
    const result = await callTool("tesla_send_command", {
      command: "seat_heater",
      params: { heater: 3, level: 2 }
    });
    expect(text(result)).toMatch(/^Error: /);
    expect(text(result)).toMatch(/there is no seat 3/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it("appends the quota line when the response embeds tesla_request_counter", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        response: { result: true, reason: "" },
        tesla_request_counter: { commands: 12, wakes: 3 }
      }
    });

    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain(
      "Quota: 12/500 commands, 3/50 wakes used this month"
    );
    // The counter rides along in structured output.
    expect(result.structuredContent.tesla_request_counter).toEqual({
      commands: 12,
      wakes: 3
    });
  });

  it("renders string counter values from TeslaFi's JSON", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        response: { result: true },
        tesla_request_counter: { commands: "499", wakes: "50" }
      }
    });
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain(
      "Quota: 499/500 commands, 50/50 wakes used this month"
    );
  });

  it("omits the quota line, without failing, when the counter is absent", async () => {
    // defaultRoute returns a command response with no tesla_request_counter.
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain("# Command: honk");
    expect(text(result)).not.toContain("Quota:");
  });

  it("omits the quota line for a malformed counter instead of failing", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        response: { result: true },
        tesla_request_counter: { commands: "not-a-number" }
      }
    });
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain("# Command: honk");
    expect(text(result)).not.toContain("Quota:");
  });
});

// ---------------------------------------------------------------------------
// Wake-conserving default through the full tool path
// ---------------------------------------------------------------------------

describe("tesla_send_command wake-conserving default", () => {
  beforeEach(() => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
  });

  it("defaults car commands to noWake=true when neither wake param is given", async () => {
    await callTool("tesla_send_command", { command: "charge_start" });
    const cfg = mockAxios.mock.calls[0][0] as any;
    expect(cfg.params.noWake).toBe("true");
    expect(cfg.params).not.toHaveProperty("wake");
  });

  it("never appends noWake to account-side commands", async () => {
    await callTool("tesla_send_command", { command: "wake_up" });
    const cfg = mockAxios.mock.calls[0][0] as any;
    expect(cfg.params).not.toHaveProperty("noWake");
  });

  it("no_wake: false restores TeslaFi's own wake-and-wait default (no noWake sent)", async () => {
    await callTool("tesla_send_command", {
      command: "charge_start",
      no_wake: false
    });
    const cfg = mockAxios.mock.calls[0][0] as any;
    expect(cfg.params).not.toHaveProperty("noWake");
    expect(cfg.params).not.toHaveProperty("wake");
  });

  it("wake_seconds sends wake=X without noWake", async () => {
    await callTool("tesla_send_command", {
      command: "charge_start",
      wake_seconds: 20
    });
    const cfg = mockAxios.mock.calls[0][0] as any;
    expect(cfg.params.wake).toBe(20);
    expect(cfg.params).not.toHaveProperty("noWake");
  });
});

// ---------------------------------------------------------------------------
// Asleep-unsent feedback
// ---------------------------------------------------------------------------

describe("asleep-unsent feedback", () => {
  beforeEach(() => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
  });

  it("explains an unsent-asleep result and the wake options", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: { response: { result: "unsent", reason: "vehicle asleep" } }
    });
    const result = await callTool("tesla_send_command", {
      command: "charge_start"
    });
    const md = text(result);
    expect(md).toContain("# Command: charge_start");
    expect(md).toContain("NOT sent");
    expect(md).toContain("wake_seconds");
    expect(md).toContain("50 monthly wake requests");
    expect(md).toContain("wait until the car is awake");
  });

  it("appends the guidance when TeslaFi reports asleep/not-sent as an error", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        response: {
          result: false,
          reason: "Vehicle is asleep - command not sent (noWake)"
        }
      }
    });
    const result = await callTool("tesla_send_command", {
      command: "door_lock"
    });
    const md = text(result);
    expect(md).toMatch(/^Error: /);
    expect(md).toContain("NOT sent");
    expect(md).toContain("wake_seconds");
    expect(md).toContain("50 monthly wake requests");
  });

  it("adds no asleep note to a normal success", async () => {
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain("# Command: honk");
    expect(text(result)).not.toContain("NOT sent");
  });
});

// ---------------------------------------------------------------------------
// Quota usage warnings (>= 400/500 commands, >= 40/50 wakes)
// ---------------------------------------------------------------------------

describe("quota usage warnings", () => {
  beforeEach(() => {
    process.env.TESLAFI_ENABLE_COMMANDS = "true";
  });

  /** Route every command to a response carrying the given counters. */
  function counters(commands: number | string, wakes: number | string) {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        response: { result: true },
        tesla_request_counter: { commands, wakes }
      }
    });
  }

  it("prepends a command-usage warning at exactly 400/500", async () => {
    counters(400, 5);
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(
      text(result).startsWith(
        "WARNING: 400/500 monthly command requests used"
      )
    ).toBe(true);
    expect(text(result)).not.toContain("monthly wake requests used");
  });

  it("prepends a wake-usage warning at exactly 40/50", async () => {
    counters(12, 40);
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(
      text(result).startsWith("WARNING: 40/50 monthly wake requests used")
    ).toBe(true);
    expect(text(result)).not.toContain("monthly command requests used");
  });

  it("shows no warnings at 399 commands / 39 wakes", async () => {
    counters(399, 39);
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).not.toContain("WARNING:");
    expect(text(result)).toContain("# Command: honk");
    expect(text(result)).toContain(
      "Quota: 399/500 commands, 39/50 wakes used this month"
    );
  });

  it("shows both warnings when both thresholds are crossed", async () => {
    counters(500, 50);
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain(
      "WARNING: 500/500 monthly command requests used"
    );
    expect(text(result)).toContain(
      "WARNING: 50/50 monthly wake requests used"
    );
  });

  it("uses counters remembered from a DATA response for a later command without any", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        ...FEED_DATA,
        tesla_request_counter: { commands: 450, wakes: 41 }
      }
    });
    await callTool("tesla_get_current_data");

    // The command response itself carries NO counter; the warning must come
    // from the usage remembered from the data response above.
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({ data: { response: { result: true } } });
    const result = await callTool("tesla_send_command", { command: "honk" });
    expect(text(result)).toContain(
      "WARNING: 450/500 monthly command requests used"
    );
    expect(text(result)).toContain(
      "WARNING: 41/50 monthly wake requests used"
    );
    expect(text(result)).not.toContain("Quota:"); // no counter on THIS response
  });

  it("keeps JSON output parseable (warnings are markdown-only)", async () => {
    counters(500, 50);
    const result = await callTool("tesla_send_command", {
      command: "honk",
      response_format: "json"
    });
    expect(() => JSON.parse(text(result))).not.toThrow();
    expect(text(result)).not.toContain("WARNING:");
  });
});

// ---------------------------------------------------------------------------
// Per-tool happy paths
// ---------------------------------------------------------------------------

describe("tesla_get_current_data", () => {
  it("renders markdown by default and attaches the raw data as structured content", async () => {
    const result = await callTool("tesla_get_current_data");
    const md = text(result);
    expect(md).toContain("# Vehicle Data (current)");
    expect(md).toContain("**Name**: Test Car");
    expect(md).toContain("**Battery**: 72% (usable 70%)");
    expect(md).toContain("**Speed**: —"); // empty fields render as dashes
    expect(result.structuredContent).toEqual(FEED_DATA);
    // Default source sends no command param.
    expect((mockAxios.mock.calls[0][0] as any).params).not.toHaveProperty(
      "command"
    );
  });

  it("passes source through to feed.php", async () => {
    await callTool("tesla_get_current_data", { source: "lastGood" });
    expect((mockAxios.mock.calls[0][0] as any).params.command).toBe("lastGood");
  });

  it("omits the quota line when the feed data has no tesla_request_counter", async () => {
    const result = await callTool("tesla_get_current_data");
    expect(text(result)).not.toContain("Quota:");
  });

  it("appends the quota line when the feed data embeds tesla_request_counter", async () => {
    mockAxios.mockReset();
    mockAxios.mockResolvedValue({
      data: {
        ...FEED_DATA,
        tesla_request_counter: { commands: 101, wakes: 7 }
      }
    });
    const result = await callTool("tesla_get_current_data");
    expect(text(result)).toContain(
      "Quota: 101/500 commands, 7/50 wakes used this month"
    );
    expect(result.structuredContent.tesla_request_counter).toEqual({
      commands: 101,
      wakes: 7
    });
  });

  it("returns JSON when requested", async () => {
    const result = await callTool("tesla_get_current_data", {
      response_format: "json"
    });
    expect(JSON.parse(text(result))).toEqual(FEED_DATA);
  });

  it("turns service errors into a clean Error: text without the token", async () => {
    mockAxios.mockReset();
    mockAxios.mockRejectedValue(
      new AxiosError(
        "Request failed with status code 401",
        "ERR_BAD_REQUEST",
        { url: `https://www.teslafi.com/feed.php?token=${TOKEN}` } as any,
        {},
        { status: 401, statusText: "", headers: {}, data: "", config: {} } as any
      )
    );
    const result = await callTool("tesla_get_current_data");
    expect(text(result)).toBe(
      "Error: Invalid TeslaFi API token. Please check your credentials."
    );
    expect(text(result)).not.toContain(TOKEN);
  });
});

describe("tesla_get_drives", () => {
  it("omits raw records by default and embeds them with include_raw, reusing the cache", async () => {
    const range = { date_from: "2026-07-01", date_to: "2026-07-31" };

    const bare = await callTool("tesla_get_drives", {
      ...range,
      response_format: "json"
    });
    const bareOut = bare.structuredContent;
    expect(bareOut.total).toBe(3);
    expect(bareOut.drives[0]).toEqual({
      id: "101",
      date: "2026-07-01 06:30:00",
      start_location: "Home",
      end_location: "Acme HQ",
      distance_km: "25.4",
      distance_mi: "15.8"
    });
    expect(bareOut.drives[0]).not.toHaveProperty("raw");
    // date: "" must not mask a populated startDate (empty-string convention).
    expect(bareOut.drives[2].date).toBe("2026-07-02 12:00:00");

    const withRaw = await callTool("tesla_get_drives", {
      ...range,
      include_raw: true,
      response_format: "json"
    });
    expect(withRaw.structuredContent.drives[0].raw).toEqual(DRIVES[0]);

    // Same date window within the TTL: exactly one HTTP request for both calls.
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it("paginates with limit/offset and reports has_more", async () => {
    const result = await callTool("tesla_get_drives", {
      date_from: "2026-07-01",
      date_to: "2026-07-02",
      limit: 1,
      offset: 1,
      response_format: "json"
    });
    const out = result.structuredContent;
    expect(out.total).toBe(3);
    expect(out.returned).toBe(1);
    expect(out.drives[0].id).toBe("102");
    expect(out.has_more).toBe(true);
  });

  it("renders a markdown list by default", async () => {
    const result = await callTool("tesla_get_drives", {
      date_from: "2026-07-04",
      date_to: "2026-07-05"
    });
    const md = text(result);
    expect(md).toContain("# Drives");
    expect(md).toContain("**Home** → **Acme HQ** — 25.4 km");
    // The empty-string date falls back to startDate in the markdown view too.
    expect(md).toContain("**Home** → **Supermarket** — 3.2 km (2026-07-02 12:00:00)");
  });

  it('applies the empty-string convention to distances (kilometers "" falls back to miles)', async () => {
    // A miles-unit TeslaFi account returns kilometers: "" on every drive.
    mockAxios.mockImplementation(async (config: any) => {
      if (
        typeof config?.url === "string" &&
        config.url.includes("history.php")
      ) {
        return {
          data: {
            count: 1,
            results: [
              {
                id: "301",
                date: "2026-09-01 08:00:00",
                startingLocationName: "Home",
                locationName: "Acme HQ",
                kilometers: "",
                miles: "15.8"
              }
            ]
          }
        };
      }
      return defaultRoute(config);
    });

    // Use a date window no other test touches: the module-level client keeps
    // a shared history cache, and a fresh key forces a real (mocked) request.
    const range = { date_from: "2026-09-01", date_to: "2026-09-02" };
    const json = await callTool("tesla_get_drives", {
      ...range,
      response_format: "json"
    });
    // "" must not surface as distance_km, and must not mask the miles value.
    expect(json.structuredContent.drives[0].distance_km).toBeNull();
    expect(json.structuredContent.drives[0].distance_mi).toBe("15.8");

    const md = text(await callTool("tesla_get_drives", range));
    expect(md).toContain("**Home** → **Acme HQ** — 15.8 mi (2026-09-01 08:00:00)");
    // Never an empty distance labeled km.
    expect(md).not.toContain(" km");
  });
});

describe("tesla_get_charges", () => {
  it("summarizes charges with location and energy fallbacks", async () => {
    const result = await callTool("tesla_get_charges", {
      response_format: "json"
    });
    const out = result.structuredContent;
    expect(out.total).toBe(2);
    expect(out.charges[0]).toEqual({
      id: "201",
      date: "2026-07-03 22:00:00",
      location: "Home",
      energy_added_kwh: "41.3"
    });
    // Falls back to address, startDate, and chargerKWH when the preferred
    // fields are absent OR empty strings (TeslaFi's empty-string convention).
    expect(out.charges[1].location).toBe("Supercharger A1");
    expect(out.charges[1].date).toBe("2026-07-10 13:00:00");
    expect(out.charges[1].energy_added_kwh).toBe("35.0");
    expect(out.charges[0]).not.toHaveProperty("raw");
  });

  it("renders markdown with the empty-string-aware fallbacks", async () => {
    const result = await callTool("tesla_get_charges", {});
    const md = text(result);
    expect(md).toContain("# Charges");
    expect(md).toContain("**Home** — +41.3 kWh (2026-07-03 22:00:00)");
    // Must NOT render as "+ kWh ()": "" date and "" totalEnergyAdded fall
    // back to startDate and chargerKWH.
    expect(md).toContain(
      "**Supercharger A1** — +35.0 kWh (2026-07-10 13:00:00)"
    );
    expect(md).not.toContain("+ kWh ()");
  });

  it("embeds raw charge records when include_raw=true", async () => {
    const result = await callTool("tesla_get_charges", {
      include_raw: true,
      response_format: "json"
    });
    expect(result.structuredContent.charges[0].raw).toEqual(CHARGES[0]);
  });
});

describe("tesla_get_trips_for_month", () => {
  it("returns normalized trips with pagination metadata", async () => {
    // Use a month no other test touches: the module-level TeslaFi client keeps
    // a shared history cache, and a fresh key guarantees a real HTTP request
    // whose query params we can assert on.
    const result = await callTool("tesla_get_trips_for_month", {
      year: 2026,
      month: 8,
      response_format: "json"
    });
    const out = result.structuredContent;
    expect(out.year).toBe(2026);
    expect(out.month).toBe(8);
    expect(out.total_trips).toBe(3);
    expect(out.returned_trips).toBe(3); // default limit 50
    expect(out.has_more).toBe(false);
    expect(out.trips[0]).toMatchObject({
      id: 101,
      start_location: "Home",
      end_location: "Acme HQ",
      distance: 25.4,
      distance_unit: "km",
      duration_minutes: 31
    });
    expect(out.trips[0]).not.toHaveProperty("raw"); // include_raw defaults false
    // The month is translated to a full calendar date range.
    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect((mockAxios.mock.calls[0][0] as any).params).toMatchObject({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31"
    });
  });

  it("embeds raw drive records when include_raw=true", async () => {
    const result = await callTool("tesla_get_trips_for_month", {
      year: 2026,
      month: 7,
      include_raw: true,
      response_format: "json"
    });
    expect(result.structuredContent.trips[0].raw).toEqual(DRIVES[0]);
  });

  it("paginates and reports next_offset", async () => {
    const result = await callTool("tesla_get_trips_for_month", {
      year: 2026,
      month: 7,
      limit: 2,
      response_format: "json"
    });
    const out = result.structuredContent;
    expect(out.returned_trips).toBe(2);
    expect(out.has_more).toBe(true);
    expect(out.next_offset).toBe(2);
  });
});

describe("tesla_analyze_home_work_trips", () => {
  it("summarizes commutes in markdown and structured content", async () => {
    const result = await callTool("tesla_analyze_home_work_trips", {
      year: 2026,
      month: 7,
      home_location: "Home",
      work_location: "Acme HQ"
    });
    const md = text(result);
    expect(md).toContain("# Trip Analysis: July 2026");
    expect(md).toContain("**Total Trips**: 3");
    expect(md).toContain("**Home → Work**: 1");
    expect(md).toContain("**Work → Home**: 1");
    expect(md).toContain("**Other Trips**: 1");

    const out = result.structuredContent;
    expect(out.home_to_work_trips).toBe(1);
    expect(out.work_to_home_trips).toBe(1);
    expect(out.other_trips).toBe(1);
    expect(out.trips).toHaveLength(2);
    expect(out.trips_truncated).toBe(false);
  });

  it("says so when no commutes match", async () => {
    const result = await callTool("tesla_analyze_home_work_trips", {
      year: 2026,
      month: 7,
      home_location: "Castle",
      work_location: "Moon Base"
    });
    expect(text(result)).toContain(
      'No commute trips found matching "Castle" → "Moon Base".'
    );
  });
});

describe("tesla_get_locations", () => {
  it("lists named locations with visit counts", async () => {
    const result = await callTool("tesla_get_locations", {
      response_format: "json"
    });
    const out = result.structuredContent;
    expect(out.count).toBe(3);
    expect(out.locations[0]).toEqual({
      name: "Home",
      visits: 3,
      as_start: 2,
      as_end: 1
    });
    expect(out.locations.map((l: any) => l.name)).toEqual([
      "Home",
      "Acme HQ",
      "Supermarket"
    ]);
  });

  it("renders a markdown list", async () => {
    const result = await callTool("tesla_get_locations", {});
    const md = text(result);
    expect(md).toContain("# Known Locations");
    expect(md).toContain("**Home** — 3 visits (2 starts, 1 ends)");
  });
});
