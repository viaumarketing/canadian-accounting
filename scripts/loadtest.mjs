#!/usr/bin/env node
// Mixed-workload load test against a running stack (through Caddy, like a browser).
//   node scripts/loadtest.mjs --url https://ca.example.lan:8443 --email admin@... --password ... [--users 12] [--minutes 10] [--insecure]
//   --setup-only FILE   create the companies, write their ids to FILE and stop (so history can be bulk-loaded first)
//   --companies-file FILE   reuse companies from an earlier --setup-only run
// --insecure accepts Caddy's internal certificate on a machine that has not trusted it (test use only).
// It creates its own companies ("Load Test N"), so run it against a test instance, not your real books.
// Prints latency percentiles per operation and the error count; exits 1 if any request failed unexpectedly.
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('url');
const EMAIL = arg('email');
const PASSWORD = arg('password');
const USERS = Number(arg('users', 12));
const MINUTES = Number(arg('minutes', 10));
const COMPANIES = Number(arg('companies', 3));
if (!BASE || !EMAIL || !PASSWORD) { console.error('usage: --url --email --password [--users] [--minutes] [--companies] [--insecure]'); process.exit(2); }
if (process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ORIGIN = new URL(BASE).origin;
const API = `${ORIGIN}/api`;

function client() {
  let cookie = '';
  return async (method, path, body, { raw = false, headers = {} } = {}) => {
    const t = performance.now();
    const isBuf = body instanceof Uint8Array;
    const r = await fetch(API + path, { method, headers: { origin: ORIGIN, cookie, ...(body && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers }, body: isBuf ? body : body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = performance.now() - t;
    let json = null; if (!raw) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ } }
    return { status: r.status, json, bytes: buf.length, ms };
  };
}

const stats = new Map();
let failures = 0;
const failSamples = [];
function record(op, r, ok) {
  const s = stats.get(op) ?? { n: 0, ms: [], errors: 0 };
  s.n++; s.ms.push(r.ms); if (!ok) { s.errors++; failures++; if (failSamples.length < 15) failSamples.push(`${op} -> ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`); }
  stats.set(op, s);
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

// ---------------------------------------------------------------- setup
const admin = client();
const login = await admin('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
if (login.status !== 200) { console.error('admin login failed', login.status, login.json); process.exit(2); }
const companies = arg('companies-file') ? JSON.parse(readFileSync(arg('companies-file'), 'utf8')) : [];
const toCreate = companies.length ? 0 : COMPANIES;
for (let i = 1; i <= toCreate; i++) {
  const c = await admin('POST', '/admin/companies', { legalName: `Load Test ${i} ${Date.now()}`, province: ['ON', 'QC', 'BC'][i % 3], ownerEmail: EMAIL });
  if (c.status !== 201) { console.error('create company', c.status, c.json); process.exit(2); }
  const id = c.json.id;
  await admin('POST', `/companies/${id}/fiscal-years`, { startDate: '2026-01-01' });
  const accts = (await admin('GET', `/companies/${id}/accounts`)).json;
  const codes = (await admin('GET', `/companies/${id}/tax-codes`)).json;
  const by = Object.fromEntries(accts.map((a) => [a.code, a.id]));
  const customer = (await admin('POST', `/companies/${id}/contacts`, { kind: 'CUSTOMER', name: 'Load Customer' })).json.id;
  const bank = (await admin('POST', `/companies/${id}/banking/accounts`, { name: 'Chequing', kind: 'CHEQUING', mask: '0001', ledgerAccountId: by['1010'] })).json.id;
  const expense = accts.find((a) => a.type === 'EXPENSE' && !a.role).id;
  const revenue = accts.find((a) => a.type === 'REVENUE' && !a.role).id;
  const taxCode = codes.find((t) => /HST|GST/.test(t.code))?.id ?? codes[0]?.id;
  companies.push({ id, by, customer, bank, expense, revenue, taxCode });
}
console.log(`setup: ${companies.length} companies`);
if (arg('setup-only')) { writeFileSync(arg('setup-only'), JSON.stringify(companies)); console.log(`wrote ${arg('setup-only')}`); process.exit(0); }

const CSV_MAPPING = JSON.stringify({ hasHeader: true, dateColumn: 0, dateFormat: 'YMD', descriptionColumns: [1], amount: { mode: 'split', debitColumn: 2, creditColumn: 3 } });
let fileNo = 0;
const day = () => `2026-${String(1 + Math.floor(Math.random() * 10)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
const money = () => (5 + Math.random() * 900).toFixed(2);

// Each virtual user signs in with the shared admin session (owner of every load-test company).
const OPS = [
  [25, 'dashboard', (c, co) => c('GET', `/companies/${co.id}/dashboard`), (r) => r.status === 200],
  [8, 'report profit-loss', (c, co) => c('GET', `/companies/${co.id}/report/profit-loss?from=2026-01-01&to=2026-12-31&compare=prior_year`), (r) => r.status === 200],
  [6, 'report balance-sheet', (c, co) => c('GET', `/companies/${co.id}/report/balance-sheet?asOf=2026-12-31`), (r) => r.status === 200],
  [5, 'report trial-balance', (c, co) => c('GET', `/companies/${co.id}/report/trial-balance?to=2026-12-31`), (r) => r.status === 200],
  [5, 'report gst-hst', (c, co) => c('GET', `/companies/${co.id}/report/tax-gst-hst?from=2026-01-01&to=2026-12-31`), (r) => r.status === 200],
  [3, 'export pdf', (c, co) => c('GET', `/companies/${co.id}/report/profit-loss?format=pdf&from=2026-01-01&to=2026-12-31`, null, { raw: true }), (r) => r.status === 200 && r.bytes > 1000],
  [3, 'export xlsx', (c, co) => c('GET', `/companies/${co.id}/report/general-ledger?format=xlsx&accountId=${co.by['1010']}&from=2026-01-01&to=2026-12-31`, null, { raw: true }), (r) => r.status === 200],
  [10, 'journals list', (c, co) => c('GET', `/companies/${co.id}/journals?take=50`), (r) => r.status === 200],
  [12, 'post journal', (c, co) => c('POST', `/companies/${co.id}/journals`, (() => { const a = money(); return { date: day(), memo: 'load', post: true, lines: [{ accountId: co.expense, debit: a }, { accountId: co.by['1010'], credit: a }] }; })()), (r) => r.status === 201],
  [8, 'invoice create+post', async (c, co) => {
    const inv = await c('POST', `/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: day(), dueDate: '2026-12-31', lines: [{ description: 'Maple syrup', quantity: '2', unitPrice: money(), accountId: co.revenue, taxCodeId: co.taxCode }] });
    if (inv.status !== 201) return inv;
    const p = await c('POST', `/companies/${co.id}/invoices/${inv.json.id}/post`, {});
    return { ...p, ms: inv.ms + p.ms };
  }, (r) => r.status === 201 || r.status === 200],
  [4, 'bank CSV import', (c, co) => {
    fileNo++;
    const rows = Array.from({ length: 40 }, (_, i) => `${day()},LOAD ${fileNo}-${i} PAYEE,${i % 2 ? money() : ''},${i % 2 ? '' : money()}`);
    const csv = Buffer.from(`Date,Description,Withdrawals,Deposits\n${rows.join('\n')}\n`);
    return c('POST', `/companies/${co.id}/banking/accounts/${co.bank}/import/commit?filename=load-${fileNo}.csv`, csv, { headers: { 'content-type': 'application/octet-stream', 'x-import-mapping': CSV_MAPPING } });
  }, (r) => r.status === 201],
  [6, 'bank transactions', (c, co) => c('GET', `/companies/${co.id}/banking/transactions?bankAccountId=${co.bank}`), (r) => r.status === 200],
  [5, 'admin resources', (c) => c('GET', '/admin/resources?hours=1'), (r) => r.status === 200],
];
const total = OPS.reduce((s, o) => s + o[0], 0);
const pick = () => { let x = Math.random() * total; for (const o of OPS) { x -= o[0]; if (x <= 0) return o; } return OPS[0]; };

