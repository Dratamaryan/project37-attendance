// Spreadsheet formula-injection guard for server-generated .xlsx exports.
// A string cell starting with = + - @ TAB or CR may be evaluated as a formula
// by Excel / LibreOffice / Sheets (esp. after a CSV round-trip). Prefixing a
// single quote forces it to be read as literal text. Non-string values
// (numbers, booleans, null) pass through untouched.

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r'])

// Strict E.164 is pure digits after '+', so it can't carry a formula payload —
// exempting it keeps the Phone columns readable (S8-T5 decision D1).
const STRICT_E164 = /^\+[1-9]\d{6,14}$/

export function sheetSafe(value: string): string {
  if (value.length === 0) return value
  if (STRICT_E164.test(value)) return value
  return FORMULA_LEADERS.has(value[0]!) ? `'${value}` : value
}

export function sheetSafeRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'string' ? sheetSafe(value) : value
  }
  return out as T
}
