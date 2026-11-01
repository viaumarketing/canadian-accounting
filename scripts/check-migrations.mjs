#!/usr/bin/env node
// CI guard for rollback safety (docs/dxp2800.md, "Migrations and rollback").
// Every migration from BASELINE on must start with `-- ca:compat additive` or `-- ca:compat breaking`.
//  - additive: the previous release must keep working on the new schema, so no destructive or incompatible SQL is allowed;
//  - breaking: must raise the level (UPDATE "SchemaCompat" SET "level" = N) and N must equal SCHEMA_COMPAT_LEVEL in the code.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'packages/database/prisma/migrations');
const BASELINE = '20261103000000';
const codeLevel = Number(/SCHEMA_COMPAT_LEVEL = (\d+)/.exec(readFileSync(join(root, 'apps/api/src/common/schema-compat.ts'), 'utf8'))?.[1]);

const INCOMPATIBLE = [
  [/\bDROP\s+TABLE\b/i, 'drops a table'],
  [/\bDROP\s+COLUMN\b/i, 'drops a column'],
  [/\bRENAME\b/i, 'renames something'],
  [/\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [/\bSET\s+NOT\s+NULL\b/i, 'makes a column required'],
  [/\bADD\s+COLUMN\s+"?\w+"?\s+[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i, 'adds a required column without a default'],
  [/\bALTER\s+TYPE\b[^;]*\bADD\s+VALUE\b/i, 'adds an enum value the old version cannot read'],
  [/\bDROP\s+TYPE\b/i, 'drops a type'],
];

const problems = [];
let highestBreaking = 1;
for (const name of readdirSync(dir).filter((n) => /^\d{14}_/.test(n)).sort()) {
  if (name.slice(0, 14) < BASELINE) continue;
  const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
  const header = /^--\s*ca:compat\s+(additive|breaking)\b/m.exec(sql.split('\n').slice(0, 3).join('\n'))?.[1];
  const body = sql.replace(/--.*$/gm, '');
  if (!header) { problems.push(`${name}: first lines must declare "-- ca:compat additive" or "-- ca:compat breaking"`); continue; }
  if (header === 'additive') {
    for (const [re, what] of INCOMPATIBLE) if (re.test(body)) problems.push(`${name}: declared additive but ${what}; make it additive (expand now, contract in a later release) or declare it breaking`);
  } else {
    const m = /UPDATE\s+"SchemaCompat"\s+SET\s+"level"\s*=\s*(\d+)/i.exec(body);
    if (!m) problems.push(`${name}: declared breaking but does not raise the level (UPDATE "SchemaCompat" SET "level" = N)`);
    else highestBreaking = Math.max(highestBreaking, Number(m[1]));
  }
}
if (highestBreaking !== codeLevel) problems.push(`SCHEMA_COMPAT_LEVEL in apps/api/src/common/schema-compat.ts is ${codeLevel}, but migrations raise the level to ${highestBreaking}`);

if (problems.length) {
  console.error('Migration compatibility check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`migrations ok (schema compatibility level ${codeLevel})`);
