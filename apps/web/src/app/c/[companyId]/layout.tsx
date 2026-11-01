'use client';
import { useParams } from 'next/navigation';
import { Shell } from '@/components/shell/shell';
import { SessionProvider } from '@/lib/session';

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  return (
    <SessionProvider>
      <Shell companyId={companyId}>{children}</Shell>
    </SessionProvider>
  );
}
