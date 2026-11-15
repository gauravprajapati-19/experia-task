import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/** central error handler: one response shape, and never a stack trace in the response */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appError = toAppError(err);
  if (appError.status >= 500) req.log.error({ err: err as unknown }, 'unhandled error');

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
  });
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
    return new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
  // errors raised by express.json() / express.raw() carry a `type` and a status
  const bodyParserType = (err as { type?: unknown } | null)?.type;
  if (bodyParserType === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (bodyParserType === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
}
