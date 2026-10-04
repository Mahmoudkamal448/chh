import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import * as P from '@chh/shared/sync';
import type { Config } from './config';
import {
  burnAuthTime,
  decoySalt,
  hashAuthKey,
  newRecoveryCodes,
  newToken,
  newTotpSecret,
  openSecret,
  recoveryHash,
  sealSecret,
  tokenHash,
  verifyAuthKey,
  verifyTotp,
} from './crypto';
import { HttpError, parse, type Auth } from './http';
import { Hub } from './hub';
import type { Store, UserRecord } from './store/types';
import { teamService } from './teams';

/** Minimum client KDF cost we accept, so a client bug can't create a weak account. */
const MIN_KDF = { ops: 2, mem: 64 * 1024 * 1024 };
const DEFAULT_KDF = { ops: 3, mem: 256 * 1024 * 1024 };
const MAX_DEVICES = 1000; // effectively unlimited; just bounds abuse

const b64buf = (s: string) => Buffer.from(s, 'base64');

export async function buildApp({ config, store }: { config: Config; store: Store }) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.body.authKey', 'req.body.currentAuthKey', 'req.body.newAuthKey', 'req.body.refreshToken'],
    },
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });
  const hub = new Hub();
  const teams = teamService(store, hub);

  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (status && status < 500) return reply.code(status).send({ error: 'invalid_request', message: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  const authLimit = { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } };

  // --- tokens ----------------------------------------------------------------------------------

  async function issueTokens(userId: string, deviceId: string): Promise<P.Tokens> {
    const accessToken = newToken();
    const refreshToken = newToken();
    const now = Date.now();
    await store.saveToken({ hash: tokenHash(accessToken), userId, deviceId, kind: 'access', expiresAt: now + config.accessTtl * 1000, revoked: false });
    await store.saveToken({ hash: tokenHash(refreshToken), userId, deviceId, kind: 'refresh', expiresAt: now + config.refreshTtl * 1000, revoked: false });
    return { accessToken, refreshToken, expiresIn: config.accessTtl, userId, deviceId };
  }

  async function authenticate(token: string | undefined): Promise<Auth | null> {
    if (!token) return null;
    const t = await store.getToken(tokenHash(token));
    if (!t || t.kind !== 'access' || t.revoked || t.expiresAt < Date.now()) return null;
    return { userId: t.userId, deviceId: t.deviceId };
  }

  const lastTouch = new Map<string, number>();
  async function requireAuth(req: FastifyRequest) {
    const header = req.headers.authorization;
    const auth = await authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!auth) throw new HttpError(401, 'unauthorized');
    req.auth = auth;
    const now = Date.now();
    if (now - (lastTouch.get(auth.deviceId) ?? 0) > 60_000) {
      lastTouch.set(auth.deviceId, now);
      await store.touchDevice(auth.deviceId, now);
    }
  }

  async function accountOf(u: UserRecord): Promise<P.AccountWire> {
    const vaults = await store.listVaults(u.id);
    return {
      userId: u.id,
      email: u.email,
      kdf: u.kdf,
      blobs: { accountKeyWrapped: u.accountKeyWrapped, publicKey: u.publicKey, privateKeyWrapped: u.privateKeyWrapped, recoveryWrapped: u.recoveryWrapped },
      totpEnabled: !!u.totpSecretEnc,
      vaults: vaults.map((v) => ({ id: v.id, kind: v.kind, keyWrapped: v.keyWrapped })),
    };
  }

  /** TOTP or one-time recovery code check (consumes the code / advances the replay window). */
  async function checkSecondFactor(u: UserRecord, totp?: string, recoveryCode?: string): Promise<boolean> {
    if (!u.totpSecretEnc) return true;
    if (recoveryCode) {
      const h = recoveryHash(recoveryCode);
      if (!u.recoveryCodeHashes.includes(h)) return false;
      await store.updateUser(u.id, { recoveryCodeHashes: u.recoveryCodeHashes.filter((x) => x !== h) });
      return true;
    }
    if (!totp) return false;
    const step = verifyTotp(openSecret(config.serverSecret, u.totpSecretEnc), totp);
    if (step === null || step <= u.totpLastStep) return false;
    await store.updateUser(u.id, { totpLastStep: step });
    return true;
  }

  // --- public ----------------------------------------------------------------------------------

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/info', async () => ({ name: 'chh sync', version: 2, registration: config.allowRegistration, teams: true }));

  app.post('/v1/auth/prelogin', authLimit, async (req) => {
    const { email } = parse(P.PreloginRequest, req.body);
    const u = await store.getUserByEmail(email);
    return { kdf: u ? u.kdf : { alg: 'argon2id13', salt: decoySalt(config.serverSecret, email), ...DEFAULT_KDF } };
  });

  app.post('/v1/auth/register', authLimit, async (req, reply) => {
    if (!config.allowRegistration) throw new HttpError(403, 'registration_closed');
    const body = parse(P.RegisterRequest, req.body);
    if (body.kdf.ops < MIN_KDF.ops || body.kdf.mem < MIN_KDF.mem) throw new HttpError(400, 'weak_kdf');
    const authKey = b64buf(body.authKey);
    if (authKey.length !== 32) throw new HttpError(400, 'invalid_request', 'authKey must be 32 bytes');
    const now = Date.now();
    const userId = randomUUID();
    const deviceId = randomUUID();
    try {
      await store.createUser(
        {
          id: userId,
          email: body.email,
          authHash: await hashAuthKey(authKey),
          recoveryAuthHash: await hashAuthKey(b64buf(body.recoveryAuthKey)),
          kdf: body.kdf,
          ...body.blobs,
          totpSecretEnc: null,
          totpPendingEnc: null,
          totpLastStep: 0,
          recoveryCodeHashes: [],
          createdAt: now,
        },
        { id: deviceId, userId, name: body.device.name, platform: body.device.platform, createdAt: now, lastSeenAt: now },
        { id: body.vault.id, kind: 'personal', ownerUserId: userId, teamId: null, keyWrapped: body.vault.keyWrapped, seq: 0, keyGen: 1, needsRotation: false },
      );
    } catch (e) {
      if ((e as { code?: string }).code === 'EXISTS') throw new HttpError(409, 'exists');
      throw e;
    }
    const user = (await store.getUser(userId))!;
    reply.code(201);
    return { tokens: await issueTokens(userId, deviceId), account: await accountOf(user) };
  });

  app.post('/v1/auth/login', authLimit, async (req) => {
    const body = parse(P.LoginRequest, req.body);
    const authKey = b64buf(body.authKey);
    const u = await store.getUserByEmail(body.email);
    if (!u) {
      await burnAuthTime(authKey);
      throw new HttpError(401, 'invalid_credentials');
    }
    if (!(await verifyAuthKey(authKey, u.authHash))) throw new HttpError(401, 'invalid_credentials');
    if (u.totpSecretEnc && !body.totp && !body.recoveryCode) throw new HttpError(401, 'totp_required');
    if (!(await checkSecondFactor(u, body.totp, body.recoveryCode))) throw new HttpError(401, 'invalid_totp');
    if ((await store.listDevices(u.id)).length >= MAX_DEVICES) throw new HttpError(429, 'too_many_devices');
    const now = Date.now();
    const deviceId = randomUUID();
    await store.createDevice({ id: deviceId, userId: u.id, name: body.device.name, platform: body.device.platform, createdAt: now, lastSeenAt: now });
    return { tokens: await issueTokens(u.id, deviceId), account: await accountOf((await store.getUser(u.id))!) };
  });

  /** Short-lived, single-use tokens proving recovery-key possession (step 1 → step 2). */
  const recoveryTokens = new Map<string, { userId: string; expires: number }>();

  app.post('/v1/auth/recover/start', authLimit, async (req) => {
    const body = parse(P.RecoverStartRequest, req.body);
    const key = b64buf(body.recoveryAuthKey);
    const u = await store.getUserByEmail(body.email);
    if (!u || !u.recoveryAuthHash) {
      await burnAuthTime(key);
      throw new HttpError(401, 'invalid_credentials');
    }
    if (!(await verifyAuthKey(key, u.recoveryAuthHash))) throw new HttpError(401, 'invalid_credentials');
    if (u.totpSecretEnc && !body.totp && !body.recoveryCode) throw new HttpError(401, 'totp_required');
    if (!(await checkSecondFactor(u, body.totp, body.recoveryCode))) throw new HttpError(401, 'invalid_totp');
    const recoveryToken = newToken();
    const now = Date.now();
    for (const [k, v] of recoveryTokens) if (v.expires < now) recoveryTokens.delete(k);
    recoveryTokens.set(tokenHash(recoveryToken), { userId: u.id, expires: now + 10 * 60_000 });
    return { recoveryToken, recoveryWrapped: u.recoveryWrapped, kdf: u.kdf };
  });

  app.post('/v1/auth/recover/finish', authLimit, async (req) => {
    const body = parse(P.RecoverFinishRequest, req.body);
    const h = tokenHash(body.recoveryToken);
    const pending = recoveryTokens.get(h);
    recoveryTokens.delete(h);
    if (!pending || pending.expires < Date.now()) throw new HttpError(401, 'unauthorized');
    if (body.newKdf.ops < MIN_KDF.ops || body.newKdf.mem < MIN_KDF.mem) throw new HttpError(400, 'weak_kdf');
    await store.updateUser(pending.userId, { authHash: await hashAuthKey(b64buf(body.newAuthKey)), kdf: body.newKdf, accountKeyWrapped: body.accountKeyWrapped });
    // Every existing session ends: whoever forgot the password may not control those devices.
    await store.revokeUserTokens(pending.userId);
    hub.closeUser(pending.userId);
    const now = Date.now();
    const deviceId = randomUUID();
    await store.createDevice({ id: deviceId, userId: pending.userId, name: body.device.name, platform: body.device.platform, createdAt: now, lastSeenAt: now });
    return { tokens: await issueTokens(pending.userId, deviceId), account: await accountOf((await store.getUser(pending.userId))!) };
  });

  app.post('/v1/auth/refresh', authLimit, async (req) => {
    const { refreshToken } = parse(P.RefreshRequest, req.body);
    const t = await store.getToken(tokenHash(refreshToken));
    if (!t || t.kind !== 'refresh' || t.expiresAt < Date.now()) throw new HttpError(401, 'unauthorized');
    if (t.revoked) {
      // A rotated refresh token was used again: assume theft and sign this device out.
      await store.revokeDeviceTokens(t.deviceId);
      throw new HttpError(401, 'unauthorized');
    }
    await store.revokeToken(t.hash);
    return issueTokens(t.userId, t.deviceId);
  });

  // --- authenticated -----------------------------------------------------------------------------

  app.register(async (r) => {
    r.addHook('preHandler', requireAuth);

    r.post('/v1/auth/logout', async (req, reply) => {
      await store.deleteDevice(req.auth!.userId, req.auth!.deviceId);
      reply.code(204);
    });

    r.get('/v1/account', async (req) => {
      const u = await store.getUser(req.auth!.userId);
      if (!u) throw new HttpError(401, 'unauthorized');
      return accountOf(u);
    });

    r.delete('/v1/account', async (req, reply) => {
      const { authKey } = parse(P.DeleteAccountRequest, req.body);
      const u = (await store.getUser(req.auth!.userId))!;
      if (!(await verifyAuthKey(b64buf(authKey), u.authHash))) throw new HttpError(403, 'invalid_credentials');
      // Deleting the owner would orphan the team: transfer ownership or delete the team first.
      if (await store.ownedTeamCount(u.id)) throw new HttpError(409, 'team_owner');
      hub.closeUser(u.id);
      await store.deleteUser(u.id);
      reply.code(204);
    });

    r.post('/v1/account/password', async (req, reply) => {
      const body = parse(P.ChangePasswordRequest, req.body);
      const u = (await store.getUser(req.auth!.userId))!;
      if (!(await verifyAuthKey(b64buf(body.currentAuthKey), u.authHash))) throw new HttpError(403, 'invalid_credentials');
      if (body.newKdf.ops < MIN_KDF.ops || body.newKdf.mem < MIN_KDF.mem) throw new HttpError(400, 'weak_kdf');
      await store.updateUser(u.id, { authHash: await hashAuthKey(b64buf(body.newAuthKey)), kdf: body.newKdf, accountKeyWrapped: body.accountKeyWrapped });
      // Other devices must sign in again with the new password.
      await store.revokeUserTokens(u.id, req.auth!.deviceId);
      reply.code(204);
    });

    r.post('/v1/account/totp/setup', async (req) => {
      const u = (await store.getUser(req.auth!.userId))!;
      if (u.totpSecretEnc) throw new HttpError(409, 'totp_already_enabled');
      const secret = newTotpSecret();
      await store.updateUser(u.id, { totpPendingEnc: sealSecret(config.serverSecret, secret) });
      const uri = `otpauth://totp/${encodeURIComponent(`chh:${u.email}`)}?secret=${secret}&issuer=chh&algorithm=SHA1&digits=6&period=30`;
      return { secret, uri };
    });

    r.post('/v1/account/totp/enable', async (req) => {
      const { code } = parse(P.TotpCodeRequest, req.body);
      const u = (await store.getUser(req.auth!.userId))!;
      if (!u.totpPendingEnc || !code) throw new HttpError(400, 'totp_not_started');
      const step = verifyTotp(openSecret(config.serverSecret, u.totpPendingEnc), code);
      if (step === null) throw new HttpError(400, 'invalid_totp');
      const codes = newRecoveryCodes();
      await store.updateUser(u.id, {
        totpSecretEnc: u.totpPendingEnc,
        totpPendingEnc: null,
        totpLastStep: step,
        recoveryCodeHashes: codes.map(recoveryHash),
      });
      return { recoveryCodes: codes };
    });

    r.post('/v1/account/totp/disable', async (req, reply) => {
      const { code, recoveryCode } = parse(P.TotpCodeRequest, req.body);
      const u = (await store.getUser(req.auth!.userId))!;
      if (!u.totpSecretEnc) throw new HttpError(400, 'totp_not_enabled');
      if (!(await checkSecondFactor(u, code, recoveryCode))) throw new HttpError(400, 'invalid_totp');
      await store.updateUser(u.id, { totpSecretEnc: null, totpPendingEnc: null, recoveryCodeHashes: [] });
      reply.code(204);
    });

    r.get('/v1/devices', async (req) => {
      const list = await store.listDevices(req.auth!.userId);
      return list.map((d) => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: d.id === req.auth!.deviceId }));
    });

    r.delete('/v1/devices/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await store.deleteDevice(req.auth!.userId, id))) throw new HttpError(404, 'not_found');
      reply.code(204);
    });

    r.post('/v1/sync/pull', async (req) => {
      const { vaultId, since, limit } = parse(P.PullRequest, req.body);
      const { vault, team } = await teams.vaultAccess(req.auth!, vaultId, 'read');
      const changes = await store.pull(vaultId, since, limit + 1);
      const page = changes.slice(0, limit);
      if (team && page.length) await teams.audit(req.auth!, team.id, [{ action: 'vault.pulled', meta: { items: page.length } }]);
      return {
        changes: page,
        nextSince: page.length ? page[page.length - 1]!.seq : since,
        hasMore: changes.length > limit,
        ...(team ? { keyGen: vault.keyGen } : {}),
      };
    });

    r.post('/v1/sync/push', async (req) => {
      const { vaultId, changes, keyGen } = parse(P.PushRequest, req.body);
      const { vault, team } = await teams.vaultAccess(req.auth!, vaultId, 'write');
      // Items encrypted with a rotated-out key would be unreadable for everyone else.
      if (team && keyGen !== vault.keyGen) throw new HttpError(409, 'stale_key');
      const results: P.PushResult[] = [];
      const written: Array<{ action: string; itemId: string; meta: Record<string, unknown> }> = [];
      let maxSeq = 0;
      for (const c of changes) {
        const out = await store.push(vaultId, { ...c, deviceId: req.auth!.deviceId });
        if (out.status === 'ok') {
          maxSeq = Math.max(maxSeq, out.seq);
          written.push({ action: 'item.written', itemId: c.itemId, meta: { rev: out.rev } });
        }
        results.push({ itemId: c.itemId, ...out });
      }
      if (team) await teams.audit(req.auth!, team.id, written);
      if (maxSeq) hub.notify(await teams.vaultAudience(vault), { type: 'changed', vaultId, seq: maxSeq });
      return { results };
    });

    teams.register(r);
  });

  // --- WebSocket: change notifications -----------------------------------------------------------

  app.get('/v1/sync/ws', { websocket: true }, (socket: WebSocket) => {
    let authed = false;
    const timer = setTimeout(() => !authed && socket.close(4001, 'auth timeout'), 10_000);
    socket.on('message', async (raw: Buffer) => {
      let msg: P.WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as P.WsClientMessage;
      } catch {
        return socket.close(4000, 'bad message');
      }
      if (msg.type === 'ping') return socket.send(JSON.stringify({ type: 'pong' } satisfies P.WsServerMessage));
      if (msg.type === 'auth' && !authed) {
        const auth = await authenticate(msg.token);
        if (!auth) return socket.close(4001, 'unauthorized');
        authed = true;
        clearTimeout(timer);
        hub.add(auth.userId, socket);
        socket.send(JSON.stringify({ type: 'ready' } satisfies P.WsServerMessage));
      }
    });
    socket.on('close', () => clearTimeout(timer));
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
export type { FastifyReply };
