'use client';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from '@/components/ui/card';
import { BarChart3 } from 'lucide-react';

export interface TrendPoint {
  label: string;
  value: number;
}

/** Renders ledger-derived series. With no data it shows an honest empty state, never sample numbers. */
export function TrendChart({ data, emptyText }: { data: TrendPoint[]; emptyText: string }) {
  if (data.length === 0) {
    return <EmptyState icon={<BarChart3 className="h-8 w-8" aria-hidden />} title="No data yet">{emptyText}</EmptyState>;
  }
  return (
    <div className="h-64" role="img" aria-label="Trend chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
          <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} />
          <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
