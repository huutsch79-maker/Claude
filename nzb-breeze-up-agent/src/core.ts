// NZB Breeze Up Scheduler - core engine.
//
// Pure TypeScript with no imports and no Node/browser APIs so the exact same
// code runs in three places:
//   1. Node CLI (src/cli.ts) for local runs and tests
//   2. Excel Office Script (bundled by scripts/build-office-script.mjs), which
//      Power Automate calls on behalf of the Copilot Studio agent
//   3. Any future host (Azure Function, etc.)
//
// Office Scripts forbid `any`, so everything is explicitly typed.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cell = string | number | boolean | null | undefined;

export interface DayConfig {
  /** Label used in output, e.g. "Mon". */
  name: string;
  /** Sheet listing horses for this day, e.g. "Mon". */
  horsesSheet: string;
  /** Sheet listing preferred preparer order, e.g. "Mon Order". */
  orderSheet: string;
}

export interface ConsecutiveRule {
  preparer: string;
  /** Day name, or "*" for every day. */
  day: string;
  /** How many heats the preparer sends out back-to-back per turn (Prima Park = 2). */
  heatsPerTurn: number;
}

export interface SchedulerConfig {
  saleCode: string;
  days: DayConfig[];
  /** Minimum number of OTHER heats between two rides of the same jockey. */
  minHeatsBetween: number;
  /** Window sizes (preparers active at once) to try. Must be > minHeatsBetween to be violation-free. */
  laneOptions: number[];
  /** Max places a heat may move from its BUO position inside a preparer (0 = strict BUO order). */
  maxBuoShift: number;
  /** Force a window width (0 = automatic: tightest clash-free width). */
  preferLanes: number;
  /** Simulated-annealing steps per seed (higher = slower, usually better). */
  annealSteps: number;
  /** Max positions a preparer may move from its preferred order when the solver perturbs it. */
  orderFlex: number;
  /** Randomised restarts per lane/shift combination. */
  iterations: number;
  seed: number;
  consecutivePreparers: ConsecutiveRule[];
  /** Raw name -> canonical name, applied before matching (case-insensitive keys). */
  preparerAliases: Record<string, string>;
  jockeyAliases: Record<string, string>;
  /** Jockey values meaning "no rider booked"; ignored for clash checks. */
  noJockeyTokens: string[];
  /** Header names accepted for each logical column (first match wins, case-insensitive). */
  columns: {
    preparer: string[];
    vendor: string[];
    day: string[];
    buo: string[];
    lot: string[];
    breeding: string[];
    jockey: string[];
    colours: string[];
    orderPreparer: string[];
    orderVendor: string[];
    orderPosition: string[];
    orderHeats: string[];
  };
  /** Schedule only this day ("" = all days). Lets Power Automate run one day per call. */
  onlyDay: string;
  /** Optional timing: "HH:MM" start and minutes per heat. 0 disables the Time column. */
  startTime: string;
  minutesPerHeat: number;
}

