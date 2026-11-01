import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@ca/database';
import { ProviderError, fingerprints, type BankingProvider, type ProviderTxn } from '@ca/banking';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { decrypt, encrypt } from '../common/crypto';
import { toDate } from '../accounting/setup';
import { BankingService } from './banking.service';

export const BANKING_PROVIDER = Symbol('BANKING_PROVIDER');

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly banking: BankingService, private readonly ledger: LedgerService,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(BANKING_PROVIDER) private readonly provider: BankingProvider | null,
  ) {}

  private p(): BankingProvider {
    if (!this.provider) throw new ServiceUnavailableException({ code: 'BANK_PROVIDER_NOT_CONFIGURED', message: 'Set PLAID_CLIENT_ID and PLAID_SECRET to enable bank connections. CSV/OFX imports work without them.' });
    return this.provider;
  }
  status() { return { provider: this.provider?.id ?? null, configured: Boolean(this.provider) }; }

  list(companyId: string) {
    return this.prisma.bankProviderConnection.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { id: true, provider: true, institutionName: true, status: true, lastSyncAt: true, lastError: true, createdAt: true, accounts: { select: { id: true, name: true, providerAccountId: true } } } });
  }

  linkToken(companyId: string, userId: string) {
    // The provider gets an opaque id, never an email or name.
    return this.p().createLinkToken({ clientUserId: `${companyId}:${userId}`, clientName: 'Canadian Accounting' });
  }

  /** Called with the `public_token` from the provider's Link UI. We never see the user's bank credentials. */
  async exchange(companyId: string, publicToken: string, institutionName: string | undefined, actorId: string, ip: string | null) {
    const prov = this.p();
    let ex;
    try { ex = await prov.exchangePublicToken(publicToken); } catch (e) { throw new BadRequestException({ code: 'EXCHANGE_FAILED', message: (e as Error).message }); }
    const existing = await this.prisma.bankProviderConnection.findUnique({ where: { provider_providerItemId: { provider: prov.id, providerItemId: ex.itemId } } });
    if (existing && existing.companyId !== companyId) throw new ConflictException({ code: 'ITEM_IN_USE', message: 'That bank login is connected to another company' });
    const data = { accessTokenEnc: encrypt(ex.accessToken, this.config.ENCRYPTION_KEY), status: 'CONNECTED', lastError: null, institutionName: institutionName ?? existing?.institutionName ?? null };
    const conn = existing
      ? await this.prisma.bankProviderConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.bankProviderConnection.create({ data: { ...data, companyId, provider: prov.id, providerItemId: ex.itemId } });
    const accounts = await prov.listAccounts(ex.accessToken);
    await this.audit.record({ action: 'bank_connection.created', companyId, actorId, entityType: 'BankProviderConnection', entityId: conn.id, metadata: { provider: prov.id, accounts: accounts.length }, ip });
    return { connectionId: conn.id, accounts };
  }

  /** Map provider accounts to ledger accounts. Nothing is imported for an account until it is mapped. */
  async linkAccounts(companyId: string, connectionId: string, maps: { providerAccountId: string; name: string; kind: 'CHEQUING' | 'SAVINGS' | 'CREDIT_CARD'; mask?: string; ledgerAccountId?: string; newLedgerAccount?: { code: string; name: string } }[], actorId: string, ip: string | null) {
    const conn = await this.conn(companyId, connectionId);
    const known = await this.p().listAccounts(decrypt(conn.accessTokenEnc, this.config.ENCRYPTION_KEY));
    const out = [];
    for (const m of maps) {
      if (!known.some((k) => k.providerAccountId === m.providerAccountId)) throw new BadRequestException({ code: 'UNKNOWN_PROVIDER_ACCOUNT', message: 'That account is not part of this connection' });
      const a = await this.banking.createAccount(companyId, { name: m.name, kind: m.kind, mask: m.mask, institution: conn.institutionName ?? undefined, ledgerAccountId: m.ledgerAccountId, newLedgerAccount: m.newLedgerAccount }, actorId, ip);
      out.push(await this.prisma.bankAccount.update({ where: { id: a.id }, data: { connectionId, providerAccountId: m.providerAccountId } }));
    }
    return out;
  }

  private async conn(companyId: string, id: string) {
    const c = await this.prisma.bankProviderConnection.findFirst({ where: { id, companyId } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Connection not found' });
    return c;
  }

  /** Pull everything since the stored cursor. The cursor advances only after a page is safely saved, so a crash re-reads instead of skipping. */
  async sync(companyId: string, connectionId: string, actorId: string | null, ip: string | null = null) {
    const conn = await this.conn(companyId, connectionId);
    if (conn.status === 'REMOVED') throw new ConflictException({ code: 'REMOVED', message: 'This connection was removed' });
    const accounts = await this.prisma.bankAccount.findMany({ where: { connectionId } });
    const byProvider = new Map(accounts.map((a) => [a.providerAccountId!, a]));
    const token = decrypt(conn.accessTokenEnc, this.config.ENCRYPTION_KEY);
    const stats = { added: 0, duplicates: 0, modified: 0, removed: 0, warnings: [] as string[], pages: 0, more: false };
    let cursor = conn.cursor;
    const startedAt = new Date();
    const modifiedIds: string[] = [];
    try {
      for (;;) {
        const page = await this.p().syncTransactions(token, cursor);
        stats.pages += 1;
        await this.prisma.$transaction(async (tx) => {
          const live = (t: ProviderTxn) => !t.pending && byProvider.has(t.providerAccountId);
          const rowsFor = (ts: ProviderTxn[]) => ts.filter(live).map((t) => ({ t, a: byProvider.get(t.providerAccountId)!, fp: fingerprints([{ date: t.date, description: t.description, amount: t.amount, externalId: t.providerTxnId }])[0] }));
          for (const { t, a, fp } of rowsFor(page.added)) {
            const r = await tx.bankTransaction.createMany({ data: [{ companyId, bankAccountId: a.id, externalId: t.providerTxnId, fingerprint: fp, date: toDate(t.date), description: t.description.slice(0, 500), amount: t.amount }], skipDuplicates: true });
            if (r.count) stats.added += 1; else stats.duplicates += 1;
          }
          for (const { t, a, fp } of rowsFor(page.modified)) {
            const ex = await tx.bankTransaction.findUnique({ where: { bankAccountId_fingerprint: { bankAccountId: a.id, fingerprint: fp } } });
            if (!ex) { await tx.bankTransaction.createMany({ data: [{ companyId, bankAccountId: a.id, externalId: t.providerTxnId, fingerprint: fp, date: toDate(t.date), description: t.description.slice(0, 500), amount: t.amount }], skipDuplicates: true }); stats.added += 1; continue; }
            if (ex.status === 'UNMATCHED') { await tx.bankTransaction.update({ where: { id: ex.id }, data: { date: toDate(t.date), description: t.description.slice(0, 500), amount: t.amount } }); stats.modified += 1; modifiedIds.push(ex.id); }
            else if (ex.amount.toString() !== t.amount || ex.date.toISOString().slice(0, 10) !== t.date) stats.warnings.push(`Bank changed a ${ex.status.toLowerCase()} transaction (${ex.description}); review it manually.`);
          }
          for (const r of page.removed) {
            const a = byProvider.get(r.providerAccountId);
            if (!a) continue;
            const fp = fingerprints([{ date: '2000-01-01', description: '', amount: '1', externalId: r.providerTxnId }])[0];
            const ex = await tx.bankTransaction.findUnique({ where: { bankAccountId_fingerprint: { bankAccountId: a.id, fingerprint: fp } } });
            if (!ex) continue;
            if (ex.status === 'UNMATCHED') { await tx.reconciliationMatch.deleteMany({ where: { bankTxnId: ex.id } }); await tx.bankTransaction.delete({ where: { id: ex.id } }); stats.removed += 1; }
            else stats.warnings.push(`Bank removed a ${ex.status.toLowerCase()} transaction (${ex.description}); it was kept. Review it manually.`);
          }
          await tx.bankProviderConnection.update({ where: { id: connectionId }, data: { cursor: page.nextCursor } });
        });
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        // Bounded run: the cursor is already saved, so the next run (hourly, or the next manual sync) continues from here.
        if (stats.pages >= this.config.BANK_MAX_PAGES_PER_RUN) { stats.more = true; break; }
      }
      await this.prisma.bankProviderConnection.update({ where: { id: connectionId }, data: { lastSyncAt: new Date(), lastError: null, status: 'CONNECTED' } });
    } catch (e) {
      const relink = e instanceof ProviderError && e.requiresRelink;
      await this.prisma.bankProviderConnection.update({ where: { id: connectionId }, data: { lastError: (e as Error).message, ...(relink ? { status: 'ERROR' } : {}) } });
      await this.audit.record({ action: 'bank_connection.sync_failed', companyId, actorId, entityType: 'BankProviderConnection', entityId: connectionId, metadata: { message: (e as Error).message }, ip });
      throw e instanceof ProviderError ? new BadRequestException({ code: e.code, message: relink ? `${e.message}. The bank needs you to sign in again; reconnect it.` : e.message }) : e;
    }
    for (const a of accounts) {
      // Only what this run brought in (or changed) needs rules and match suggestions.
      const fresh = { ids: (await this.prisma.bankTransaction.findMany({ where: { bankAccountId: a.id, status: 'UNMATCHED', OR: [{ createdAt: { gte: startedAt } }, { id: { in: modifiedIds } }] }, select: { id: true } })).map((t) => t.id) };
      await this.banking.applyRules(companyId, a.id, fresh);
      await this.banking.suggest(companyId, a.id, fresh);
    }
    const batchData: Prisma.ImportBatchCreateManyInput[] = accounts.map((a) => ({ companyId, bankAccountId: a.id, source: 'plaid', total: stats.added + stats.duplicates, imported: stats.added, skippedDuplicates: stats.duplicates, failed: 0, summary: { removed: stats.removed, modified: stats.modified, warnings: stats.warnings.slice(0, 20) }, createdById: actorId }));
    if (accounts.length && (stats.added || stats.modified || stats.removed)) await this.prisma.importBatch.createMany({ data: batchData.slice(0, 1) });
    await this.audit.record({ action: 'bank_connection.synced', companyId, actorId, entityType: 'BankProviderConnection', entityId: connectionId, metadata: stats, ip });
    return stats;
  }

  async syncAll() {
    const conns = await this.prisma.bankProviderConnection.findMany({ where: { status: 'CONNECTED' } });
    let ok = 0;
    for (const c of conns) { try { await this.sync(c.companyId, c.id, null); ok += 1; } catch { /* recorded on the connection */ } }
    return ok;
  }

  async remove(companyId: string, id: string, actorId: string, ip: string | null) {
    const conn = await this.conn(companyId, id);
    try { await this.p().removeItem(decrypt(conn.accessTokenEnc, this.config.ENCRYPTION_KEY)); } catch { /* still remove locally; the user can revoke at the bank */ }
    await this.prisma.bankProviderConnection.update({ where: { id }, data: { status: 'REMOVED', accessTokenEnc: 'revoked', cursor: null } });
    await this.audit.record({ action: 'bank_connection.removed', companyId, actorId, entityType: 'BankProviderConnection', entityId: id, ip });
  }
}
