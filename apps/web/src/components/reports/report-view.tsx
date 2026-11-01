'use client';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { fmtMoney } from '@/lib/company';

export interface Col { key: string; label: string; kind: 'text' | 'money' | 'pct' | 'date' | 'int' }
export interface RRow { cells: Record<string, string | number | null>; level?: number; bold?: boolean }
export interface RSection { title?: string; columns: Col[]; rows: RRow[]; totals?: RRow[] }
export interface ReportData { key: string; title: string; subtitle?: string; company: string; generatedAt: string; sections: RSection[]; checks: { label: string; ok: boolean; detail?: string }[]; notes: string[] }

const show = (c: Col, v: string | number | null) => (v === null || v === undefined || v === '' ? '' : c.kind === 'money' ? fmtMoney(v) : c.kind === 'pct' ? `${Number(v).toFixed(1)}%` : String(v));

export function ReportView({ r }: { r: ReportData }) {
  return (
    <div className="space-y-4" data-testid="report">
      <div><h2 className="text-xl font-semibold">{r.title}</h2><p className="text-sm text-muted-foreground">{r.company}{r.subtitle ? ` · ${r.subtitle}` : ''}</p></div>
      {r.checks.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Checks against the ledger">
          {r.checks.map((c) => (
            <li key={c.label} className={`flex items-start gap-2 ${c.ok ? 'text-success' : 'font-medium text-destructive'}`}>
              {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-label="passed" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-label="failed" />}
              <span>{c.label}{c.detail ? ` — ${c.detail}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {r.sections.map((s, i) => (
        <section key={i} className="space-y-1">
          {s.title && <h3 className="text-sm font-semibold">{s.title}</h3>}
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-muted-foreground"><tr>{s.columns.map((c) => <th key={c.key} className={`p-2 font-medium ${c.kind === 'text' || c.kind === 'date' ? 'text-left' : 'text-right'}`}>{c.label}</th>)}</tr></thead>
              <tbody>
                {s.rows.map((row, j) => <tr key={j} className={`border-b last:border-0 ${row.bold ? 'font-semibold' : ''}`}>{s.columns.map((c, k) => <td key={c.key} className={`p-2 ${c.kind === 'text' || c.kind === 'date' ? '' : 'text-right tabular-nums'}`} style={k === 0 && row.level ? { paddingLeft: `${0.5 + row.level * 1.25}rem` } : undefined}>{show(c, row.cells[c.key] ?? null)}</td>)}</tr>)}
                {(s.totals ?? []).map((row, j) => <tr key={`t${j}`} className="border-t-2 font-semibold">{s.columns.map((c) => <td key={c.key} className={`p-2 ${c.kind === 'text' || c.kind === 'date' ? '' : 'text-right tabular-nums'}`}>{show(c, row.cells[c.key] ?? null)}</td>)}</tr>)}
                {s.rows.length === 0 && !(s.totals ?? []).length && <tr><td className="p-3 text-muted-foreground" colSpan={s.columns.length}>No data for this period.</td></tr>}
              </tbody>
            </table>
          </Card>
        </section>
      ))}
      {r.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
    </div>
  );
}