export interface Horse {
  lot: string;
  preparer: string;
  vendor: string;
  day: string;
  buo: number;
  breeding: string;
  jockey: string;
  /** Normalised jockey key, "" when no jockey booked. */
  jockeyKey: string;
  colours: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface OrderEntry {
  preparer: string;
  vendor: string;
  position: number;
  declaredHeats: number | null;
  sourceRow: number;
}

export interface HeatUnit {
  id: number;
  preparer: string;
  buo: number;
  horses: Horse[];
  jockeyKeys: string[];
}

export type Severity = "ERROR" | "WARNING" | "INFO";

export interface Issue {
  severity: Severity;
  day: string;
  code: string;
  message: string;
}

export interface PlacedHeat {
  heatNo: number;
  preparer: string;
  buo: number;
  horses: Horse[];
  time: string;
  /** Per horse: heats since this jockey's previous ride (null = first ride of day / no jockey). */
  gaps: (number | null)[];
  prevHeat: (number | null)[];
}

export interface Violation {
  jockey: string;
  firstHeat: number;
  secondHeat: number;
  heatsBetween: number;
}

export interface PreparerSummary {
  preparer: string;
  preferredPosition: number;
  entryPosition: number;
  firstHeat: number;
  lastHeat: number;
  heats: number;
  span: number;
  buoMoves: number;
}

export interface DaySchedule {
  day: string;
  heats: PlacedHeat[];
  violations: Violation[];
  preparers: PreparerSummary[];
  /** Target number of preparers breezing at once (the rolling-wave width). */
  lanes: number;
  score: number;
  orderDeviation: number;
  buoMoves: number;
  /** Longest wait (in heats) between two heats of the same preparer. */
  maxIdle: number;
  brokenTurns: number;
  /** Best result found at each window width, for the "Options" sheet. */
  alternatives: Alternative[];
}

export interface RunResult {
  saleCode: string;
  issues: Issue[];
  schedules: DaySchedule[];
  jockeyDisplay: Record<string, string>;
  /** Effective config after applying the Agent Config sheet. */
  config: SchedulerConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultConfig(): SchedulerConfig {
  return {
    saleCode: "SALE",
    days: [
      { name: "Mon", horsesSheet: "Mon", orderSheet: "Mon Order" },
      { name: "Tue", horsesSheet: "Tue", orderSheet: "Tue Order" },
    ],
    minHeatsBetween: 4,
    laneOptions: [5, 6, 7, 8],
    maxBuoShift: 2,
    preferLanes: 0,
    annealSteps: 20000,
    orderFlex: 2,
    iterations: 60,
    seed: 26,
    consecutivePreparers: [],
    preparerAliases: {},
    jockeyAliases: {},
    noJockeyTokens: ["no jockey", "tbc", "tba", "n/a", "-", "none"],
    columns: {
      preparer: ["Preparer Name", "Preparer", "Vendor Code /Presenter", "Presenter"],
      vendor: ["Vendor/Draft Name", "Vendor", "Consignor", "Draft"],
      day: ["Day"],
      buo: ["BUO", "Heat Order", "Breeze Up Order"],
      lot: ["Lot", "Lot No", "Lot Number"],
      breeding: ["Breeding", "Pedigree"],
      jockey: ["Jockey", "Jockey #1", "Rider", "Riders"],
      colours: ["Colours", "Colors", "Silks"],
      orderPreparer: ["Preparer Name", "Preparer"],
      orderVendor: ["Vendor/Draft Name", "Vendor"],
      orderPosition: ["PO", "Preferred Order", "Order"],
      orderHeats: ["Heats", "No Heats"],
    },
    onlyDay: "",
    startTime: "",
    minutesPerHeat: 0,
  };
}

/** Shallow-merge a partial config (e.g. parsed JSON) over the defaults. */
export function mergeConfig(partial: Partial<SchedulerConfig>): SchedulerConfig {
  const base = defaultConfig();
  const merged: SchedulerConfig = { ...base, ...partial };
  merged.columns = { ...base.columns, ...(partial.columns ?? {}) };
  return merged;
}

// ---------------------------------------------------------------------------
// "Agent Config" sheet: lets staff change the rules each sale without code.
// Two columns: Setting | Value. Repeatable settings may appear on many rows.
// ---------------------------------------------------------------------------

export const CONFIG_SHEET = "Agent Config";

export function configFromSheet(values: Cell[][], base: SchedulerConfig): SchedulerConfig {
  const cfg: SchedulerConfig = { ...base, columns: { ...base.columns } };
  let days: DayConfig[] = [];
  const consecutive: ConsecutiveRule[] = [];
  const prepAliases: Record<string, string> = { ...base.preparerAliases };
  const jockAliases: Record<string, string> = { ...base.jockeyAliases };
  const num = (v: string, d: number): number => {
    const n = Number(v);
    return v !== "" && Number.isFinite(n) ? n : d;
  };
  const list = (v: string): string[] => v.split(/[,;]/).map((x) => x.trim()).filter((x) => x !== "");
  for (const row of values) {
    const setting = key(clean(row[0]));
    const value = clean(row[1]);
    if (setting === "" || setting === "setting" || value === "") continue;
    switch (setting) {
      case "salecode": cfg.saleCode = value; break;
      case "minheatsbetween": cfg.minHeatsBetween = num(value, cfg.minHeatsBetween); break;
      case "laneoptions": cfg.laneOptions = list(value).map((x) => num(x, 5)); break;
      case "preferlanes": cfg.preferLanes = num(value, 0); break;
      case "maxbuoshift": cfg.maxBuoShift = num(value, cfg.maxBuoShift); break;
      case "orderflex": cfg.orderFlex = num(value, cfg.orderFlex); break;
      case "iterations": cfg.iterations = num(value, cfg.iterations); break;
      case "annealsteps": cfg.annealSteps = num(value, cfg.annealSteps); break;
      case "seed": cfg.seed = num(value, cfg.seed); break;
      case "starttime": cfg.startTime = value; break;
      case "minutesperheat": cfg.minutesPerHeat = num(value, 0); break;
      case "nojockeytokens": cfg.noJockeyTokens = list(value); break;
      case "day": {
        // "Mon | Mon | Mon Order"  (day name | horses sheet | order sheet)
        const parts = value.split("|").map((x) => x.trim());
        const name = parts[0] ?? "";
        if (name) days.push({ name, horsesSheet: parts[1] || name, orderSheet: parts[2] || `${name} Order` });
        break;
      }
      case "consecutive": {
        // "Prima Park | Mon | 2"
        const parts = value.split("|").map((x) => x.trim());
        if (parts[0]) consecutive.push({ preparer: parts[0], day: parts[1] || "*", heatsPerTurn: num(parts[2] ?? "", 2) });
        break;
      }
      case "prepareralias":
      case "jockeyalias": {
        // "Name as written => Name to use"
        const parts = value.split("=>").map((x) => x.trim());
        if (parts[0] && parts[1]) (setting === "prepareralias" ? prepAliases : jockAliases)[parts[0]] = parts[1];
        break;
      }
      default: break;
    }
  }
  if (days.length === 0) days = base.days;
  cfg.days = days;
  cfg.consecutivePreparers = consecutive.length > 0 ? consecutive : base.consecutivePreparers;
  cfg.preparerAliases = prepAliases;
  cfg.jockeyAliases = jockAliases;
  return cfg;
}

/** A filled-in Agent Config sheet for the given config (used to create the sheet the first time). */
export function configToSheet(cfg: SchedulerConfig): Cell[][] {
  const rows: Cell[][] = [
    ["Setting", "Value", "Notes"],
    ["saleCode", cfg.saleCode, "Sale label used on output, e.g. 27RTR"],
  ];
  for (const d of cfg.days) rows.push(["day", `${d.name} | ${d.horsesSheet} | ${d.orderSheet}`, "Day name | horses sheet | preferred-order sheet. One row per breeze-up day."]);
  rows.push(["minHeatsBetween", cfg.minHeatsBetween, "Minimum heats between two rides of the same jockey"]);
  rows.push(["laneOptions", cfg.laneOptions.join(", "), "Preparers breezing at once to try (tightest first)"]);
  rows.push(["preferLanes", cfg.preferLanes, "0 = automatic; or force a width from the Options sheet"]);
  rows.push(["maxBuoShift", cfg.maxBuoShift, "Max places a heat may move from the preparer's BUO order (0 = never)"]);
  rows.push(["orderFlex", cfg.orderFlex, "Max places a preparer may move from the preferred order"]);
  for (const c of cfg.consecutivePreparers) rows.push(["consecutive", `${c.preparer} | ${c.day} | ${c.heatsPerTurn}`, "Preparer | day (* = all) | heats sent back-to-back"]);
  if (cfg.consecutivePreparers.length === 0) rows.push(["consecutive", "", "e.g. Prima Park | Mon | 2"]);
  for (const k of Object.keys(cfg.preparerAliases)) rows.push(["preparerAlias", `${k} => ${cfg.preparerAliases[k] ?? ""}`, "Name as written => name to use"]);
  for (const k of Object.keys(cfg.jockeyAliases)) rows.push(["jockeyAlias", `${k} => ${cfg.jockeyAliases[k] ?? ""}`, "Name as written => name to use"]);
  if (Object.keys(cfg.jockeyAliases).length === 0) rows.push(["jockeyAlias", "", "e.g. Ryan Elliott => Ryan Elliot"]);
  rows.push(["noJockeyTokens", cfg.noJockeyTokens.join(", "), "Values meaning no rider booked"]);
  rows.push(["startTime", cfg.startTime, "Optional first heat time HH:MM"]);
  rows.push(["minutesPerHeat", cfg.minutesPerHeat, "Optional minutes per heat (0 = no Time column)"]);
  rows.push(["iterations", cfg.iterations, "Advanced: greedy restarts per setting"]);
  rows.push(["annealSteps", cfg.annealSteps, "Advanced: optimiser effort (lower if the script times out)"]);
  rows.push(["seed", cfg.seed, "Advanced: change to get a different equally-good draft"]);
  return rows;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

export function clean(v: Cell): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

export function key(v: string): string {
  return clean(v).toLowerCase();
}

function aliasLookup(aliases: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of Object.keys(aliases)) m.set(key(k), clean(aliases[k] ?? ""));
  return m;
}

function headerIndex(header: Cell[], names: string[]): number {
  const wanted = names.map((n) => key(n));
  for (const w of wanted) {
    for (let i = 0; i < header.length; i++) {
      if (key(clean(header[i])) === w) return i;
    }
  }
  return -1;
}

function findHeaderRow(values: Cell[][], mustHave: string[]): number {
  for (let r = 0; r < Math.min(values.length, 15); r++) {
    const row = values[r] ?? [];
    if (headerIndex(row, mustHave) >= 0) return r;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Parsing (sheet values -> typed rows)
// ---------------------------------------------------------------------------

export function parseHorses(
  values: Cell[][],
  sheetName: string,
  dayName: string,
  cfg: SchedulerConfig,
  issues: Issue[],
): Horse[] {
  const c = cfg.columns;
  const hr = findHeaderRow(values, c.preparer);
  if (hr < 0) {
    issues.push({ severity: "ERROR", day: dayName, code: "NO_HEADER", message: `Sheet "${sheetName}": could not find a preparer header (${c.preparer.join(" / ")}).` });
    return [];
  }
  const header = values[hr] ?? [];
  const idx = {
    preparer: headerIndex(header, c.preparer),
    vendor: headerIndex(header, c.vendor),
    day: headerIndex(header, c.day),
    buo: headerIndex(header, c.buo),
    lot: headerIndex(header, c.lot),
    breeding: headerIndex(header, c.breeding),
    jockey: headerIndex(header, c.jockey),
    colours: headerIndex(header, c.colours),
  };
  for (const req of ["buo", "lot", "jockey"] as const) {
    if (idx[req] < 0) {
      issues.push({ severity: "ERROR", day: dayName, code: "MISSING_COLUMN", message: `Sheet "${sheetName}": required column "${req}" not found (accepted headers: ${c[req].join(" / ")}).` });
    }
  }
  if (idx.buo < 0 || idx.lot < 0 || idx.jockey < 0) return [];
  // Colours often sit in an unlabelled column straight after the jockey.
  if (idx.colours < 0 && clean(header[idx.jockey + 1]) === "") idx.colours = idx.jockey + 1;

  const prepAlias = aliasLookup(cfg.preparerAliases);
  const jockAlias = aliasLookup(cfg.jockeyAliases);
  const noJ = new Set(cfg.noJockeyTokens.map((t) => key(t)));
  const out: Horse[] = [];
  for (let r = hr + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const rawPrep = clean(row[idx.preparer]);
    const lot = clean(row[idx.lot]);
    if (rawPrep === "" && lot === "") continue;
    const preparer = prepAlias.get(key(rawPrep)) ?? rawPrep;
    const buoNum = Number(clean(row[idx.buo]));
    const rawJockey = clean(row[idx.jockey]);
    const jk = jockAlias.get(key(rawJockey)) ?? rawJockey;
    const jockeyKey = noJ.has(key(jk)) || jk === "" ? "" : key(jk);
    const rowDay = idx.day >= 0 ? clean(row[idx.day]) : dayName;
    const horse: Horse = {
      lot,
      preparer,
      vendor: idx.vendor >= 0 ? clean(row[idx.vendor]) : "",
      day: rowDay,
      buo: buoNum,
      breeding: idx.breeding >= 0 ? clean(row[idx.breeding]) : "",
      jockey: jk === "" ? "No Jockey" : jk,
      jockeyKey,
      colours: idx.colours >= 0 ? clean(row[idx.colours]) : "",
      sourceSheet: sheetName,
      sourceRow: r + 1,
    };
    if (rawPrep === "") {
      issues.push({ severity: "ERROR", day: dayName, code: "NO_PREPARER", message: `${sheetName} row ${r + 1}: lot ${lot} has no preparer.` });
      continue;
    }
    if (!Number.isFinite(buoNum) || clean(row[idx.buo]) === "") {
      issues.push({ severity: "ERROR", day: dayName, code: "NO_BUO", message: `${sheetName} row ${r + 1}: lot ${lot} (${preparer}) has no numeric BUO.` });
      continue;
    }
    out.push(horse);
  }
  return out;
}

export function parseOrder(values: Cell[][], sheetName: string, dayName: string, cfg: SchedulerConfig, issues: Issue[]): OrderEntry[] {
  const c = cfg.columns;
  const hr = findHeaderRow(values, c.orderPreparer);
  if (hr < 0) {
    issues.push({ severity: "ERROR", day: dayName, code: "NO_HEADER", message: `Sheet "${sheetName}": could not find a preparer header.` });
    return [];
  }
  const header = values[hr] ?? [];
  const iP = headerIndex(header, c.orderPreparer);
  const iV = headerIndex(header, c.orderVendor);
  const iPo = headerIndex(header, c.orderPosition);
  const iH = headerIndex(header, c.orderHeats);
  const prepAlias = aliasLookup(cfg.preparerAliases);
  const out: OrderEntry[] = [];
  for (let r = hr + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const raw = clean(row[iP]);
    if (raw === "") continue;
    const po = iPo >= 0 ? Number(clean(row[iPo])) : NaN;
    const heats = iH >= 0 && clean(row[iH]) !== "" ? Number(clean(row[iH])) : null;
    out.push({
      preparer: prepAlias.get(key(raw)) ?? raw,
      vendor: iV >= 0 ? clean(row[iV]) : "",
      position: Number.isFinite(po) ? po : out.length + 1,
      declaredHeats: heats !== null && Number.isFinite(heats) ? heats : null,
      sourceRow: r + 1,
    });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function buildHeats(horses: Horse[]): HeatUnit[] {
  const map = new Map<string, HeatUnit>();
  let id = 0;
  for (const h of horses) {
    const k = `${key(h.preparer)}|${h.buo}`;
    let u = map.get(k);
    if (!u) {
      u = { id: id++, preparer: h.preparer, buo: h.buo, horses: [], jockeyKeys: [] };
      map.set(k, u);
    }
    u.horses.push(h);
    if (h.jockeyKey !== "") u.jockeyKeys.push(h.jockeyKey);
  }
  return Array.from(map.values());
}

/** Checks one day's data. Adds issues; returns nothing. */
export function validateDay(day: DayConfig, horses: Horse[], order: OrderEntry[], cfg: SchedulerConfig, issues: Issue[]): void {
  const d = day.name;
  const heats = buildHeats(horses);
  const total = heats.length;

  for (const h of horses) {
    if (h.day !== "" && key(h.day) !== key(d)) {
      issues.push({ severity: "WARNING", day: d, code: "DAY_MISMATCH", message: `${h.sourceSheet} row ${h.sourceRow}: lot ${h.lot} (${h.preparer}) has Day="${h.day}" but is on the ${d} sheet. Scheduled on ${d} - confirm.` });
    }
    if (h.jockeyKey === "") {
      issues.push({ severity: "INFO", day: d, code: "NO_JOCKEY", message: `Lot ${h.lot} (${h.preparer}, BUO ${h.buo}) has no jockey booked - excluded from clash checks.` });
    }
  }

  const lots = new Map<string, Horse[]>();
  for (const h of horses) {
    const arr = lots.get(h.lot) ?? [];
    arr.push(h);
    lots.set(h.lot, arr);
  }
  for (const [lot, arr] of lots) {
    if (arr.length > 1) {
      issues.push({ severity: "ERROR", day: d, code: "DUPLICATE_LOT", message: `Lot ${lot} appears ${arr.length} times on ${d} (rows ${arr.map((x) => x.sourceRow).join(", ")}; jockeys ${arr.map((x) => x.jockey).join(" / ")}).` });
    }
  }

  for (const u of heats) {
    if (u.horses.length > 2) {
      issues.push({ severity: "WARNING", day: d, code: "HEAT_SIZE", message: `${u.preparer} BUO ${u.buo} has ${u.horses.length} horses (expected 1 or 2).` });
    }
    const seen = new Set<string>();
    for (const j of u.jockeyKeys) {
      if (seen.has(j)) issues.push({ severity: "ERROR", day: d, code: "JOCKEY_TWICE_IN_HEAT", message: `${u.preparer} BUO ${u.buo}: jockey "${j}" is booked on both horses.` });
      seen.add(j);
    }
  }

  // Preparer reconciliation between horse list and order sheet.
  const orderKeys = new Map<string, OrderEntry>();
  for (const o of order) orderKeys.set(key(o.preparer), o);
  const heatCount = new Map<string, number>();
  const prepName = new Map<string, string>();
  for (const u of heats) {
    heatCount.set(key(u.preparer), (heatCount.get(key(u.preparer)) ?? 0) + 1);
    prepName.set(key(u.preparer), u.preparer);
  }
  for (const [k, n] of heatCount) {
    const o = orderKeys.get(k);
    if (!o) {
      issues.push({ severity: "WARNING", day: d, code: "PREPARER_NOT_IN_ORDER", message: `Preparer "${prepName.get(k)}" (${n} heats) is on ${day.horsesSheet} but not on ${day.orderSheet}. It will be scheduled LAST - add it to the order sheet or to preparerAliases.` });
    } else if (o.declaredHeats !== null && o.declaredHeats !== n) {
      issues.push({ severity: "WARNING", day: d, code: "HEAT_COUNT_MISMATCH", message: `${prepName.get(k)}: ${day.orderSheet} says ${o.declaredHeats} heats, horse list has ${n}.` });
    }
  }
  for (const o of order) {
    if (!heatCount.has(key(o.preparer))) {
      issues.push({ severity: "WARNING", day: d, code: "PREPARER_NO_HORSES", message: `"${o.preparer}" is on ${day.orderSheet} but has no horses on ${day.horsesSheet}.` });
    }
  }

  // Jockey case/spelling variants, and feasibility of their workload.
  const variants = new Map<string, Set<string>>();
  const rides = new Map<string, number>();
  for (const h of horses) {
    if (h.jockeyKey === "") continue;
    const s = variants.get(h.jockeyKey) ?? new Set<string>();
    s.add(h.jockey);
    variants.set(h.jockeyKey, s);
    rides.set(h.jockeyKey, (rides.get(h.jockeyKey) ?? 0) + 1);
  }
  for (const [, s] of variants) {
    if (s.size > 1) issues.push({ severity: "INFO", day: d, code: "JOCKEY_SPELLING", message: `Jockey written ${s.size} ways: ${Array.from(s).join(" / ")} - treated as one person.` });
  }
  const keys = Array.from(rides.keys()).sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] ?? "";
      const b = keys[j] ?? "";
      if (nearDuplicate(a, b)) {
        issues.push({ severity: "WARNING", day: d, code: "JOCKEY_SIMILAR", message: `Jockeys "${Array.from(variants.get(a) ?? [])[0]}" and "${Array.from(variants.get(b) ?? [])[0]}" look like the same person. If so, add a jockeyAliases entry.` });
      }
    }
  }
  const step = cfg.minHeatsBetween + 1;
  for (const [j, n] of rides) {
    const needed = (n - 1) * step + 1;
    if (needed > total) {
      issues.push({ severity: "ERROR", day: d, code: "JOCKEY_OVERBOOKED", message: `${Array.from(variants.get(j) ?? [j])[0]} has ${n} rides on ${d}; with ${cfg.minHeatsBetween} heats between rides that needs ${needed} heats but the day has only ${total}. Clashes are unavoidable.` });
    } else if (needed > total * 0.85) {
      issues.push({ severity: "WARNING", day: d, code: "JOCKEY_HEAVY", message: `${Array.from(variants.get(j) ?? [j])[0]} has ${n} rides in ${total} heats - very tight; this jockey drives the shape of the day.` });
    }
  }
}

/** Cross-day checks (a lot breezing twice, etc.). */
export function validateAcrossDays(byDay: Map<string, Horse[]>, issues: Issue[]): void {
  const where = new Map<string, string[]>();
  for (const [d, hs] of byDay) {
    for (const h of hs) {
      const arr = where.get(h.lot) ?? [];
      if (!arr.includes(d)) arr.push(d);
      where.set(h.lot, arr);
    }
  }
  for (const [lot, ds] of where) {
    if (ds.length > 1) issues.push({ severity: "ERROR", day: "ALL", code: "LOT_ON_TWO_DAYS", message: `Lot ${lot} is listed on more than one day: ${ds.join(", ")}.` });
  }
}

function nearDuplicate(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a.length < 6) return false;
  // Levenshtein distance <= 1
  const m = a.length;
  const n = b.length;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = cur;
  }
  return (prev[n] ?? 99) <= 1;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
//
// Model ("rolling wave", as used in the 25RTR final programme):
//   - Preparers enter in preferred order. Up to L preparers are "active" at
//     once; each active preparer sends one heat per turn (or N for a
//     consecutive-rule preparer like Prima Park). When a preparer finishes,
//     the next one in the queue enters. So each preparer's horses breeze in
//     one continuous stretch and the stalls empty in arrival order.
//   - With L >= minHeatsBetween + 1, a jockey riding every heat for one
//     preparer automatically gets enough heats between rides.
//   - Clashes from jockeys shared between preparers are avoided greedily: an
//     active preparer whose next heat would clash is skipped for this turn;
//     optionally a heat may swap with the next one or two of the same
//     preparer (buoShift), or the next preparer may come in early.
//   - Many randomised restarts are scored and the best is kept:
//       hard clashes  >>  preferred-order deviation  >  BUO moves  >  spread.

interface Lane {
  preparer: string;
  remaining: HeatUnit[];
  lastServed: number;
  admittedAt: number;
  placed: number;
  perTurn: number;
  entryPos: number;
}

interface RunParams {
  lanes: number;
  buoShift: number;
  queue: string[];
  rng: () => number;
  jitter: number;
}

interface RawRun {
  order: HeatUnit[];
  entryOrder: string[];
  buoMoves: number;
  shortfall: number;
  violations: number;
  /** Turns where a consecutive-rule preparer could not send its full group back-to-back. */
  brokenTurns: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function perTurnFor(preparer: string, day: string, cfg: SchedulerConfig): number {
  for (const r of cfg.consecutivePreparers) {
    if (key(r.preparer) === key(preparer) && (r.day === "*" || key(r.day) === key(day))) return Math.max(1, r.heatsPerTurn);
  }
  return 1;
}

function runOnce(byPrep: Map<string, HeatUnit[]>, day: string, cfg: SchedulerConfig, p: RunParams): RawRun {
  const step = cfg.minHeatsBetween + 1;
  const queue = p.queue.slice();
  const lanes: Lane[] = [];
  const last = new Map<string, number>();
  const order: HeatUnit[] = [];
  const entryOrder: string[] = [];
  let slot = 0;
  let buoMoves = 0;
  let shortfall = 0;
  let violations = 0;
  let brokenTurns = 0;
  let admitted = 0;

  const admit = (): Lane | null => {
    const name = queue.shift();
    if (name === undefined) return null;
    const lane: Lane = {
      preparer: name,
      remaining: (byPrep.get(name) ?? []).slice(),
      lastServed: -1e9 + admitted,
      admittedAt: slot,
      placed: 0,
      perTurn: perTurnFor(name, day, cfg),
      entryPos: admitted,
    };
    admitted++;
    entryOrder.push(name);
    lanes.push(lane);
    return lane;
  };

  // Position of each heat within its preparer's BUO order.
  const rankOf = new Map<number, number>();
  for (const arr of byPrep.values()) arr.forEach((h, i) => rankOf.set(h.id, i));

  // How far into `rem` we may reach: the lowest pending BUO may never fall more
  // than buoShift places behind its preferred position.
  const maxKFor = (lane: Lane, rem: HeatUnit[], placedExtra: number): number => {
    const head = rem[0];
    if (!head) return -1;
    const behind = lane.placed + placedExtra - (rankOf.get(head.id) ?? 0);
    if (behind >= p.buoShift) return 0;
    return Math.min(p.buoShift, rem.length - 1);
  };

  const clashCost = (h: HeatUnit, offset = 0, ridden: HeatUnit[] = []): number => {
    const at = slot + offset;
    let cost = 0;
    for (const j of h.jockeyKeys) {
      let l = last.get(j);
      ridden.forEach((r, i) => {
        if (r.jockeyKeys.includes(j)) l = slot + i;
      });
      if (l !== undefined && at - l < step) cost += step - (at - l);
    }
    return cost;
  };

  // Indices (into lane.remaining, applied in sequence) for a clean full turn, or null.
  const cleanTurn = (lane: Lane): number[] | null => {
    const want = Math.min(lane.perTurn, lane.remaining.length);
    const search = (rem: HeatUnit[], chosen: HeatUnit[], picks: number[]): number[] | null => {
      if (picks.length === want) return picks;
      for (let k = 0; k <= maxKFor(lane, rem, chosen.length); k++) {
        const h = rem[k];
        if (h && clashCost(h, chosen.length, chosen) === 0) {
          const next = rem.slice();
          next.splice(k, 1);
          const found = search(next, chosen.concat([h]), picks.concat([k]));
          if (found) return found;
        }
      }
      return null;
    };
    return search(lane.remaining, [], []);
  };

  const place = (lane: Lane, k: number): void => {
    const h = lane.remaining[k];
    if (!h) return;
    const cost = clashCost(h);
    if (cost > 0) {
      shortfall += cost;
      for (const j of h.jockeyKeys) {
        const l = last.get(j);
        if (l !== undefined && slot - l < step) violations++;
      }
    }
    if (k > 0) buoMoves += k;
    lane.remaining.splice(k, 1);
    lane.placed++;
    for (const j of h.jockeyKeys) last.set(j, slot);
    order.push(h);
    lane.lastServed = slot;
    slot++;
    if (lane.remaining.length === 0) lanes.splice(lanes.indexOf(lane), 1);
  };

  while (lanes.length > 0 || queue.length > 0) {
    while (lanes.length < p.lanes && queue.length > 0) admit();

    // Least-recently-served first; small random jitter explores alternatives.
    const ordered = lanes.slice().sort((a, b) => {
      const ja = p.jitter > 0 && p.rng() < p.jitter ? 1.5 : 0;
      const jb = p.jitter > 0 && p.rng() < p.jitter ? 1.5 : 0;
      return a.lastServed + ja - (b.lastServed + jb);
    });

    let done = false;

    // Anti-starvation: a preparer kept waiting for two full cycles goes next
    // with any clean heat, even if that breaks its consecutive group.
    const starving = ordered.find((l) => l.lastServed > -1e8 && slot - l.lastServed > 2 * p.lanes);
    if (starving) {
      const picks = cleanTurn(starving);
      if (picks) {
        for (const k of picks) place(starving, k);
        continue;
      }
      const maxK = maxKFor(starving, starving.remaining, 0);
      for (let k = 0; k <= maxK && !done; k++) {
        const h = starving.remaining[k];
        if (h && clashCost(h) === 0) {
          place(starving, k);
          if (starving.perTurn > 1) brokenTurns++;
          done = true;
        }
      }
      if (done) continue;
    }

    for (const lane of ordered) {
      const picks = cleanTurn(lane);
      if (picks) {
        for (const k of picks) place(lane, k);
        done = true;
        break;
      }
    }
    if (done) continue;

    // A consecutive-rule preparer may send a single heat rather than stall (counted as a broken turn).
    for (const lane of ordered) {
      if (lane.perTurn <= 1) continue;
      const maxK = maxKFor(lane, lane.remaining, 0);
      for (let k = 0; k <= maxK && !done; k++) {
        const h = lane.remaining[k];
        if (h && clashCost(h) === 0) {
          place(lane, k);
          brokenTurns++;
          done = true;
        }
      }
      if (done) break;
    }
    if (done) continue;

    // Bring the next preparer in early if its first heat is clean.
    if (queue.length > 0) {
      const nextName = queue[0] ?? "";
      const first = (byPrep.get(nextName) ?? [])[0];
      if (first && clashCost(first) === 0) {
        const lane = admit();
        if (lane) {
          const picks = cleanTurn(lane) ?? [0];
          if (lane.perTurn > 1 && picks.length < Math.min(lane.perTurn, lane.remaining.length)) brokenTurns++;
          for (const k of picks) place(lane, k);
          continue;
        }
      }
    }

    // Unavoidable: take the least-bad option.
    let best: Lane | null = null;
    let bestK = 0;
    let bestCost = Infinity;
    for (const lane of ordered) {
      const maxK = maxKFor(lane, lane.remaining, 0);
      for (let k = 0; k <= maxK; k++) {
        const h = lane.remaining[k];
        if (!h) continue;
        const c = clashCost(h) * 10 + k;
        if (c < bestCost) {
          bestCost = c;
          best = lane;
          bestK = k;
        }
      }
    }
    if (!best) break;
    if (best.perTurn > 1) brokenTurns++;
    place(best, bestK);
  }

  return { order, entryOrder, buoMoves, shortfall, violations, brokenTurns };
}

function perturbQueue(base: string[], flex: number, rng: () => number): string[] {
  if (flex <= 0) return base.slice();
  // Sort by (index + random offset in [0, flex]) - keeps every preparer within ~flex places.
  const keyed = base.map((name, i) => ({ name, k: i + rng() * (flex + 0.999) }));
  keyed.sort((a, b) => a.k - b.k);
  return keyed.map((x) => x.name);
}

// ---------------------------------------------------------------------------
// Objective + simulated annealing
// ---------------------------------------------------------------------------

interface ObjectiveContext {
  step: number;
  lanes: number;
  maxShift: number;
  idleLimit: number;
  preferredRank: Map<string, number>;
  buoRank: Map<number, number>;
  perTurn: Map<string, number>;
  heatsOf: Map<string, number>;
}

export interface Breakdown {
  violations: number;
  shortfall: number;
  buoOverCap: number;
  idle: number;
  maxIdle: number;
  overOpen: number;
  deviation: number;
  brokenTurns: number;
  buoMoves: number;
  spread: number;
  total: number;
}

/** Weighted score of a whole day's heat sequence. Lower is better. */
function objective(order: HeatUnit[], ctx: ObjectiveContext): Breakdown {
  const last = new Map<string, number>();
  let violations = 0;
  let shortfall = 0;
  const first = new Map<string, number>();
  const lastIdx = new Map<string, number>();
  const placed = new Map<string, number>();
  const runs = new Map<string, number>();
  let idle = 0;
  let maxIdle = 0;
  let buoMoves = 0;
  let buoOverCap = 0;
  let prevPrep = "";
  for (let i = 0; i < order.length; i++) {
    const h = order[i];
    if (!h) continue;
    for (const j of h.jockeyKeys) {
      const l = last.get(j);
      if (l !== undefined && i - l < ctx.step) {
        violations++;
        shortfall += ctx.step - (i - l);
      }
      last.set(j, i);
    }
    const p = h.preparer;
    const li = lastIdx.get(p);
    if (li === undefined) first.set(p, i);
    else {
      const gap = i - li - 1;
      if (gap > maxIdle) maxIdle = gap;
      if (gap > ctx.idleLimit) idle += gap - ctx.idleLimit;
    }
    lastIdx.set(p, i);
    const k = placed.get(p) ?? 0;
    const disp = Math.abs((ctx.buoRank.get(h.id) ?? k) - k);
    buoMoves += disp;
    if (disp > ctx.maxShift) buoOverCap += disp - ctx.maxShift;
    placed.set(p, k + 1);
    if (p !== prevPrep) runs.set(p, (runs.get(p) ?? 0) + 1);
    prevPrep = p;
  }
  // Entry order vs preferred; spread; preparers open at once.
  const entries = Array.from(first.entries()).sort((x, y) => x[1] - y[1]);
  let deviation = 0;
  entries.forEach(([p], i) => {
    deviation += Math.abs(i - (ctx.preferredRank.get(p) ?? i));
  });
  let spread = 0;
  const delta: number[] = new Array<number>(order.length + 1).fill(0);
  for (const [p, f] of first) {
    const l = lastIdx.get(p) ?? f;
    spread += l - f + 1 - (ctx.heatsOf.get(p) ?? 0);
    delta[f] = (delta[f] ?? 0) + 1;
    delta[l + 1] = (delta[l + 1] ?? 0) - 1;
  }
  let open = 0;
  let overOpen = 0;
  for (let i = 0; i < order.length; i++) {
    open += delta[i] ?? 0;
    if (open > ctx.lanes) overOpen += open - ctx.lanes;
  }
  let brokenTurns = 0;
  for (const [p, n] of ctx.perTurn) {
    if (n <= 1) continue;
    const expected = Math.ceil((ctx.heatsOf.get(p) ?? 0) / n);
    brokenTurns += Math.max(0, (runs.get(p) ?? 0) - expected);
  }
  const total =
    violations * 100000 + shortfall * 10000 + buoOverCap * 100000 +
    idle * 300 + brokenTurns * 300 + deviation * 100 + overOpen * 30 + buoMoves * 20 + spread;
  return { violations, shortfall, buoOverCap, idle, maxIdle, overOpen, deviation, brokenTurns, buoMoves, spread, total };
}

function anneal(start: HeatUnit[], ctx: ObjectiveContext, rng: () => number, steps: number): HeatUnit[] {
  let cur = start.slice();
  let curScore = objective(cur, ctx).total;
  let best = cur.slice();
  let bestScore = curScore;
  const n = cur.length;
  if (n < 3) return best;
  const reach = Math.max(2, 2 * ctx.lanes);
  const t0 = 3000;
  const t1 = 2;
  for (let s = 0; s < steps; s++) {
    const temp = t0 * Math.pow(t1 / t0, s / steps);
    const i = Math.floor(rng() * n);
    let j = i + Math.floor(rng() * (2 * reach + 1)) - reach;
    if (j < 0) j = 0;
    if (j >= n) j = n - 1;
    if (i === j) continue;
    const next = cur.slice();
    if (rng() < 0.5) {
      const a = next[i];
      const b = next[j];
      if (!a || !b) continue;
      next[i] = b;
      next[j] = a;
    } else {
      const [moved] = next.splice(i, 1);
      if (!moved) continue;
      next.splice(j, 0, moved);
    }
    const sc = objective(next, ctx).total;
    const d = sc - curScore;
    if (d <= 0 || rng() < Math.exp(-d / temp)) {
      cur = next;
      curScore = sc;
      if (sc < bestScore) {
        bestScore = sc;
        best = next.slice();
      }
    }
  }
  return best;
}

export interface Alternative {
  lanes: number;
  breakdown: Breakdown;
}

export function scheduleDay(day: DayConfig, horses: Horse[], order: OrderEntry[], cfg: SchedulerConfig): DaySchedule {
  const heats = buildHeats(horses);
  const byPrep = new Map<string, HeatUnit[]>();
  for (const h of heats) {
    const arr = byPrep.get(h.preparer) ?? [];
    arr.push(h);
    byPrep.set(h.preparer, arr);
  }
  for (const arr of byPrep.values()) arr.sort((a, b) => a.buo - b.buo);

  // Preferred queue: order sheet first (only preparers with horses), then any unlisted preparers.
  const nameByKey = new Map<string, string>();
  for (const p of byPrep.keys()) nameByKey.set(key(p), p);
  const preferred: string[] = [];
  for (const o of order) {
    const n = nameByKey.get(key(o.preparer));
    if (n && !preferred.includes(n)) preferred.push(n);
  }
  for (const p of byPrep.keys()) if (!preferred.includes(p)) preferred.push(p);

  const buoRank = new Map<number, number>();
  const heatsOf = new Map<string, number>();
  const perTurn = new Map<string, number>();
  for (const [p, arr] of byPrep) {
    arr.forEach((h, i) => buoRank.set(h.id, i));
    heatsOf.set(p, arr.length);
    perTurn.set(p, perTurnFor(p, day.name, cfg));
  }
  const preferredRank = new Map<string, number>();
  preferred.forEach((p, i) => preferredRank.set(p, i));

  const rng = mulberry32(cfg.seed + day.name.length * 101);
  const shifts: number[] = [];
  for (let k = 0; k <= Math.max(0, cfg.maxBuoShift); k++) shifts.push(k);

  // Escalation ladder: try the tightest window first (preparers stay closest
  // together) and only widen it when clashes remain.
  const alternatives: Alternative[] = [];
  let chosen: { order: HeatUnit[]; lanes: number; b: Breakdown } | null = null;
  const ladder = cfg.laneOptions.slice().sort((a, b) => a - b);
  for (const lanes of ladder) {
    const ctx: ObjectiveContext = { step: cfg.minHeatsBetween + 1, lanes, maxShift: cfg.maxBuoShift, idleLimit: 2 * lanes, preferredRank, buoRank, perTurn, heatsOf };
    // 1. Greedy rolling-wave constructions; keep the few best seeds.
    let seeds: { order: HeatUnit[]; score: number }[] = [];
    for (const shift of shifts) {
      for (let it = 0; it < Math.max(1, cfg.iterations); it++) {
        const queue = it === 0 ? preferred.slice() : perturbQueue(preferred, cfg.orderFlex, rng);
        const r = runOnce(byPrep, day.name, cfg, { lanes, buoShift: shift, queue, rng, jitter: it === 0 ? 0 : 0.15 });
        const sc = objective(r.order, ctx).total;
        if (seeds.length < 3 || sc < (seeds[seeds.length - 1]?.score ?? Infinity)) {
          seeds.push({ order: r.order, score: sc });
          seeds.sort((x, y) => x.score - y.score);
          seeds = seeds.slice(0, 3);
        }
      }
    }
    // 2. Simulated annealing on each seed.
    let levelBest: { order: HeatUnit[]; b: Breakdown } | null = null;
    for (const sd of seeds) {
      const improved = anneal(sd.order, ctx, rng, cfg.annealSteps);
      const b = objective(improved, ctx);
      if (!levelBest || b.total < levelBest.b.total) levelBest = { order: improved, b };
    }
    if (!levelBest) continue;
    alternatives.push({ lanes, breakdown: levelBest.b });
    const forced = cfg.preferLanes > 0 && lanes === cfg.preferLanes;
    const clean = levelBest.b.violations === 0 && levelBest.b.buoOverCap === 0;
    if (forced) {
      chosen = { order: levelBest.order, lanes, b: levelBest.b };
    } else if (cfg.preferLanes <= 0) {
      if (!chosen || (chosen.b.violations > 0 && levelBest.b.violations < chosen.b.violations)) chosen = { order: levelBest.order, lanes, b: levelBest.b };
      if (clean) {
        chosen = { order: levelBest.order, lanes, b: levelBest.b };
        break;
      }
    }
  }

  const fallback = { order: [] as HeatUnit[], lanes: 0, b: objective([], { step: 1, lanes: 1, maxShift: 0, idleLimit: 1, preferredRank, buoRank, perTurn, heatsOf }) };
  const pick = chosen ?? fallback;
  return materialise(day.name, pick.order, preferred, byPrep, cfg, pick.lanes, pick.b, alternatives);
}

function formatTime(start: string, minutes: number, idx: number): string {
  if (!start || minutes <= 0) return "";
  const parts = start.split(":");
  const base = Number(parts[0] ?? 0) * 60 + Number(parts[1] ?? 0);
  const t = base + idx * minutes;
  const hh = Math.floor(t / 60) % 24;
  const mm = Math.round(t % 60);
  return `${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;
}

function materialise(
  day: string,
  order: HeatUnit[],
  preferred: string[],
  byPrep: Map<string, HeatUnit[]>,
  cfg: SchedulerConfig,
  lanes: number,
  b: Breakdown,
  alternatives: Alternative[],
): DaySchedule {
  const last = new Map<string, number>();
  const heats: PlacedHeat[] = [];
  const violations: Violation[] = [];
  const display = new Map<string, string>();
  order.forEach((u, i) => {
    const heatNo = i + 1;
    const gaps: (number | null)[] = [];
    const prevHeat: (number | null)[] = [];
    for (const h of u.horses) {
      if (h.jockeyKey === "") {
        gaps.push(null);
        prevHeat.push(null);
        continue;
      }
      display.set(h.jockeyKey, h.jockey);
      const l = last.get(h.jockeyKey);
      if (l === undefined) {
        gaps.push(null);
        prevHeat.push(null);
      } else {
        const between = heatNo - l - 1;
        gaps.push(between);
        prevHeat.push(l);
        if (between < cfg.minHeatsBetween) violations.push({ jockey: h.jockey, firstHeat: l, secondHeat: heatNo, heatsBetween: between });
      }
      last.set(h.jockeyKey, heatNo);
    }
    heats.push({ heatNo, preparer: u.preparer, buo: u.buo, horses: u.horses, time: formatTime(cfg.startTime, cfg.minutesPerHeat, i), gaps, prevHeat });
  });

  const entryOrder: string[] = [];
  for (const u of order) if (!entryOrder.includes(u.preparer)) entryOrder.push(u.preparer);
  const preparers: PreparerSummary[] = entryOrder.map((p, i) => {
    const mine = heats.filter((h) => h.preparer === p);
    const firstHeat = mine[0]?.heatNo ?? 0;
    const lastHeat = mine[mine.length - 1]?.heatNo ?? 0;
    let moves = 0;
    const sortedBuo = mine.map((h) => h.buo).slice().sort((a, b) => a - b);
    mine.forEach((h, k) => {
      if (h.buo !== sortedBuo[k]) moves++;
    });
    return {
      preparer: p,
      preferredPosition: preferred.indexOf(p) + 1,
      entryPosition: i + 1,
      firstHeat,
      lastHeat,
      heats: (byPrep.get(p) ?? []).length,
      span: lastHeat - firstHeat + 1,
      buoMoves: moves,
    };
  });

  return { day, heats, violations, preparers, lanes, score: b.total, orderDeviation: b.deviation, buoMoves: b.buoMoves, maxIdle: b.maxIdle, brokenTurns: b.brokenTurns, alternatives };
}

// ---------------------------------------------------------------------------
// End-to-end: workbook values in, result out
// ---------------------------------------------------------------------------

export interface SheetReader {
  /** Return the sheet's used-range values, or null if the sheet does not exist. */
  (name: string): Cell[][] | null;
}

/**
 * Precedence: defaults/baseCfg < "Agent Config" sheet < overrides (run-time
 * parameters from the CLI or Power Automate).
 */
export function run(read: SheetReader, baseCfg: SchedulerConfig, overrides: Partial<SchedulerConfig> = {}): RunResult {
  const issues: Issue[] = [];
  const sheetCfg = read(CONFIG_SHEET);
  const cfg: SchedulerConfig = { ...(sheetCfg ? configFromSheet(sheetCfg, baseCfg) : baseCfg), ...overrides };
  const byDay = new Map<string, Horse[]>();
  const orders = new Map<string, OrderEntry[]>();
  for (const d of cfg.days) {
    const hv = read(d.horsesSheet);
    const ov = read(d.orderSheet);
    if (!hv) issues.push({ severity: "ERROR", day: d.name, code: "MISSING_SHEET", message: `Sheet "${d.horsesSheet}" not found.` });
    if (!ov) issues.push({ severity: "ERROR", day: d.name, code: "MISSING_SHEET", message: `Sheet "${d.orderSheet}" not found.` });
    const horses = hv ? parseHorses(hv, d.horsesSheet, d.name, cfg, issues) : [];
    const order = ov ? parseOrder(ov, d.orderSheet, d.name, cfg, issues) : [];
    byDay.set(d.name, horses);
    orders.set(d.name, order);
    validateDay(d, horses, order, cfg, issues);
  }
  validateAcrossDays(byDay, issues);

  const schedules: DaySchedule[] = [];
  const jockeyDisplay: Record<string, string> = {};
  for (const d of cfg.days) {
    const horses = byDay.get(d.name) ?? [];
    if (horses.length === 0) continue;
    if (cfg.onlyDay !== "" && key(cfg.onlyDay) !== key(d.name)) continue;
    const s = scheduleDay(d, horses, orders.get(d.name) ?? [], cfg);
    schedules.push(s);
    for (const h of horses) if (h.jockeyKey !== "") jockeyDisplay[h.jockeyKey] = h.jockey;
    if (s.violations.length > 0) {
      issues.push({ severity: "WARNING", day: d.name, code: "CLASHES_REMAIN", message: `${s.violations.length} jockey ride(s) on ${d.name} have fewer than ${cfg.minHeatsBetween} heats between them - see Clashes. Review manually or adjust bookings.` });
    } else {
      issues.push({ severity: "INFO", day: d.name, code: "CLASH_FREE", message: `${d.name}: all jockeys have at least ${cfg.minHeatsBetween} heats between rides.` });
    }
  }
  const rank: Record<Severity, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { saleCode: cfg.saleCode, issues, schedules, jockeyDisplay, config: cfg };
}

// ---------------------------------------------------------------------------
// Output tables (2-D arrays, written to sheets by each host)
// ---------------------------------------------------------------------------

export interface OutputSheet {
  name: string;
  rows: Cell[][];
}

export function buildOutputSheets(res: RunResult): OutputSheet[] {
  const cfg = res.config;
  const sheets: OutputSheet[] = [];

  // Summary
  const sum: Cell[][] = [[`${res.saleCode} Breeze Up - NZB Breeze Up Agent`, ""], ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")], ["Min heats between rides", cfg.minHeatsBetween], [""]];
  sum.push(["Day", "Heats", "Horses", "Preparers", "Clashes", "Preparers breezing at once", "Longest preparer wait (heats)", "Order deviation", "BUO moves", "Broken consecutive turns"]);
  for (const s of res.schedules) {
    sum.push([s.day, s.heats.length, s.heats.reduce((n, h) => n + h.horses.length, 0), s.preparers.length, s.violations.length, s.lanes, s.maxIdle, s.orderDeviation, s.buoMoves, s.brokenTurns]);
  }
  sum.push([""]);
  const counts: Record<Severity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const i of res.issues) counts[i.severity]++;
  sum.push(["Data issues", `${counts.ERROR} errors, ${counts.WARNING} warnings, ${counts.INFO} info - see Validation sheet`]);
  sheets.push({ name: "Summary", rows: sum });

  for (const s of res.schedules) {
    const rows: Cell[][] = [["Heat", "Time", "Preparer", "Vendor", "BUO", "Lot", "Breeding", "Jockey", "Colours", "Jockey's previous heat", "Heats between", "Check"]];
    for (const h of s.heats) {
      h.horses.forEach((x, i) => {
        const gap = h.gaps[i] ?? null;
        const check = x.jockeyKey === "" ? "No jockey" : gap === null ? "First ride" : gap < cfg.minHeatsBetween ? "CLASH" : "OK";
        rows.push([h.heatNo, i === 0 ? h.time : "", h.preparer, x.vendor, h.buo, numOrText(x.lot), x.breeding, x.jockey, x.colours, h.prevHeat[i] ?? "", gap ?? "", check]);
      });
    }
    sheets.push({ name: `${s.day} Schedule`, rows });

    // Programme in last year's layout: horse line then jockey line.
    const prog: Cell[][] = [["Consignor", "No", "Heat", "Lot", "Breeding", "Time"]];
    let n = 0;
    for (const h of s.heats) {
      h.horses.forEach((x, i) => {
        n++;
        prog.push([x.vendor || h.preparer, n, i === 0 ? h.heatNo : "", numOrText(x.lot), x.breeding, i === 0 ? h.time : ""]);
        prog.push([`Jockey: ${x.jockey}`, "", "", "", x.colours, ""]);
      });
    }
    sheets.push({ name: `${s.day} Programme`, rows: prog });

    const prep: Cell[][] = [["Entry", "Preferred", "Preparer", "Heats", "First heat", "Last heat", "Span (heats)", "BUO changes"]];
    for (const p of s.preparers) prep.push([p.entryPosition, p.preferredPosition, p.preparer, p.heats, p.firstHeat, p.lastHeat, p.span, p.buoMoves]);
    sheets.push({ name: `${s.day} Preparers`, rows: prep });

    // Jockey grid: one row per jockey, heats they ride.
    const jr = new Map<string, number[]>();
    for (const h of s.heats) for (const x of h.horses) if (x.jockeyKey !== "") {
      const arr = jr.get(x.jockey) ?? [];
      arr.push(h.heatNo);
      jr.set(x.jockey, arr);
    }
    const grid: Cell[][] = [["Jockey", "Rides", "Min heats between", "Heats ridden"]];
    const names = Array.from(jr.keys()).sort((a, b) => (jr.get(b)?.length ?? 0) - (jr.get(a)?.length ?? 0) || a.localeCompare(b));
    for (const name of names) {
      const hs = jr.get(name) ?? [];
      let minGap: number | string = "";
      for (let i = 1; i < hs.length; i++) {
        const g = (hs[i] ?? 0) - (hs[i - 1] ?? 0) - 1;
        if (minGap === "" || g < (minGap as number)) minGap = g;
      }
      grid.push([name, hs.length, minGap, hs.join(", ")]);
    }
    sheets.push({ name: `${s.day} Jockeys`, rows: grid });
  }

  const opts: Cell[][] = [["Day", "Preparers breezing at once", "Clashes", "Longest preparer wait", "Order deviation", "BUO moves", "Broken consecutive turns", "Chosen"]];
  for (const s of res.schedules) {
    for (const a of s.alternatives) {
      const b = a.breakdown;
      opts.push([s.day, a.lanes, b.violations, b.maxIdle, b.deviation, b.buoMoves, b.brokenTurns, a.lanes === s.lanes ? "YES" : ""]);
    }
  }
  opts.push([""]);
  opts.push(["Fewer preparers at once = each preparer's horses closer together. To force a width, set preferLanes in the config and re-run."]);
  sheets.push({ name: "Options", rows: opts });

  const clash: Cell[][] = [["Day", "Jockey", "Heat", "Next heat", "Heats between"]];
  for (const s of res.schedules) for (const v of s.violations) clash.push([s.day, v.jockey, v.firstHeat, v.secondHeat, v.heatsBetween]);
  if (clash.length === 1) clash.push(["", "No clashes", "", "", ""]);
  sheets.push({ name: "Clashes", rows: clash });

  sheets.push({ name: "Agent Config (used)", rows: configToSheet(cfg) });

  const val: Cell[][] = [["Severity", "Day", "Code", "Message"]];
  for (const i of res.issues) val.push([i.severity, i.day, i.code, i.message]);
  sheets.push({ name: "Validation", rows: val });
  return sheets;
}

function numOrText(v: string): Cell {
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n : v;
}

/** Compact JSON summary for Power Automate / Copilot Studio to read back. */
export function summarise(res: RunResult): string {
  return JSON.stringify({
    sale: res.saleCode,
    errors: res.issues.filter((i) => i.severity === "ERROR").map((i) => `${i.day}: ${i.message}`),
    warnings: res.issues.filter((i) => i.severity === "WARNING").map((i) => `${i.day}: ${i.message}`),
    days: res.schedules.map((s) => ({
      day: s.day,
      heats: s.heats.length,
      clashes: s.violations.length,
      clashList: s.violations.map((v) => `${v.jockey} heats ${v.firstHeat} & ${v.secondHeat}`),
      preparersActiveAtOnce: s.lanes,
      longestPreparerWait: s.maxIdle,
      options: s.alternatives.map((a) => `${a.lanes} at once: ${a.breakdown.violations} clashes, longest wait ${a.breakdown.maxIdle}`),
      preparerOrder: s.preparers.map((p) => `${p.entryPosition}. ${p.preparer} (heats ${p.firstHeat}-${p.lastHeat})`),
    })),
  });
}
