'use client';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

export function Table({ head, children, right = [] }: { head: string[]; children: ReactNode; right?: number[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-muted-foreground">
          <tr>{head.map((h, i) => <th key={h + i} className={`p-3 font-medium ${right.includes(i) ? 'text-right' : ''}`}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}
export const Td = ({ children, right, mono }: { children?: ReactNode; right?: boolean; mono?: boolean }) => (
  <td className={`border-b p-3 last:border-0 ${right ? 'text-right tabular-nums' : ''} ${mono ? 'font-mono text-xs' : ''}`}>{children}</td>
);
export const PageTitle = ({ children }: { children: ReactNode }) => <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>;
