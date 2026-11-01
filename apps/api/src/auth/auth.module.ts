import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SetupController } from './setup.controller';
import { AuthService } from './auth.service';

@Global()
@Module({ controllers: [AuthController, SetupController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
