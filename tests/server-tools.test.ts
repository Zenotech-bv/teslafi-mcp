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
    expect(() => config.inputSchema.parse({ command: "wake_up" })).not.toThrow();
  });

  it("caps wake_seconds at 120 in the schema", () => {
    const { config } = captured.tools.get("tesla_send_command")!;
    expect(() =>
      config.inputSchema.parse({ command: "wake_up", wake_seconds: 121 })
    ).toThrow();
    expect(() =>
      config.inputSchema.parse({ command: "wake_up", wake_seconds: 120 })
    ).not.toThrow();
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
