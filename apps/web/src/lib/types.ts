import type { CompanyRole, Permission } from '@ca/shared';

export interface CompanySummary {
  id: string;
  legalName: string;
  operatingName: string | null;
  province: string;
  role: CompanyRole;
  permissions: Permission[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  companies: CompanySummary[];
}
