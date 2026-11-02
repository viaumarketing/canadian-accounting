import { z } from 'zod';
import { COMPANY_ROLES } from './permissions';

export const CANADIAN_PROVINCES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;
export type Province = (typeof CANADIAN_PROVINCES)[number];

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// NIST 800-63B style: length over composition rules.
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  // 6-digit TOTP code or a recovery code
  mfaCode: z.string().trim().min(6).max(32).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const setupAdminSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
  setupToken: z.string().max(200).optional(),
});
export type SetupAdminInput = z.infer<typeof setupAdminSchema>;

export const mfaVerifySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

// CRA business number: 9 digits; GST/HST account = BN + "RT" + 4 digits. Stored as entered (digits/letters only).
export const gstHstNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{9}RT\d{4}$/, 'Expected format: 123456789RT0001');

export const createCompanySchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  operatingName: z.string().trim().max(200).optional(),
  province: z.enum(CANADIAN_PROVINCES),
  baseCurrency: z.string().length(3).toUpperCase().default('CAD'),
  fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
  fiscalYearEndDay: z.number().int().min(1).max(31).default(31),
  businessNumber: z
    .string()
    .trim()
    .regex(/^\d{9}$/, 'Business number is 9 digits')
    .optional(),
  /**
   * Owner of the new company. Required and explicit: a super admin gets no membership in a
   * company unless they name themselves here.
   */
  ownerEmail: emailSchema,
  /** Needed only when ownerEmail has no account yet; the account is created with a forced password change. */
  ownerName: z.string().trim().min(1).max(120).optional(),
  ownerTemporaryPassword: passwordSchema.optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .omit({ ownerEmail: true, ownerName: true, ownerTemporaryPassword: true, baseCurrency: true })
  .partial()
  .extend({
    /** Printed on invoices and sales receipts */
    address: z.string().trim().max(500).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
  });
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  role: z.enum(COMPANY_ROLES),
  /** Temporary password; the user is forced to change it at first login. */
  temporaryPassword: passwordSchema,
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const changeMemberRoleSchema = z.object({ role: z.enum(COMPANY_ROLES) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const taxRegistrationSchema = z.object({
  kind: z.enum(['GST_HST', 'QST', 'PST_BC', 'PST_SK', 'PST_MB']),
  registrationNumber: z.string().trim().min(5).max(40),
  filingFrequency: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
});
export type TaxRegistrationInput = z.infer<typeof taxRegistrationSchema>;
