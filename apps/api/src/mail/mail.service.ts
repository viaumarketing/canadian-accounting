import { BadGatewayException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';

/** Tests swap `mailFetch.fn` for a fake Resend; production leaves the real fetch. */
export const mailFetch: { fn: typeof fetch } = { fn: (...a) => fetch(...a) };

const RESEND_URL = 'https://api.resend.com/emails';

export interface OutgoingMail {
  companyId?: string | null;
  /** invoice | sales_receipt | estimate | statement | reminder | purchase_order | verify_email */
  kind: string;
  documentId?: string | null;
  to: string[];
  cc?: string[];
  replyTo?: string | null;
  /** Display name in the From header; the address is always MAIL_FROM (a domain verified in Resend). */
  fromName?: string | null;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
  sentById?: string | null;
  /** Resend keeps idempotency keys for 24 hours: a retried request with the same key is not sent twice. */
  idempotencyKey?: string;
}

/** Characters that would break or inject into a From display name. */
const displayName = (s: string) => s.replace(/["<>\r\n,;\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Sends e-mail through Resend's REST API (POST https://api.resend.com/emails, Bearer key, JSON body with from, to, cc,
 * reply_to, subject, html, text, attachments[{filename, content: base64}], tags; Idempotency-Key header). Every attempt is
 * written to EmailMessage, with Resend's id on success or its error message on failure.
 */
@Injectable()
export class MailService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig, private readonly prisma: PrismaService) {}

  get configured() {
    return Boolean(this.config.RESEND_API_KEY && this.config.MAIL_FROM);
  }

  async send(m: OutgoingMail) {
    if (!this.configured) throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED', message: 'E-mail is not set up on this server: set RESEND_API_KEY and MAIL_FROM (see docs/email.md)' });
    const to = [...new Set(m.to.map((a) => a.trim().toLowerCase()).filter(Boolean))];
    const cc = [...new Set((m.cc ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))].filter((a) => !to.includes(a));
    const body = {
      from: `${displayName(m.fromName || this.config.APP_NAME)} <${this.config.MAIL_FROM}>`,
      to, ...(cc.length ? { cc } : {}),
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      subject: m.subject.replace(/[\r\n]+/g, ' ').slice(0, 250),
      html: m.html, text: m.text,
      ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) } : {}),
      tags: [{ name: 'kind', value: m.kind.replace(/[^A-Za-z0-9_-]/g, '_') }],
    };
    let status = 'FAILED', providerId: string | null = null, error: string | null = null;
    try {
      const res = await mailFetch.fn(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.RESEND_API_KEY}`, 'Content-Type': 'application/json', ...(m.idempotencyKey ? { 'Idempotency-Key': m.idempotencyKey.slice(0, 256) } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (res.ok && json.id) { status = 'SENT'; providerId = json.id; }
      else error = `Resend ${res.status}: ${json.message ?? json.name ?? 'request failed'}`.slice(0, 500);
    } catch (e) {
      error = `Resend unreachable: ${(e as Error).message}`.slice(0, 500);
    }
    const row = await this.prisma.emailMessage.create({ data: { companyId: m.companyId ?? null, kind: m.kind, documentId: m.documentId ?? null, to, cc, subject: body.subject, status, providerId, error, sentById: m.sentById ?? null } });
    if (status !== 'SENT') throw new BadGatewayException({ code: 'MAIL_FAILED', message: `The e-mail was not sent. ${error}`, emailId: row.id });
    return row;
  }

  log(companyId: string, q: { kind?: string; documentId?: string }) {
    return this.prisma.emailMessage.findMany({ where: { companyId, ...(q.kind ? { kind: q.kind } : {}), ...(q.documentId ? { documentId: q.documentId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  }
}
