'use client';
import { useApi } from '@/lib/use-api';

export interface Named { id: string; name: string; isActive: boolean }
export interface Project { id: string; name: string; customerId: string; status: string; customer: { name: string } }

/** Classes, locations and projects for the selectors on documents (empty lists hide the selectors). */
export function useTracking(companyId: string, opts: { projects?: boolean } = {}) {
  const { data: classes } = useApi<Named[]>(`/companies/${companyId}/classes`);
  const { data: locations } = useApi<Named[]>(`/companies/${companyId}/locations`);
  const { data: projects } = useApi<Project[]>(opts.projects ? `/companies/${companyId}/projects` : null);
  return { classes: (classes ?? []).filter((c) => c.isActive), locations: (locations ?? []).filter((l) => l.isActive), projects: (projects ?? []).filter((p) => p.status === 'ACTIVE') };
}
