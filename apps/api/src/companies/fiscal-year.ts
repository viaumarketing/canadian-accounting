const pad = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const utc = (y: number, m1: number, d: number) => new Date(Date.UTC(y, m1 - 1, d));

/** Fiscal year end in a given calendar year; day is clamped (e.g. Feb 31 -> Feb 28/29). */
export function fiscalYearEnd(year: number, endMonth: number, endDay: number): Date {
  return utc(year, endMonth, Math.min(endDay, daysInMonth(year, endMonth)));
}

/** The fiscal year containing `today` for a company with the given year-end. Dates are UTC midnights. */
export function currentFiscalYear(today: Date, endMonth: number, endDay: number) {
  const t = utc(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate());
  let endYear = t.getUTCFullYear();
  if (fiscalYearEnd(endYear, endMonth, endDay) < t) endYear += 1;
  const endDate = fiscalYearEnd(endYear, endMonth, endDay);
  const prevEnd = fiscalYearEnd(endYear - 1, endMonth, endDay);
  const startDate = new Date(prevEnd.getTime() + 86_400_000);
  return { startDate, endDate, label: `FY${endYear}` };
}

export const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