const until = Date.now() + MINUTES * 60_000;
async function vu(n) {
  // Stagger sign-ins: every virtual user shares this machine's IP, and the API allows 10 logins per minute per IP.
  await sleep(n * 7_000);
  const c = client();
  const l = await c('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  if (l.status !== 200) { console.error(`vu ${n} login failed`, l.status); failures++; return; }
  while (Date.now() < until) {
    const [, name, fn, ok] = pick();
    const co = companies[Math.floor(Math.random() * companies.length)];
    let r;
    try { r = await fn(c, co); } catch (e) { r = { status: 0, json: { error: String(e) }, ms: 0 }; }
    record(name, r, ok(r));
    await sleep(300 + Math.random() * 1200); // think time: people click, read, click
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => vu(i)));
const secs = (Date.now() - t0) / 1000;

const rows = [...stats.entries()].map(([op, s]) => ({ operation: op, count: s.n, errors: s.errors, p50_ms: Math.round(pct(s.ms, 50)), p95_ms: Math.round(pct(s.ms, 95)), max_ms: Math.round(Math.max(...s.ms)) }));
console.table(rows);
const n = rows.reduce((a, r) => a + r.count, 0);
console.log(JSON.stringify({ users: USERS, seconds: Math.round(secs), requests: n, perSecond: +(n / secs).toFixed(1), failures }));
if (failSamples.length) console.log('failures (first 15):\n  ' + failSamples.join('\n  '));
process.exit(failures ? 1 : 0);
