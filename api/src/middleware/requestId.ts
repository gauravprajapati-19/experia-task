import type { RequestHandler } from 'express';
import { ulid } from 'ulid';

const SAFE_INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming && SAFE_INCOMING_ID.test(incoming) ? incoming : ulid();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};
