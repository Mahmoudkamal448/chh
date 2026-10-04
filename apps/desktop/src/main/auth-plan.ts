import type { AuthMethod } from '@chh/shared';

export interface AuthInputs {
  method: AuthMethod;
  /** Resolved host settings (own + inherited). */
  settings: { username: string; keyId: string | null; useAgent: boolean; tryDefaultKeys: boolean };
  identity: { username: string; password: string | null; keyId: string | null } | null;
  /** The host's own saved password. */
  hostPassword: string | null;
}

/** What a connection may use to log in. Keyboard-interactive and a password prompt always remain. */
export interface AuthPlan {
  /** Empty: ask for it. */
  username: string;
  password: string | null;
  keyId: string | null;
  /** Present the key's certificate (if it has one). */
  useCertificate: boolean;
  /** Authenticate with the plain key (after its certificate, if that is used too). */
  usePlainKey: boolean;
  /** The configured method needs a certificate on the key. */
  requireCertificate: boolean;
  useAgent: boolean;
  tryDefaultKeys: boolean;
}

/**
 * Decides which credentials a hop uses. "auto" keeps the original behaviour (everything configured);
 * an explicit method uses only what it names, so e.g. a "Password" host never offers a key first.
 */
export function planAuth({ method, settings: s, identity: id, hostPassword }: AuthInputs): AuthPlan {
  const username = s.username || id?.username || '';
  const none: AuthPlan = {
    username,
    password: null,
    keyId: null,
    useCertificate: false,
    usePlainKey: false,
    requireCertificate: false,
    useAgent: false,
    tryDefaultKeys: false,
  };
  switch (method) {
    case 'auto':
      return {
        ...none,
        password: hostPassword ?? id?.password ?? null,
        keyId: s.keyId ?? id?.keyId ?? null,
        useCertificate: true,
        usePlainKey: true,
        useAgent: s.useAgent,
        tryDefaultKeys: s.tryDefaultKeys,
      };
    case 'password':
      return { ...none, password: hostPassword ?? id?.password ?? null };
    case 'key':
      return { ...none, keyId: s.keyId ?? id?.keyId ?? null, usePlainKey: true };
    case 'certificate':
      return { ...none, keyId: s.keyId ?? id?.keyId ?? null, useCertificate: true, requireCertificate: true };
    case 'agent':
      return { ...none, useAgent: true };
    case 'identity':
      // Everything comes from the identity (a username set on the host still wins, as elsewhere).
      return { ...none, password: id?.password ?? null, keyId: id?.keyId ?? null, useCertificate: true, usePlainKey: true };
    case 'ask':
      return { ...none, username: s.username };
  }
}
