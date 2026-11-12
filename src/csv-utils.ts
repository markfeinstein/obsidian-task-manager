export type CsvCellValue = string | number | boolean | null | undefined;

export function encodeCsvCell(value: CsvCellValue): string {
  if (value === null || value === undefined) return '';
  const safeValue = neutralizeCsvFormula(String(value));
  if (/[",\r\n]/u.test(safeValue)) return `"${safeValue.replace(/"/gu, '""')}"`;
  return safeValue;
}

export function neutralizeCsvFormula(value: string): string {
  return /^(?:[\t\r]|\s*[=+\-@])/u.test(value) ? `'${value}` : value;
}
