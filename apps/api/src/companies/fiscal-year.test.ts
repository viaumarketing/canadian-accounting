import { describe, expect, it } from 'vitest';
import { currentFiscalYear, isoDate } from './fiscal-year';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('currentFiscalYear', () => {
  it('calendar year end', () => {
    const fy = currentFiscalYear(d('2026-10-29'), 12, 31);
    expect([isoDate(fy.startDate), isoDate(fy.endDate), fy.label]).toEqual(['2026-01-01', '2026-12-31', 'FY2026']);
  });
  it('March 31 year end, date after year end rolls forward', () => {
    const fy = currentFiscalYear(d('2026-04-01'), 3, 31);
    expect([isoDate(fy.startDate), isoDate(fy.endDate), fy.label]).toEqual(['2026-04-01', '2027-03-31', 'FY2027']);
  });
  it('on the year-end day itself is still in that year', () => {
    const fy = currentFiscalYear(d('2026-03-31'), 3, 31);
    expect(isoDate(fy.endDate)).toBe('2026-03-31');
  });
  it('clamps Feb 31 and handles leap years', () => {
    expect(isoDate(currentFiscalYear(d('2027-06-01'), 2, 31).endDate)).toBe('2028-02-29');
    expect(isoDate(currentFiscalYear(d('2026-06-01'), 2, 31).endDate)).toBe('2027-02-28');
  });
  it('year start follows previous year end across a leap day', () => {
    expect(isoDate(currentFiscalYear(d('2028-03-01'), 2, 29).startDate)).toBe('2028-03-01');
  });
});
