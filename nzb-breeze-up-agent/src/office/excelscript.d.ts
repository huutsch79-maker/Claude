// Minimal typings for the parts of the Office Scripts API this project uses,
// so the bundled script can be type-checked locally (tsconfig.office.json).
declare namespace ExcelScript {
  interface Workbook {
    getWorksheets(): Worksheet[];
    getWorksheet(name: string): Worksheet | undefined;
    addWorksheet(name?: string): Worksheet;
  }
  interface Worksheet {
    getName(): string;
    delete(): void;
    getUsedRange(valuesOnly?: boolean): Range | undefined;
    getRangeByIndexes(startRow: number, startColumn: number, rowCount: number, columnCount: number): Range;
    getFreezePanes(): WorksheetFreezePanes;
  }
  interface WorksheetFreezePanes {
    freezeRows(count?: number): void;
  }
  interface Range {
    getValues(): (string | number | boolean)[][];
    setValues(values: (string | number | boolean)[][]): void;
    getRowIndex(): number;
    getColumnIndex(): number;
    getFormat(): RangeFormat;
  }
  interface RangeFormat {
    getFont(): RangeFont;
    getFill(): RangeFill;
    autofitColumns(): void;
  }
  interface RangeFont {
    setBold(bold: boolean): void;
  }
  interface RangeFill {
    setColor(color: string): void;
  }
}
