'use client';
import { Hammer } from 'lucide-react';
import { notFound, useParams } from 'next/navigation';
import { Card, EmptyState } from '@/components/ui/card';
import { NAV } from '@/lib/nav';

/** Sections whose functionality ships in later milestones. Says so plainly; shows no fake data. */
export default function SectionPage() {
  const { section } = useParams<{ section: string }>();
  const item = NAV.find((n) => n.slug === section);
  if (!item) notFound();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{item.label}</h1>
      <Card>
        <EmptyState icon={<Hammer className="h-8 w-8" aria-hidden />} title={`Planned for Milestone ${item.milestone}`}>
          {item.blurb} This section is not implemented yet.
        </EmptyState>
      </Card>
    </div>
  );
}
