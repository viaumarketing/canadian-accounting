import Decimal from 'decimal.js';
import type { TaxLine } from '@ca/canadian-tax';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface LineInput {
  accountId: string;
  debit: string;
  credit: string;
  memo?: string;
  contactId?: string | null;
}

export class UnbalancedEntryError extends Error {}

const D = (v: Decimal.Value) => new Decimal(v);

export function totals(lines: { debit: Decimal.Value; credit: Decimal.Value }[]) {
  return {
    debit: lines.reduce((s, l) => s.plus(l.debit), D(0)),
    credit: lines.reduce((s, l) => s.plus(l.credit), D(0)),
  };
}

/** Throws unless the lines form a valid, balanced entry: ≥2 lines, each one-sided and positive, Σdebit = Σcredit > 0. */
export function assertBalanced(lines: { debit: Decimal.Value; credit: Decimal.Value }[]): void {
  if (lines.length < 2) throw new UnbalancedEntryError('A journal entry needs at least two lines');
  for (const l of lines) {
    const d = D(l.debit);
    const c = D(l.credit);
    if (d.isNegative() || c.isNegative()) throw new UnbalancedEntryError('Amounts cannot be negative');
    if (d.gt(0) === c.gt(0)) throw new UnbalancedEntryError('Each line must have exactly one of debit or credit');
  }
  const t = totals(lines);
  if (!t.debit.eq(t.credit)) throw new UnbalancedEntryError(`Unbalanced entry: debits ${t.debit.toFixed(2)} ≠ credits ${t.credit.toFixed(2)}`);
  if (t.debit.isZero()) throw new UnbalancedEntryError('Entry has no amount');
}

/** Accounts the engine needs, resolved by the caller from AccountRole. Missing ones are only an error if used. */
export interface TaxAccounts {
  gstHstPayable?: string;
  gstHstReceivable?: string;
  qstPayable?: string;
  qstReceivable?: string;
  pstPayable?: string;
}

export interface DocLine {
  accountId: string;
  net: string;
  taxes: TaxLine[];
  memo?: string;
}

const need = (id: string | undefined, what: string): string => {
  if (!id) throw new Error(`Missing required account: ${what}`);
  return id;
};

function payableAccount(c: TaxLine['component'], a: TaxAccounts): string {
  if (c === 'GST' || c === 'HST') return need(a.gstHstPayable, 'GST/HST payable');
  if (c === 'QST') return need(a.qstPayable, 'QST payable');
  return need(a.pstPayable, 'PST payable');
}
function receivableAccount(c: TaxLine['component'], a: TaxAccounts): string {
  if (c === 'GST' || c === 'HST') return need(a.gstHstReceivable, 'GST/HST receivable (ITC)');
  if (c === 'QST') return need(a.qstReceivable, 'QST receivable (ITR)');
  throw new Error('PST has no recoverable account; it must be treated as non-recoverable');
}

/** Collapse lines on the same account/side/contact so the journal stays readable. */
function compact(lines: LineInput[]): LineInput[] {
  const m = new Map<string, LineInput>();
  for (const l of lines) {
    const key = `${l.accountId}|${D(l.debit).gt(0) ? 'D' : 'C'}|${l.contactId ?? ''}|${l.memo ?? ''}`;
    const cur = m.get(key);
    if (cur) {
      cur.debit = D(cur.debit).plus(l.debit).toFixed(2);
      cur.credit = D(cur.credit).plus(l.credit).toFixed(2);
    } else m.set(key, { ...l });
  }
  return [...m.values()].filter((l) => D(l.debit).gt(0) || D(l.credit).gt(0));
}

const side = (isDebit: boolean, amount: Decimal.Value) => ({
  debit: isDebit ? D(amount).toFixed(2) : '0.00',
  credit: isDebit ? '0.00' : D(amount).toFixed(2),
});

/**
 * Sales invoice (or credit note when `credit`): Dr A/R total; Cr revenue per line; Cr tax payable per component.
 * Credit notes mirror every side.
 */
export function salesJournal(p: { lines: DocLine[]; receivableId: string; contactId?: string | null; taxAccounts: TaxAccounts; credit?: boolean; memo?: string }): LineInput[] {
  const flip = Boolean(p.credit); // for a credit note, A/R is credited
  const out: LineInput[] = [];
  let total = D(0);
  for (const l of p.lines) {
    out.push({ accountId: l.accountId, ...side(flip, l.net), memo: l.memo ?? p.memo, contactId: p.contactId });
    total = total.plus(l.net);
    for (const t of l.taxes) {
      out.push({ accountId: payableAccount(t.component, p.taxAccounts), ...side(flip, t.amount), memo: `${t.component} collected`, contactId: p.contactId });
      total = total.plus(t.amount);
    }
  }
  out.push({ accountId: p.receivableId, ...side(!flip, total), memo: p.memo, contactId: p.contactId });
  const res = compact(out);
  assertBalanced(res);
  return res;
}

/**
 * Bill / vendor credit / expense. Recoverable tax → receivable (ITC/ITR) account; non-recoverable tax is added to the
 * line's cost. `counterAccountId` is A/P for bills, or the paid-from account for expenses.
 */
export function purchaseJournal(p: { lines: DocLine[]; counterAccountId: string; contactId?: string | null; taxAccounts: TaxAccounts; credit?: boolean; memo?: string }): LineInput[] {
  const flip = Boolean(p.credit); // vendor credit: expense side credited, A/P debited
  const out: LineInput[] = [];
  let total = D(0);
  for (const l of p.lines) {
    let cost = D(l.net);
    for (const t of l.taxes) {
      if (t.recoverable) {
        out.push({ accountId: receivableAccount(t.component, p.taxAccounts), ...side(!flip, t.amount), memo: `${t.component} recoverable`, contactId: p.contactId });
      } else cost = cost.plus(t.amount);
      total = total.plus(t.amount);
    }
    out.push({ accountId: l.accountId, ...side(!flip, cost), memo: l.memo ?? p.memo, contactId: p.contactId });
    total = total.plus(l.net);
  }
  out.push({ accountId: p.counterAccountId, ...side(flip, total), memo: p.memo, contactId: p.contactId });
  const res = compact(out);
  assertBalanced(res);
  return res;
}

/** Customer receipt: Dr bank, Cr A/R. Supplier payment: Dr A/P, Cr bank. */
export function paymentJournal(p: { direction: 'RECEIPT' | 'DISBURSEMENT'; amount: string; bankAccountId: string; controlAccountId: string; contactId: string; memo?: string }): LineInput[] {
  const receipt = p.direction === 'RECEIPT';
  const res: LineInput[] = [
    { accountId: p.bankAccountId, ...side(receipt, p.amount), memo: p.memo, contactId: p.contactId },
    { accountId: p.controlAccountId, ...side(!receipt, p.amount), memo: p.memo, contactId: p.contactId },
  ];
  assertBalanced(res);
  return res;
}

/** Exact mirror image of a posted entry, for authorised reversals. */
export function reverseLines(lines: { accountId: string; debit: Decimal.Value; credit: Decimal.Value; memo?: string | null; contactId?: string | null }[]): LineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    debit: D(l.credit).toFixed(2),
    credit: D(l.debit).toFixed(2),
    memo: l.memo ?? undefined,
    contactId: l.contactId,
  }));
}
