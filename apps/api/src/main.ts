import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { raw } from 'express';
import helmet from 'helmet';
import { buildAppModule } from './app.module';
import { loadConfig } from './config';
import { HttpExceptionFilter } from './common/http-exception.filter';

export async function createApp(config = loadConfig()) {
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(config), {
    abortOnError: false, // surface DI/startup errors as exceptions (bootstrap() exits non-zero) instead of abort()
    rawBody: true, // webhook HMACs are computed over the exact bytes received
    logger: config.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.set('trust proxy', 1); // behind Caddy / Next proxy: use X-Forwarded-For for client IP
  app.use(helmet());
  // Statement uploads arrive as raw bytes (10 MB cap) on these paths only; everything else keeps the small default JSON limit.
  const uploadPath = /^\/companies\/[^/]+\/banking\/accounts\/[^/]+\/import\//;
  const rawBody = raw({ type: 'application/octet-stream', limit: '10mb' });
  app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => (uploadPath.test(req.path) ? rawBody(req, res, next) : next()));
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  // Keep idle connections open longer than Caddy does (30 s): otherwise Node may close a socket at the moment Caddy reuses it,
  // and a POST on that socket fails with a 502 (Caddy does not retry non-idempotent requests). Found under load testing.
  const server = app.getHttpServer() as import('node:http').Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await app.listen(config.API_PORT, '0.0.0.0');
  console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: config.API_PORT, version: config.APP_VERSION }));
}

if (require.main === module) {
  bootstrap().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
