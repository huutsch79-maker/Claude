// ===========================================================================
// NZB Breeze Up Agent - Excel Office Script entry point.
//
// Run from Excel (Automate > the script > Run) or from Power Automate
// ("Excel Online (Business) - Run script"), which is how the Copilot Studio
// agent calls it. Reads the horse / order / Agent Config sheets in THIS
// workbook, writes the draft schedule sheets back into it, and returns a JSON
// summary for the agent to read out.
//
// Parameters (all optional, set by Power Automate):
//   preferLanes - force "preparers breezing at once" (0 = automatic)
//   seed        - change to get an alternative, equally-valid draft (0 = keep)
//   onlyDay     - schedule just one day, e.g. "Mon" ("" = all days). Use one
//                 call per day if a large sale hits the script time limit.
//   timeBudgetSeconds - stop and return the best schedule found after this many
//                 seconds (0 = use the config value). Use ~60 when the agent
//                 waits for the answer in chat (Copilot allows 100 s per tool).
//   configText  - the sale rules from the shared Agent Config file, one
//                 "setting: value" per line. Lets a user upload a plain Heat
//                 Schedule workbook to the agent without an Agent Config sheet.
// ===========================================================================

function main(workbook: ExcelScript.Workbook, preferLanes: number = 0, seed: number = 0, onlyDay: string = "", configText: string = "", timeBudgetSeconds: number = 0): string {
  const read = (name: string): Cell[][] | null => {
    const ws = workbook.getWorksheets().find((w) => w.getName().trim().toLowerCase() === name.trim().toLowerCase());
    if (!ws) return null;
    const used = ws.getUsedRange(true);
    if (!used) return [];
    // Pad so row/column indices match the sheet (used range may not start at A1).
    const rowOff = used.getRowIndex();
    const colOff = used.getColumnIndex();
    const vals = used.getValues() as Cell[][];
    const out: Cell[][] = [];
    for (let r = 0; r < rowOff; r++) out.push([]);
    for (const row of vals) {
      const padded: Cell[] = [];
      for (let c = 0; c < colOff; c++) padded.push(null);
      out.push(padded.concat(row));
    }
    return out;
  };

  const cfg = defaultConfig();
  // Without shared config text, create an Agent Config sheet so staff can edit the rules in the workbook.
  if (configText.trim() === "" && !read(CONFIG_SHEET)) writeSheet(workbook, CONFIG_SHEET, configToSheet(cfg));

  const overrides: Partial<SchedulerConfig> = {};
  if (preferLanes > 0) overrides.preferLanes = preferLanes;
  if (seed > 0) overrides.seed = seed;
  if (onlyDay.trim() !== "") overrides.onlyDay = onlyDay.trim();
  if (timeBudgetSeconds > 0) overrides.timeBudgetSeconds = timeBudgetSeconds;
  const res = run(read, cfg, overrides, configText);

  // Per-day runs keep their own Summary/Validation sheets so they don't overwrite each other.
  const dayTag = overrides.onlyDay ? `${overrides.onlyDay} ` : "";
  for (const s of buildOutputSheets(res)) {
    const tag = dayTag !== "" && s.name.startsWith(dayTag) ? "" : dayTag;
    writeSheet(workbook, `${res.saleCode} ${tag}${s.name}`.slice(0, 31), s.rows);
  }
  return summarise(res);
}

function writeSheet(workbook: ExcelScript.Workbook, name: string, rows: Cell[][]): void {
  const existing = workbook.getWorksheet(name);
  if (existing) existing.delete();
  const ws = workbook.addWorksheet(name);
  if (rows.length === 0) return;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);
  const grid: (string | number | boolean)[][] = rows.map((r) => {
    const out: (string | number | boolean)[] = [];
    for (let c = 0; c < width; c++) {
      const v = r[c];
      out.push(v === null || v === undefined ? "" : v);
    }
    return out;
  });
  const range = ws.getRangeByIndexes(0, 0, grid.length, width);
  range.setValues(grid);
  const header = ws.getRangeByIndexes(0, 0, 1, width);
  header.getFormat().getFont().setBold(true);
  ws.getFreezePanes().freezeRows(1);
  range.getFormat().autofitColumns();
  // Highlight clashes on schedule sheets.
  if (name.endsWith("Schedule")) {
    for (let r = 1; r < grid.length; r++) {
      if (grid[r]?.[width - 1] === "CLASH") ws.getRangeByIndexes(r, 0, 1, width).getFormat().getFill().setColor("#FFC7CE");
    }
  }
}
