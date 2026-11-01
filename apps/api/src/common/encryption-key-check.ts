import type { PrismaClient } from '@ca/database';
import { decrypt } from './crypto';

export interface KeyCheck {
  /** ok = at least one stored secret decrypts; mismatch = stored secrets exist but NONE decrypt; no_data = nothing encrypted yet */
  status: 'ok' | 'mismatch' | 'no_data';
  checked: number;
  failed: number;
}

/**
 * After a restore onto a new host, a wrong or lost ENCRYPTION_KEY is the one mistake that does not show up
 * until someone with MFA tries to sign in. Sample a few stored secrets and try to open them. A wrong key fails
 * every one (AES-GCM authenticates), so "all failed" means the key does not belong to this database; a single
 * corrupt row does not trip it.
 */
export async function checkEncryptionKey(prisma: PrismaClient, key: string): Promise<KeyCheck> {
  const [users, stores, conns] = await Promise.all([
    prisma.user.findMany({ where: { mfaSecretEnc: { not: null } }, select: { mfaSecretEnc: true }, take: 5 }),
    prisma.shopifyStore.findMany({ select: { accessTokenEnc: true }, take: 5 }),
    prisma.bankProviderConnection.findMany({ select: { accessTokenEnc: true }, take: 5 }),
  ]);
  const values = [...users.map((u) => u.mfaSecretEnc!), ...stores.map((s) => s.accessTokenEnc), ...conns.map((c) => c.accessTokenEnc)];
  if (!values.length) return { status: 'no_data', checked: 0, failed: 0 };
  let failed = 0;
  for (const v of values) {
    try {
      decrypt(v, key);
    } catch {
      failed++;
    }
  }
  return { status: failed === values.length ? 'mismatch' : 'ok', checked: values.length, failed };
}
