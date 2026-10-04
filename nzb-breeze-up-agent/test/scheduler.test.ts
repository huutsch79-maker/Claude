import { describe, expect, it } from "vitest";
import { configFromSheet, configFromText, defaultConfig, mergeConfig, run, type Cell, type SchedulerConfig } from "../src/core.js";

// Synthetic sale builder: nothing here is 26RTR-specific, which is the point -
// vendors, lot numbers, jockeys and days are all invented per test.
interface PrepSpec {
  name: string;
  heats: number;
  jockeys: string[]; // rotated across the preparer's horses
  single?: number[]; // BUOs that have only one horse
}

function horsesSheet(day: string, preps: PrepSpec[], headers = ["Preparer Name", "Vendor/Draft Name", "Day", "BUO", "Lot", "Breeding", "Jockey"]): Cell[][] {
  const rows: Cell[][] = [headers];
  let lot = 1;
  for (const p of preps) {
    let j = 0;
    for (let b = 1; b <= p.heats; b++) {
      const n = p.single?.includes(b) ? 1 : 2;
      for (let k = 0; k < n; k++) {
        rows.push([p.name, `${p.name} Draft`, day, b, `${day}-${lot++}`, "b.c. Sire - Dam", p.jockeys[j++ % p.jockeys.length] ?? ""]);
      }
    }
  }
  return rows;
}

function orderSheet(day: string, names: string[]): Cell[][] {
  return [["Preparer Name", "Vendor/Draft Name", "Day", "Heats", "PO"], ...names.map((n, i) => [n, "", day, null, i + 1])];
}

function reader(sheets: Record<string, Cell[][]>) {
  return (name: string): Cell[][] | null => sheets[name] ?? null;
}

const fast: Partial<SchedulerConfig> = { iterations: 30, annealSteps: 20000 };

function allPairsGap(heats: { horses: { jockeyKey: string }[] }[]): number {
  const last = new Map<string, number>();
  let min = Infinity;
  heats.forEach((h, i) => {
    for (const x of h.horses) {
      if (!x.jockeyKey) continue;
      const l = last.get(x.jockeyKey);
      if (l !== undefined) min = Math.min(min, i - l - 1);
      last.set(x.jockeyKey, i);
    }
  });
  return min;
}

describe("scheduler", () => {
  const preps: PrepSpec[] = [
    { name: "Alpha Lodge", heats: 8, jockeys: ["J1", "J2", "J12", "J13"] },
    { name: "Bravo Farm", heats: 6, jockeys: ["J3", "J4", "J18", "J19"], single: [6] },
    { name: "Charlie Park", heats: 7, jockeys: ["J5", "J1", "J14", "J15"] }, // shares J1 with Alpha
    { name: "Delta Stud", heats: 5, jockeys: ["J6", "J16", "J3", "J17"] }, // shares J3 with Bravo
    { name: "Echo Racing", heats: 6, jockeys: ["J7", "J8"] },
    { name: "Foxtrot", heats: 4, jockeys: ["J9", "J10"] },
    { name: "Golf Bloodstock", heats: 3, jockeys: ["J2", "J11"] },
  ];
  const sheets = { Mon: horsesSheet("Mon", preps), "Mon Order": orderSheet("Mon", preps.map((p) => p.name)) };
  const cfg = mergeConfig({ ...fast, days: [{ name: "Mon", horsesSheet: "Mon", orderSheet: "Mon Order" }] });
  const res = run(reader(sheets), cfg);
  const day = res.schedules[0]!;

  it("schedules every horse exactly once", () => {
    const lots = day.heats.flatMap((h) => h.horses.map((x) => x.lot));
    expect(lots.length).toBe(sheets.Mon.length - 1);
    expect(new Set(lots).size).toBe(lots.length);
  });

  it("keeps at least minHeatsBetween heats between a jockey's rides", () => {
    expect(res.issues.filter((i) => i.code === "JOCKEY_OVERBOOKED")).toEqual([]); // fixture is feasible
    expect(day.violations).toEqual([]);
    expect(allPairsGap(day.heats)).toBeGreaterThanOrEqual(4);
  });

  it("keeps each preparer's BUO order within maxBuoShift", () => {
    for (const p of preps) {
      const buos = day.heats.filter((h) => h.preparer === p.name).map((h) => h.buo);
      buos.forEach((b, i) => expect(Math.abs(b - 1 - i)).toBeLessThanOrEqual(cfg.maxBuoShift));
    }
  });

  it("starts preparers close to the preferred order", () => {
    for (const s of day.preparers) expect(Math.abs(s.entryPosition - s.preferredPosition)).toBeLessThanOrEqual(cfg.orderFlex + 1);
  });

  it("does not leave a preparer standing idle for long", () => {
    expect(day.maxIdle).toBeLessThanOrEqual(2 * day.lanes);
  });
});

