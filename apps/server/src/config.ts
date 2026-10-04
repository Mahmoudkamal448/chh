import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** postgres://… — required unless STORE=memory. */
  DATABASE_URL: z.string().optional(),
  /** "memory" is for development and tests only: data is lost on restart. */
  STORE: z.enum(['postgres', 'memory']).default('postgres'),
  /** 32 random bytes, base64. Encrypts TOTP secrets and derives decoy KDF salts. */
  SERVER_SECRET: z.string().optional(),
  /** Allow anyone to create an account (set to false for a private instance once your users exist). */
  ALLOW_REGISTRATION: z.enum(['true', 'false']).default('true'),
  /** Set when running behind a reverse proxy so rate limits see the client IP. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  port: number;
  host: string;
  databaseUrl?: string;
  store: 'postgres' | 'memory';
  serverSecret: Buffer;
  allowRegistration: boolean;
  trustProxy: boolean;
  logLevel: string;
  /** Access-token lifetime (s) and refresh-token lifetime (s). */
  accessTtl: number;
  refreshTtl: number;
  /** Auth endpoints: max requests per minute per IP. */
  authRateLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  if (e.STORE === 'postgres' && !e.DATABASE_URL) throw new Error('DATABASE_URL is required (or set STORE=memory for development)');
  if (!e.SERVER_SECRET) throw new Error('SERVER_SECRET is required: generate one with `openssl rand -base64 32`');
  const secret = Buffer.from(e.SERVER_SECRET, 'base64');
  if (secret.length < 32) throw new Error('SERVER_SECRET must be at least 32 bytes (base64)');
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    store: e.STORE,
    serverSecret: secret,
    allowRegistration: e.ALLOW_REGISTRATION === 'true',
    trustProxy: e.TRUST_PROXY === 'true',
    logLevel: e.LOG_LEVEL,
    accessTtl: 3600,
    refreshTtl: 90 * 24 * 3600,
    authRateLimit: 30,
  };
}
