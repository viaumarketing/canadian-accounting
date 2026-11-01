'use client';
import { useState, type FormEvent } from 'react';
import { CANADIAN_PROVINCES } from '@ca/shared';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Contact { id: string; kind: string; name: string; email: string | null; province: string | null }

export default function ContactsPage() {
  const { companyId, can } = useCompany();
  const { data, reload, error } = useApi<Contact[]>(`/companies/${companyId}/contacts`);
  const [f, setF] = useState({ kind: 'CUSTOMER', name: '', email: '', province: '' });
  const [err, setErr] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`/companies/${companyId}/contacts`, { method: 'POST', body: { kind: f.kind, name: f.name, email: f.email || undefined, province: f.province || undefined } }); setF({ ...f, name: '', email: '' }); await reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-4">
      <PageTitle>Contacts</PageTitle>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {data && data.length === 0 ? <Card><EmptyState title="No contacts yet">Add customers and suppliers to start invoicing and recording bills.</EmptyState></Card> : (
        <Table head={['Name', 'Type', 'Email', 'Province']}>{(data ?? []).map((c) => <tr key={c.id}><Td>{c.name}</Td><Td>{c.kind.toLowerCase()}</Td><Td>{c.email}</Td><Td>{c.province}</Td></tr>)}</Table>
      )}
      {can('sales:create') && (
        <Card><CardHeader><CardTitle>Add contact</CardTitle></CardHeader><CardContent>
          <form onSubmit={add} className="grid gap-4 sm:grid-cols-4">
            <Field label="Name" htmlFor="c-name"><Input id="c-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type" htmlFor="c-kind"><Select id="c-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="CUSTOMER">Customer</option><option value="VENDOR">Supplier</option><option value="BOTH">Both</option></Select></Field>
            <Field label="Email" htmlFor="c-email"><Input id="c-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Province" htmlFor="c-prov"><Select id="c-prov" value={f.province} onChange={(e) => setF({ ...f, province: e.target.value })}><option value="">—</option>{CANADIAN_PROVINCES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
            <div className="sm:col-span-4"><Button type="submit">Add contact</Button></div>
          </form></CardContent></Card>
      )}
    </div>
  );
}
