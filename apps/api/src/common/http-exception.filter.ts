import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Uniform error body: { code, message, issues? }. Never leaks stack traces or internals. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const obj = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      res.status(status).json({
        code: obj.code ?? (status === 429 ? 'RATE_LIMITED' : 'ERROR'),
        message: Array.isArray(obj.message) ? obj.message.join(', ') : obj.message ?? 'Error',
        ...(obj.issues ? { issues: obj.issues } : {}),
        // structured detail some errors carry (row errors from an import, the amount a reconciliation is out by)
        ...(obj.errors ? { errors: obj.errors } : {}),
        ...(obj.difference !== undefined ? { difference: obj.difference } : {}),
      });
      return;
    }
    // Errors from Express middleware (body-parser: 413 payload too large, 400 malformed JSON...) carry a 4xx status.
    const status = (exception as { status?: number; statusCode?: number })?.status ?? (exception as { statusCode?: number })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: status === 413 ? 'The upload is too large' : 'Bad request' });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
}
