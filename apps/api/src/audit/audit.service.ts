import { Injectable } from '@nestjs/common';
import { Prisma } from '@ca/database';
import { PrismaService } from '../prisma.service';

export interface AuditInput {
  action: string;
  companyId?: string | null;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: AuditInput, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).auditEvent.create({
      data: {
        action: input.action,
        companyId: input.companyId ?? null,
        actorId: input.actorId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata,
        ip: input.ip ?? null,
      },
    });
  }
}
