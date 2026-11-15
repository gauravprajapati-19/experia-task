import { pino, type DestinationStream, type Logger } from 'pino';
import { config } from '../config.js';

/** never log credentials, session cookies or webhook signatures */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-provider-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'secret',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.token',
  '*.secret',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}

export const logger = createLogger(config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL);
