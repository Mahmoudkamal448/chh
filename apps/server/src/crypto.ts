import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from 'hash-wasm';

/**
 * The client sends `authKey` (already the output of Argon2id on the user's device). We still store
 * only a slow hash of it so a database leak doesn't let anyone log in.
 */
const AUTH_HASH = { iterations: 2, memorySize: 19 * 1024, parallelism: 1, hashLength: 32 };

export async function hashAuthKey(authKey: Buffer): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id({ ...AUTH_HASH, password: authKey, salt, outputType: 'binary' });
  return `argon2id$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

export async function verifyAuthKey(authKey: Buffer, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'argon2id' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = Buffer.from(await argon2id({ ...AUTH_HASH, password: authKey, salt: Buffer.from(saltB64, 'base64'), outputType: 'binary' }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A precomputed hash used to burn the same CPU time for unknown emails (no user enumeration). */
let dummyHash: string | null = null;
export async function burnAuthTime(authKey: Buffer): Promise<void> {
  dummyHash ??= await hashAuthKey(randomBytes(32));
  await verifyAuthKey(authKey, dummyHash);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Deterministic decoy salt for unknown emails so /prelogin doesn't reveal who has an account. */
export function decoySalt(secret: Buffer, email: string): string {
  return createHmac('sha256', secret).update(`prelogin|${email}`).digest().subarray(0, 16).toString('base64');
}

// --- secrets at rest (TOTP) ------------------------------------------------------------------

export function sealSecret(secret: Buffer, plain: string): string {
  const key = createHmac('sha256', secret).update('totp-key').digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function openSecret(secret: Buffer, sealed: string): string {
  const key = createHmac('sha256', secret).update('totp-key').digest();
  const raw = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// --- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return bin.toString().padStart(6, '0');
}

export const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / 30_000);

/**
 * Checks a code against the current step ±1 (clock skew). Returns the matched step, or null.
 * Callers must reject steps at or below the last accepted one (replay protection).
 */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): number | null {
  const secret = base32Decode(secretB32);
  const step = totpStep(nowMs);
  for (const s of [step - 1, step, step + 1]) {
    const expected = Buffer.from(hotp(secret, s));
    const got = Buffer.from(code);
    if (expected.length === got.length && timingSafeEqual(expected, got)) return s;
  }
  return null;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(10)).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
  });
}

export const recoveryHash = (code: string) => createHash('sha256').update(code.toLowerCase().replace(/[^a-z2-7]/g, '')).digest('hex');