describe("future sales: different vendors, lots, jockeys, days and layouts", () => {
  it("handles a new preparer missing from the order sheet, renamed headers and a third day from the Agent Config sheet", () => {
    const wed: PrepSpec[] = [
      { name: "New Vendor 2027", heats: 5, jockeys: ["Rider A", "Rider B", "Rider M", "Rider N"] },
      { name: "Second Vendor", heats: 6, jockeys: ["Rider C", "Rider K", "Rider L", "Rider O", "Rider P", "rider a "] }, // case/space variant of Rider A
      { name: "Third Vendor", heats: 4, jockeys: ["Rider D", "Rider E"] },
      { name: "Fourth Vendor", heats: 4, jockeys: ["Rider F", "Rider G"] },
      { name: "Fifth Vendor", heats: 3, jockeys: ["Rider H", "Rider Q", "Rider B", "Rider R"] },
      { name: "Late Entry", heats: 2, jockeys: ["Rider I", "Rider J"] },
    ];
    const sheets: Record<string, Cell[][]> = {
      "Agent Config": [
        ["Setting", "Value"],
        ["saleCode", "27RTR"],
        ["day", "Wed | Wednesday Horses | Wednesday Order"],
        ["minHeatsBetween", 4],
      ],
      "Wednesday Horses": horsesSheet("Wed", wed, ["Preparer", "Vendor", "Day", "BUO", "Lot No", "Pedigree", "Rider"]),
      // "Late Entry" deliberately absent from the order sheet.
      "Wednesday Order": orderSheet("Wed", wed.filter((p) => p.name !== "Late Entry").map((p) => p.name)),
    };
    const res = run(reader(sheets), mergeConfig(fast));
    expect(res.saleCode).toBe("27RTR");
    expect(res.schedules.map((s) => s.day)).toEqual(["Wed"]);
    const s = res.schedules[0]!;
    expect(s.heats.flatMap((h) => h.horses).length).toBe(sheets["Wednesday Horses"]!.length - 1);
    expect(res.issues.some((i) => i.code === "PREPARER_NOT_IN_ORDER" && i.message.includes("Late Entry"))).toBe(true);
    expect(res.issues.some((i) => i.code === "JOCKEY_SPELLING")).toBe(true);
    expect(s.violations).toEqual([]);
    // Unlisted preparer goes after the listed ones (allowing orderFlex).
    const late = s.preparers.find((p) => p.preparer === "Late Entry")!;
    expect(late.entryPosition).toBeGreaterThanOrEqual(wed.length - 1 - 2);
  });

  it("sends a consecutive-rule preparer's heats back-to-back", () => {
    const preps: PrepSpec[] = [
      { name: "Four Jockey Farm", heats: 6, jockeys: ["P1", "P2", "P3", "P4"] },
      { name: "Other A", heats: 5, jockeys: ["A1", "A2", "A3", "A4"] },
      { name: "Other B", heats: 5, jockeys: ["B1", "B2", "B3", "B4"] },
      { name: "Other C", heats: 5, jockeys: ["C1", "C2", "C3", "C4"] },
      { name: "Other D", heats: 5, jockeys: ["D1", "D2", "D3", "D4"] },
    ];
    const sheets = { Mon: horsesSheet("Mon", preps), "Mon Order": orderSheet("Mon", preps.map((p) => p.name)) };
    const cfg = mergeConfig({ ...fast, days: [{ name: "Mon", horsesSheet: "Mon", orderSheet: "Mon Order" }], consecutivePreparers: [{ preparer: "Four Jockey Farm", day: "Mon", heatsPerTurn: 2 }] });
    const s = run(reader(sheets), cfg).schedules[0]!;
    const idx = s.heats.filter((h) => h.preparer === "Four Jockey Farm").map((h) => h.heatNo);
    expect(s.brokenTurns).toBe(0);
    for (let i = 0; i < idx.length; i += 2) expect(idx[i + 1]! - idx[i]!).toBe(1);
    expect(s.violations).toEqual([]);
  });
});

