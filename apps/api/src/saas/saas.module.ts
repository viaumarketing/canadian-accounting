import { Global, Module } from '@nestjs/common';
import { SaasService } from './saas.service';
import { SaasAdminController, SaasController } from './saas.controller';

@Global()
@Module({ controllers: [SaasController, SaasAdminController], providers: [SaasService], exports: [SaasService] })
export class SaasModule {}
