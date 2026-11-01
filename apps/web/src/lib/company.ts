'use client';
import { useParams } from 'next/navigation';
import { roleHasPermission, type Permission } from '@ca/shared';
import { useSession } from './session';

export function useCompany() {
  const { companyId } = useParams<{ companyId: string }>();
  const { me } = useSession();
  const company = me.companies.find((c) => c.id === companyId)!;
  return { companyId, role: company.role, me, can: (p: Permission) => roleHasPermission(company.role, p) };
}

/** Display-only formatting from the API's decimal strings (no float arithmetic on money in the browser). */
export function fmtMoney(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '';
  const str = String(s);
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace('-', '').split('.');
  const frac = (f + '00').slice(0, 2);
  return `${neg ? '−' : ''}$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
export const today = () => new Date().toISOString().slice(0, 10);
