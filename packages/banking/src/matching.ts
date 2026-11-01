import Decimal from 'decimal.js';
import { normaliseDescription } from './fingerprint';

const tokens = (s: string) => new Set(normaliseDescription(s).split(/[^A-Z0-9]+/).filter((t) => t.length >= 3));
export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / (A.size + B.size - hit);
}
const dayDiff = (a: string, b: string) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** An unreconciled journal line on the bank's ledger account. `signed` = debit − credit (same sign as the bank transaction). */
export interface LedgerCandidate {
  lineId: string;
  date: string;
  signed: string;
  memo?: string | null;
  contactName?: string | null;
  sourceType?: string | null;
  reference?: string | null;
}
export interface MatchSuggestion { lineId: string; confidence: number; reasons: string[] }

export const MIN_CONFIDENCE = 0.6;

/**
 * Score ledger lines against a bank transaction. An exact signed-amount match is REQUIRED; everything else only moves confidence.
 * Confidence is advice to a human, never a licence to post: see the approval workflow in the API.
 */
export function suggestMatches(txn: { date: string; amount: string; description: string }, candidates: LedgerCandidate[], o: { windowDays?: number; min?: number; max?: number } = {}): MatchSuggestion[] {
  const window = o.windowDays ?? 30;
  const scored = candidates
    .filter((c) => new Decimal(c.signed).eq(txn.amount) && dayDiff(txn.date, c.date) <= window)
    .map((c) => {
      const reasons = ['exact amount'];
      let s = 0.5;
      const dd = dayDiff(txn.date, c.date);
      const dScore = dd === 0 ? 0.3 : dd <= 1 ? 0.26 : dd <= 3 ? 0.2 : dd <= 7 ? 0.12 : dd <= 14 ? 0.05 : 0;
      if (dScore) reasons.push(dd === 0 ? 'same day' : `${dd} day${dd === 1 ? '' : 's'} apart`);
      s += dScore;
      const text = [c.memo, c.contactName, c.reference].filter(Boolean).join(' ');
      const sim = text ? similarity(txn.description, text) : 0;
      if (sim > 0) { s += 0.15 * Math.min(1, sim * 2); reasons.push('similar text'); }
      if (c.sourceType === 'shopify_payout' && /SHOPIFY/i.test(txn.description)) { s += 0.1; reasons.push('Shopify payout'); }
      if (c.reference && normaliseDescription(txn.description).includes(normaliseDescription(c.reference))) { s += 0.05; reasons.push('reference in description'); }
      return { lineId: c.lineId, confidence: s, reasons };
    });
  if (scored.length === 1) { scored[0].confidence += 0.05; scored[0].reasons.push('only candidate'); }
  const top = Math.max(0, ...scored.map((x) => x.confidence));
  const ties = scored.filter((x) => Math.abs(x.confidence - top) < 1e-9).length;
  if (ties > 1) for (const x of scored) if (Math.abs(x.confidence - top) < 1e-9) { x.confidence -= 0.15; x.reasons.push(`ambiguous: ${ties} equally good candidates`); }
  return scored
    .map((x) => ({ ...x, confidence: Math.round(Math.min(0.99, Math.max(0, x.confidence)) * 1000) / 1000 })) // never 100%: a person still approves
    .filter((x) => x.confidence >= (o.min ?? MIN_CONFIDENCE))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, o.max ?? 3);
}

/** Suggest an open invoice/bill that a deposit/withdrawal may be settling. */
export function scoreDocument(txn: { amount: string; description: string }, doc: { number: string | null; outstanding: string; contactName: string }): { confidence: number; reasons: string[] } | null {
  const amt = new Decimal(txn.amount).abs();
  const out = new Decimal(doc.outstanding);
  const sim = similarity(txn.description, doc.contactName);
  const numberHit = doc.number && normaliseDescription(txn.description).includes(normaliseDescription(doc.number));
  const reasons: string[] = [];
  let s = 0;
  if (amt.eq(out)) { s += 0.55; reasons.push('amount equals outstanding balance'); }
  else if (amt.lt(out) && (sim > 0 || numberHit)) { s += 0.3; reasons.push('looks like a partial payment'); }
  else return null;
  if (sim > 0) { s += 0.3 * Math.min(1, sim * 2); reasons.push('contact name in description'); }
  if (numberHit) { s += 0.2; reasons.push('document number in description'); }
  const c = Math.round(Math.min(0.99, s) * 1000) / 1000;
  return c >= 0.5 ? { confidence: c, reasons } : null;
}

