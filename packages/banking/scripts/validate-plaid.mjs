// Checks every Plaid endpoint and field this adapter uses against Plaid's published OpenAPI spec.
// Usage: node scripts/validate-plaid.mjs [path-to-2020-09-14.yml]   (default: download from github.com/plaid/plaid-openapi)
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PLAID_SCHEMA_FIELDS, PLAID_USAGE } from '../dist/index.js';

const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await (await fetch('https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml')).text();
const spec = parse(src);
const S = spec.components.schemas;
const deref = (s) => (s?.$ref ? deref(S[s.$ref.split('/').pop()]) : s);
function props(s) {
  s = deref(s);
  if (!s) return {};
  let p = { ...(s.properties ?? {}) };
  for (const part of s.allOf ?? []) p = { ...p, ...props(part) };
  return p;
}
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

for (const [path, u] of Object.entries(PLAID_USAGE)) {
  const op = spec.paths[path]?.post;
  check(Boolean(op), `POST ${path} exists`);
  if (!op) continue;
  const reqProps = props(op.requestBody?.content?.['application/json']?.schema);
  for (const f of u.request) check(f in reqProps, `${path} request.${f}`);
  const resProps = props(op.responses?.['200']?.content?.['application/json']?.schema);
  for (const f of u.response) check(f in resProps, `${path} response.${f}`);
}
for (const [name, fields] of Object.entries(PLAID_SCHEMA_FIELDS)) {
  const p = props(S[name]);
  for (const f of fields) check(f in p, `${name}.${f}`);
}
check(S.CountryCode.enum.includes('CA'), 'country code CA is valid');
check(S.Products.enum.includes('transactions'), 'product "transactions" is valid');
const count = S.TransactionsSyncRequest.properties.count;
check(count.maximum >= 500, `transactions/sync count max ≥ 500 (is ${count.maximum})`);
process.exit(bad ? 1 : 0);
