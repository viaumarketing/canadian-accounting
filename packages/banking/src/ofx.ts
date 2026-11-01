import Decimal from 'decimal.js';
import type { NormBankTxn, ParseResult, StatementMeta } from './types';

/**
 * OFX 1.x (SGML, unclosed leaf tags) and 2.x (XML) / QFX. Deliberately NOT an XML parser: it is a flat tag scanner, so there
 * is no DTD/entity expansion (no XXE / billion-laughs) and malformed SGML is tolerated.
 */
const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).trim();

export function looksLikeOfx(text: string): boolean {
  return /<OFX[\s>]/i.test(text.slice(0, 20_000)) || /^OFXHEADER:/m.test(text.slice(0, 2_000));
}

const ofxDate = (v: string): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim());
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export function parseOfx(text: string): ParseResult & { meta: StatementMeta } {
  const body = text.slice(Math.max(0, text.search(/<OFX/i)));
  if (!/<OFX/i.test(body)) throw new Error('Not an OFX file');
  const rows: NormBankTxn[] = [];
  const errors: ParseResult['errors'] = [];
  const meta: StatementMeta = { format: 'ofx' };
  let cur: Record<string, string> | null = null;
  let inCard = false;
  let inLedger = false;
  let n = 0;
  const re = /<(\/?)([A-Za-z0-9.]+)>([^<]*)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const closing = m[1] === '/';
    const tag = m[2].toUpperCase();
    const val = decode(m[3]);
    if (closing) {
      if (tag === 'STMTTRN' && cur) {
        n += 1;
        const date = ofxDate(cur.DTPOSTED ?? '');
        try {
          if (!date) throw new Error(`Bad DTPOSTED "${cur.DTPOSTED ?? ''}"`);
          if (!/^[+-]?\d*[.,]?\d+$/.test(cur.TRNAMT ?? '')) throw new Error(`Bad TRNAMT "${cur.TRNAMT ?? ''}"`);
          const amt = new Decimal((cur.TRNAMT ?? '0').replace(',', '.'));
          if (amt.isZero()) throw new Error('Zero amount');
          const description = [cur.NAME, cur.MEMO].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || cur.TRNTYPE || '';
          if (!description) throw new Error('Missing description');
          rows.push({ date, description, amount: amt.toFixed(2), ...(cur.FITID ? { externalId: cur.FITID } : {}) });
        } catch (e) { errors.push({ line: n, message: (e as Error).message }); }
        cur = null;
      }
      if (tag === 'LEDGERBAL') inLedger = false;
      continue;
    }
    switch (tag) {
      case 'STMTTRN': cur = {}; break;
      case 'CCSTMTRS': case 'CCACCTFROM': inCard = true; meta.accountKind = 'CREDIT_CARD'; break;
      case 'LEDGERBAL': inLedger = true; break;
      case 'ACCTTYPE': if (!inCard) meta.accountKind = /SAV/i.test(val) ? 'SAVINGS' : 'CHEQUING'; break;
      case 'ACCTID': meta.accountMask = val.replace(/\s/g, '').slice(-4); break;
      case 'CURDEF': meta.currency = val.toUpperCase(); break;
      case 'DTSTART': if (!cur) meta.periodStart = ofxDate(val) ?? undefined; break;
      case 'DTEND': if (!cur) meta.periodEnd = ofxDate(val) ?? undefined; break;
      case 'BALAMT': if (inLedger && /^[+-]?\d*\.?\d+$/.test(val)) meta.endingBalance = new Decimal(val).toFixed(2); break;
      default: if (cur && val !== '') cur[tag] = val;
    }
  }
  return { rows, errors, meta };
}
