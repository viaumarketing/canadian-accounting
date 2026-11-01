import { describe, expect, it } from 'vitest';
import { COMPANY_ROLES, roleHasPermission, permissionsForRole } from './permissions';
import { createCompanySchema, gstHstNumberSchema, passwordSchema } from './schemas';

describe('permission matrix', () => {
  it('has no super-admin company role', () => {
    expect(COMPANY_ROLES).not.toContain('SUPER_ADMIN' as never);
  });
  it('owner can do everything, admin cannot delete the company', () => {
    expect(roleHasPermission('OWNER', 'company:delete')).toBe(true);
    expect(roleHasPermission('ADMIN', 'company:delete')).toBe(false);
    expect(roleHasPermission('ADMIN', 'journal:reverse')).toBe(true);
  });
  it('auditor is read-only plus export', () => {
    for (const p of permissionsForRole('AUDITOR')) {
      expect(['view', 'export']).toContain(p.split(':')[1]);
    }
    expect(roleHasPermission('AUDITOR', 'journal:post')).toBe(false);
  });
  it('employee cannot see the ledger or banking', () => {
    expect(roleHasPermission('EMPLOYEE', 'journal:view')).toBe(false);
    expect(roleHasPermission('EMPLOYEE', 'banking:view')).toBe(false);
    expect(roleHasPermission('EMPLOYEE', 'expenses:create')).toBe(true);
  });
  it('bookkeeper can create but not post or reverse', () => {
    expect(roleHasPermission('BOOKKEEPER', 'journal:create')).toBe(true);
    expect(roleHasPermission('BOOKKEEPER', 'journal:post')).toBe(false);
    expect(roleHasPermission('BOOKKEEPER', 'journal:reverse')).toBe(false);
  });
  it('only accountants/finance/admin can approve', () => {
    expect(roleHasPermission('ACCOUNTANT', 'purchases:approve')).toBe(true);
    expect(roleHasPermission('FINANCE_MANAGER', 'purchases:approve')).toBe(true);
    expect(roleHasPermission('BOOKKEEPER', 'purchases:approve')).toBe(false);
    expect(roleHasPermission('EMPLOYEE', 'expenses:approve')).toBe(false);
  });
});

describe('schemas', () => {
  it('validates GST/HST number format', () => {
    expect(gstHstNumberSchema.safeParse('123456789RT0001').success).toBe(true);
    expect(gstHstNumberSchema.safeParse('123456789').success).toBe(false);
  });
  it('rejects short passwords', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('a-long-enough-passphrase').success).toBe(true);
  });
  it('defaults company currency to CAD', () => {
    const r = createCompanySchema.parse({ legalName: 'Acme Inc.', province: 'QC', ownerEmail: 'o@example.test' });
    expect(r.baseCurrency).toBe('CAD');
    expect(r.fiscalYearEndMonth).toBe(12);
  });
  it('rejects unknown provinces', () => {
    expect(createCompanySchema.safeParse({ legalName: 'X', province: 'ZZ', ownerEmail: 'o@example.test' }).success).toBe(false);
  });
});
