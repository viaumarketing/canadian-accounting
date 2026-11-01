// Validates every GraphQL document in src/queries.ts against Shopify's published schema.
// Usage: node scripts/validate-queries.mjs [introspection.json]   (default: fetch from shopify.dev for API_VERSION)
import { readFileSync } from 'node:fs';
import { buildClientSchema, getIntrospectionQuery, parse, validate } from 'graphql';
import { ALL_QUERIES, API_VERSION } from '../dist/index.js';

let data;
if (process.argv[2]) data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
else {
  const r = await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${API_VERSION}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: getIntrospectionQuery() }) });
  data = (await r.json()).data;
}
const schema = buildClientSchema(data);
let bad = 0;
for (const [name, q] of Object.entries(ALL_QUERIES)) {
  const errs = validate(schema, parse(q));
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${name}`);
  for (const e of errs) { bad++; console.log('     ', e.message); }
}
process.exit(bad ? 1 : 0);
