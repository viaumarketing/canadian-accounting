/**
 * Company-scoped roles and the static permission matrix.
 *
 * "Super Administrator" is deliberately NOT a company role. It is a system-level flag on the
 * user (User.isSuperAdmin) that grants platform administration only. It carries no company
 * permissions: access to a company's financial data always requires a CompanyMembership.
 */
export const COMPANY_ROLES = [
  'OWNER',
  'ADMIN',
  'ACCOUNTANT',
  'BOOKKEEPER',
  'FINANCE_MANAGER',
  'EMPLOYEE',
  'AUDITOR',
] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const ROLE_LABELS: Record<CompanyRole, string> = {
  OWNER: 'Company Owner',
  ADMIN: 'Company Administrator',
  ACCOUNTANT: 'Accountant',
  BOOKKEEPER: 'Bookkeeper',
  FINANCE_MANAGER: 'Finance Manager',
  EMPLOYEE: 'Standard Employee',
  AUDITOR: 'Read-Only Auditor',
};

export const RESOURCES = [
  'company',
  'members',
  'settings',
  'accounts',
  'journal',
  'sales',
  'purchases',
  'expenses',
  'banking',
  'shopify',
  'taxes',
  'reports',
  'documents',
  'audit',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = ['view', 'create', 'approve', 'post', 'reverse', 'export', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

export type Permission = `${Resource}:${Action}`;

const all = (resources: readonly Resource[], actions: readonly Action[]): Permission[] =>
  resources.flatMap((r) => actions.map((a) => `${r}:${a}` as Permission));

const FINANCIAL: readonly Resource[] = [
  'accounts', 'journal', 'sales', 'purchases', 'expenses', 'banking', 'shopify', 'taxes', 'reports', 'documents',
];

const viewAll = all(RESOURCES, ['view']);

export const ROLE_PERMISSIONS: Record<CompanyRole, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>(all(RESOURCES, ACTIONS)),
  ADMIN: new Set<Permission>([
    ...all(RESOURCES, ACTIONS).filter((p) => p !== 'company:delete'),
  ]),
  ACCOUNTANT: new Set<Permission>([
    ...viewAll,
    ...all(FINANCIAL, ['create', 'approve', 'post', 'reverse', 'export']),
    'documents:delete',
  ]),
  BOOKKEEPER: new Set<Permission>([
    ...all(
      ['accounts', 'journal', 'sales', 'purchases', 'expenses', 'banking', 'shopify', 'taxes', 'reports', 'documents', 'audit'],
      ['view'],
    ),
    ...all(['journal', 'sales', 'purchases', 'expenses', 'banking', 'documents'], ['create']),
    'reports:export',
    'company:view',
  ]),
  FINANCE_MANAGER: new Set<Permission>([
    ...viewAll,
    ...all(['sales', 'purchases', 'expenses', 'banking', 'journal'], ['approve', 'post']),
    ...all(['reports', 'taxes', 'banking'], ['export']),
    ...all(['sales', 'purchases', 'expenses'], ['create']),
  ]),
  EMPLOYEE: new Set<Permission>([
    'company:view',
    'expenses:view',
    'expenses:create',
    'documents:view',
    'documents:create',
  ]),
  AUDITOR: new Set<Permission>([...viewAll, ...all(['reports', 'journal', 'audit'], ['export'])]),
};

export function roleHasPermission(role: CompanyRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: CompanyRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]].sort();
}