describe("validation", () => {
  it("flags duplicate lots, a lot on two days, overbooked jockeys and aliases", () => {
    const mon: Cell[][] = [
      ["Preparer Name", "Vendor/Draft Name", "Day", "BUO", "Lot", "Breeding", "Jockey #1"],
      ["P1", "", "Mon", 1, 10, "", "Busy Rider"],
      ["P1", "", "Mon", 1, 10, "", "Other"],
      ["P1", "", "Mon", 2, 11, "", "Busy Rider"],
      ["P1", "", "Mon", 3, 12, "", "Busy Rider"],
      ["P2", "", "Mon", 1, 13, "", "No Jockey"],
    ];
    const tue: Cell[][] = [
      ["Preparer Name", "Vendor/Draft Name", "Day", "BUO", "Lot", "Breeding", "Jockey"],
      ["P3 / Partner", "", "Mon", 1, 12, "", "X"],
    ];
    const sheets = { Mon: mon, "Mon Order": orderSheet("Mon", ["P1", "P2"]), Tue: tue, "Tue Order": orderSheet("Tue", ["P3"]) };
    const res = run(reader(sheets), mergeConfig({ ...fast, preparerAliases: { "P3 / Partner": "P3" } }));
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain("DUPLICATE_LOT");
    expect(codes).toContain("LOT_ON_TWO_DAYS");
    expect(codes).toContain("JOCKEY_OVERBOOKED");
    expect(codes).toContain("DAY_MISMATCH");
    expect(codes).toContain("NO_JOCKEY");
    expect(codes).not.toContain("PREPARER_NOT_IN_ORDER"); // alias resolved
  });

  it("reports a missing required column instead of crashing", () => {
    const sheets = { Mon: [["Preparer Name", "Lot"], ["P1", 1]], "Mon Order": orderSheet("Mon", ["P1"]) };
    const res = run(reader(sheets), mergeConfig({ ...fast, days: [{ name: "Mon", horsesSheet: "Mon", orderSheet: "Mon Order" }] }));
    expect(res.issues.some((i) => i.code === "MISSING_COLUMN")).toBe(true);
  });
});

describe("Agent Config sheet", () => {
  it("parses settings, repeatable rows and aliases", () => {
    const cfg = configFromSheet(
      [
        ["Setting", "Value"],
        ["saleCode", "28RTR"],
        ["day", "Mon | Mon | Mon Order"],
        ["day", "Tue | Tue | Tue Order"],
        ["day", "Wed"],
        ["minHeatsBetween", 5],
        ["laneOptions", "6, 7"],
        ["consecutive", "Prima Park | Mon | 2"],
        ["consecutive", "Big Farm | * | 3"],
        ["preparerAlias", "Mark Brooks / Alex Olivera => Mark Brooks"],
        ["jockeyAlias", "Ryan Elliott => Ryan Elliot"],
      ],
      defaultConfig(),
    );
    expect(cfg.saleCode).toBe("28RTR");
    expect(cfg.days.map((d) => d.orderSheet)).toEqual(["Mon Order", "Tue Order", "Wed Order"]);
    expect(cfg.minHeatsBetween).toBe(5);
    expect(cfg.laneOptions).toEqual([6, 7]);
    expect(cfg.consecutivePreparers).toEqual([
      { preparer: "Prima Park", day: "Mon", heatsPerTurn: 2 },
      { preparer: "Big Farm", day: "*", heatsPerTurn: 3 },
    ]);
    expect(cfg.preparerAliases["Mark Brooks / Alex Olivera"]).toBe("Mark Brooks");
    expect(cfg.jockeyAliases["Ryan Elliott"]).toBe("Ryan Elliot");
  });
});

describe("shared config text (uploaded workbook without an Agent Config sheet)", () => {
  it("parses setting: value lines", () => {
    const cfg = configFromText("saleCode: 27RTR\nconsecutive: Prima Park | Mon | 2\npreparerAlias: A / B => A\n\nnot a setting", defaultConfig());
    expect(cfg.saleCode).toBe("27RTR");
    expect(cfg.consecutivePreparers).toEqual([{ preparer: "Prima Park", day: "Mon", heatsPerTurn: 2 }]);
    expect(cfg.preparerAliases["A / B"]).toBe("A");
  });

  it("applies shared rules, and a workbook Agent Config sheet overrides them", () => {
    const preps: PrepSpec[] = [
      { name: "P1", heats: 3, jockeys: ["a", "b", "c", "d"] },
      { name: "P2", heats: 3, jockeys: ["e", "f", "g", "h"] },
    ];
    const sheets: Record<string, Cell[][]> = { Mon: horsesSheet("Mon", preps), "Mon Order": orderSheet("Mon", ["P1", "P2"]) };
    const text = "saleCode: 27RTR\nday: Mon | Mon | Mon Order\nminHeatsBetween: 1";
    expect(run(reader(sheets), mergeConfig(fast), {}, text).config.saleCode).toBe("27RTR");
    expect(run(reader(sheets), mergeConfig(fast), {}, text).config.minHeatsBetween).toBe(1);
    sheets["Agent Config"] = [["Setting", "Value"], ["saleCode", "OVERRIDE"]];
    const res = run(reader(sheets), mergeConfig(fast), {}, text);
    expect(res.config.saleCode).toBe("OVERRIDE");
    expect(res.config.minHeatsBetween).toBe(1);
  });
});