/** Pair opposite-signed equal amounts across two different accounts within 3 days (money moved between your own accounts). */
export function findTransferPairs(txns: { id: string; bankAccountId: string; date: string; amount: string }[]): { fromId: string; toId: string; confidence: number }[] {
  const out: { fromId: string; toId: string; confidence: number; dd: number }[] = [];
  const used = new Set<string>();
  const outs = txns.filter((t) => new Decimal(t.amount).isNegative());
  const ins = txns.filter((t) => new Decimal(t.amount).isPositive());
  const pairs: { o: (typeof outs)[number]; i: (typeof ins)[number]; dd: number }[] = [];
  for (const o of outs) for (const i of ins) {
    if (o.bankAccountId === i.bankAccountId || !new Decimal(o.amount).neg().eq(i.amount)) continue;
    const dd = dayDiff(o.date, i.date);
    if (dd <= 3) pairs.push({ o, i, dd });
  }
  pairs.sort((a, b) => a.dd - b.dd);
  for (const p of pairs) {
    if (used.has(p.o.id) || used.has(p.i.id)) continue;
    used.add(p.o.id); used.add(p.i.id);
    out.push({ fromId: p.o.id, toId: p.i.id, confidence: Math.round((0.9 - 0.05 * p.dd) * 100) / 100, dd: p.dd });
  }
  return out.map(({ dd: _dd, ...r }) => r);
}

// ----------------------------------------------------------------------------- rules

export interface RuleConditions {
  /** Case-insensitive substrings; ANY may match. (No regex on purpose: user-supplied patterns run over tens of thousands of rows.) */
  descriptionContains?: string[];
  direction?: 'IN' | 'OUT';
  minAmount?: string; // absolute value
  maxAmount?: string;
  bankAccountId?: string;
}
export interface RuleLike { id: string; priority: number; conditions: RuleConditions; accountId: string; isActive: boolean }

export function ruleMatches(c: RuleConditions, t: { description: string; amount: string; bankAccountId: string }): boolean {
  const amt = new Decimal(t.amount);
  if (c.bankAccountId && c.bankAccountId !== t.bankAccountId) return false;
  if (c.direction === 'IN' && !amt.isPositive()) return false;
  if (c.direction === 'OUT' && !amt.isNegative()) return false;
  if (c.minAmount && amt.abs().lt(c.minAmount)) return false;
  if (c.maxAmount && amt.abs().gt(c.maxAmount)) return false;
  if (c.descriptionContains?.length) {
    const d = normaliseDescription(t.description);
    if (!c.descriptionContains.some((x) => x.trim() && d.includes(normaliseDescription(x)))) return false;
  }
  return Boolean(c.descriptionContains?.length || c.direction || c.minAmount || c.maxAmount); // an empty rule matches nothing
}

/** First active rule (lowest priority number, then insertion order) that matches. */
export function firstMatchingRule<R extends RuleLike>(rules: R[], t: { description: string; amount: string; bankAccountId: string }): R | null {
  return [...rules].filter((r) => r.isActive).sort((a, b) => a.priority - b.priority).find((r) => ruleMatches(r.conditions, t)) ?? null;
}

// ----------------------------------------------------------------------------- reconciliation

export interface ReconSummary { opening: string; cleared: string; computedEnding: string; statementEnding: string; difference: string; balanced: boolean }
/** opening + Σ cleared must equal the statement's ending balance, to the cent. */
export function reconSummary(p: { opening: Decimal.Value; cleared: Decimal.Value[]; statementEnding: Decimal.Value }): ReconSummary {
  const cleared = p.cleared.reduce<Decimal>((s, v) => s.plus(v), new Decimal(0));
  const computed = new Decimal(p.opening).plus(cleared);
  const diff = computed.minus(p.statementEnding);
  return { opening: new Decimal(p.opening).toFixed(2), cleared: cleared.toFixed(2), computedEnding: computed.toFixed(2), statementEnding: new Decimal(p.statementEnding).toFixed(2), difference: diff.toFixed(2), balanced: diff.isZero() };
}
