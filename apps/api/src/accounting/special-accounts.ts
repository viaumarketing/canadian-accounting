import { Prisma } from '@ca/database';

type Db = Prisma.TransactionClient | { account: Prisma.TransactionClient['account'] };

export const SPECIAL_ACCOUNTS = {
  UNDEPOSITED_FUNDS: { code: '1050', name: 'Undeposited Funds', description: 'Payments received but not yet deposited; group them into a bank deposit.' },
  STRIPE_CLEARING: { code: '1045', name: 'Stripe Clearing', description: 'Card payments received through Stripe until Stripe pays them out to the bank.' },
} as const;
export type SpecialAccount = keyof typeof SPECIAL_ACCOUNTS;

/** The company's Undeposited Funds or Stripe clearing account, created on first use (next free code if the usual one is taken). */
export async function ensureSpecialAccount(db: Db, companyId: string, special: SpecialAccount) {
  const found = await db.account.findFirst({ where: { companyId, special } });
  if (found) return found;
  const t = SPECIAL_ACCOUNTS[special];
  let code = Number(t.code);
  while (await db.account.findFirst({ where: { companyId, code: String(code) } })) code++;
  try {
    return await db.account.create({ data: { companyId, code: String(code), name: t.name, type: 'ASSET', special, description: t.description } });
  } catch (e) {
    // Created at the same moment by another request.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return db.account.findFirstOrThrow({ where: { companyId, special } });
    throw e;
  }
}
