// Local runner: reads the Heat Schedule workbook, writes a draft schedule workbook.
//
//   npm run schedule -- <input.xlsx> [--config config/rtr26.config.json] [--out output/draft.xlsx]

import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { buildOutputSheets, mergeConfig, run, summarise, type Cell, type SchedulerConfig } from "./core.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("error" in v) return null;
  }
  return String(v);
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("usage: npm run schedule -- <input.xlsx> [--config file.json] [--out file.xlsx] [--day Mon] [--config-text agent-config.txt]");
    process.exit(2);
  }
  const cfgPath = arg("--config");
  const cfg: SchedulerConfig = mergeConfig(cfgPath ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Partial<SchedulerConfig>) : {});
  const out = arg("--out") ?? `output/${cfg.saleCode}_Heat_Schedule_Draft.xlsx`;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(input);
  const reader = (name: string): Cell[][] | null => {
    const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!ws) return null;
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: Cell[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellValue(row.getCell(c).value));
      rows[n - 1] = vals;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  };

  const t0 = Date.now();
  const onlyDay = arg("--day");
  const sharedCfg = arg("--config-text");
  const res = run(reader, cfg, onlyDay ? { onlyDay } : {}, sharedCfg ? readFileSync(sharedCfg, "utf8") : "");
  const ms = Date.now() - t0;

  const outWb = new ExcelJS.Workbook();
  for (const s of buildOutputSheets(res)) {
    const ws = outWb.addWorksheet(s.name.slice(0, 31));
    for (const r of s.rows) ws.addRow(r);
    ws.getRow(1).font = { bold: true, name: "Arial" };
    ws.eachRow((row, n) => {
      if (n > 1) row.font = { name: "Arial" };
    });
    if (s.name.endsWith("Schedule")) {
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.autoFilter = { from: "A1", to: "L1" };
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const check = String(row.getCell(12).value ?? "");
        if (check === "CLASH") row.getCell(12).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
        // Band alternate heats so pairs read together.
        if (Number(row.getCell(1).value) % 2 === 0) {
          for (let c = 1; c <= 11; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
        }
      });
    }
    ws.columns.forEach((col) => {
      let w = 8;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        w = Math.max(w, Math.min(60, String(cell.value ?? "").length + 2));
      });
      col.width = w;
    });
  }
  mkdirSync(dirname(out), { recursive: true });
  await outWb.xlsx.writeFile(out);

  console.log(`Wrote ${out} in ${ms} ms`);
  const summary = JSON.parse(summarise(res)) as { errors: string[]; warnings: string[]; days: { day: string; heats: number; clashes: number; clashList: string[]; preparersActiveAtOnce: number }[] };
  for (const d of summary.days) console.log(`${d.day}: ${d.heats} heats, ${d.clashes} clashes, ${d.preparersActiveAtOnce} preparers active at once${d.clashes ? " -> " + d.clashList.join("; ") : ""}`);
  console.log(`${summary.errors.length} data errors, ${summary.warnings.length} warnings (see Validation sheet)`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
