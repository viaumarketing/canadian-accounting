import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@ca/database';
import { documentTemplateSchema, type DocumentTemplate } from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';

export const LOGO_MAX_BYTES = 1024 * 1024;

/** Recognise PNG and JPEG by their magic bytes, never by the declared content type. */
export function logoType(b: Buffer): 'image/png' | 'image/jpeg' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

@Injectable()
export class BrandingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** The stored template, re-validated (a row written by an older build or by hand never breaks a PDF). */
  template(raw: Prisma.JsonValue): DocumentTemplate {
    const r = documentTemplateSchema.safeParse(raw ?? {});
    return r.success ? r.data : {};
  }

  async get(companyId: string) {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { template: true, emailFromName: true, emailReplyTo: true, logoMime: true, operatingName: true, legalName: true } });
    return { template: this.template(c.template), emailFromName: c.emailFromName, emailReplyTo: c.emailReplyTo, hasLogo: Boolean(c.logoMime), companyName: c.operatingName || c.legalName };
  }

  async update(companyId: string, i: { template?: DocumentTemplate; emailFromName?: string | null; emailReplyTo?: string | null }, actorId: string, ip: string | null) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        ...(i.template !== undefined ? { template: i.template as Prisma.InputJsonObject } : {}),
        ...(i.emailFromName !== undefined ? { emailFromName: i.emailFromName } : {}),
        ...(i.emailReplyTo !== undefined ? { emailReplyTo: i.emailReplyTo } : {}),
      },
    });
    await this.audit.record({ action: 'company.branding_updated', companyId, actorId, entityType: 'Company', entityId: companyId, metadata: { fields: Object.keys(i) }, ip });
    return this.get(companyId);
  }

  async setLogo(companyId: string, bytes: Buffer | undefined, actorId: string, ip: string | null) {
    if (!bytes?.length) throw new BadRequestException({ code: 'NO_FILE', message: 'Send the image as the request body (Content-Type: application/octet-stream)' });
    if (bytes.length > LOGO_MAX_BYTES) throw new BadRequestException({ code: 'TOO_LARGE', message: 'The logo must be 1 MB or smaller' });
    const mime = logoType(bytes);
    if (!mime) throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'The logo must be a PNG or JPEG image' });
    await this.prisma.company.update({ where: { id: companyId }, data: { logo: new Uint8Array(bytes), logoMime: mime } });
    await this.audit.record({ action: 'company.logo_updated', companyId, actorId, entityType: 'Company', entityId: companyId, metadata: { bytes: bytes.length, mime }, ip });
    return { hasLogo: true, mime, bytes: bytes.length };
  }

  async deleteLogo(companyId: string, actorId: string, ip: string | null) {
    await this.prisma.company.update({ where: { id: companyId }, data: { logo: null, logoMime: null } });
    await this.audit.record({ action: 'company.logo_removed', companyId, actorId, entityType: 'Company', entityId: companyId, ip });
  }

  async logo(companyId: string) {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { logo: true, logoMime: true } });
    if (!c.logo || !c.logoMime) throw new NotFoundException({ code: 'NO_LOGO', message: 'No logo uploaded' });
    return { bytes: Buffer.from(c.logo), mime: c.logoMime };
  }
}
