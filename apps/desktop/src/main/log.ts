import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

/** Every field that could ever carry a secret. Logged values at these paths become "[redacted]". */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passphrase',
  '*.passphrase',
  'privateKey',
  '*.privateKey',
  'token',
  '*.token',
  'responses',
  '*.responses',
  'key',
  '*.key',
  'config.password',
  'authorization',
  '*.authorization',
];

let logger: Logger = pino({ level: 'silent' });

export function initLogger(dir: string, level: string = 'info'): Logger {
  mkdirSync(dir, { recursive: true });
  logger = pino(
    { level, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, base: undefined },
    pino.destination({ dest: join(dir, 'main.log'), sync: false, mkdir: true }),
  );
  return logger;
}

export const log = {
  info: (obj: object, msg?: string) => logger.info(obj, msg),
  warn: (obj: object, msg?: string) => logger.warn(obj, msg),
  error: (obj: object, msg?: string) => logger.error(obj, msg),
  debug: (obj: object, msg?: string) => logger.debug(obj, msg),
};

/** Errors may embed user input; log only name/code/message, never arbitrary properties. */
export function errInfo(err: unknown): { name?: string; code?: string; message?: string } {
  if (!(err instanceof Error)) return { message: String(err) };
  return { name: err.name, code: (err as { code?: string }).code, message: err.message };
}
