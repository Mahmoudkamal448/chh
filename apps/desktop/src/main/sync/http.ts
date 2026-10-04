/** Small typed HTTP client for the sync server. */

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    /** Server error code ("invalid_credentials", "totp_required", …) or "network". */
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const TIMEOUT_MS = 20_000;

const PRIVATE_HOST = [/^localhost$/i, /^127\./, /^\[?::1\]?$/, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /\.local$/i, /\.lan$/i, /\.home\.arpa$/i];

/**
 * Normalizes a server URL. HTTPS is required, except for loopback and private-network hosts where
 * plain HTTP is allowed (everything synced is end-to-end encrypted, but tokens are not).
 */
export function normalizeServerUrl(input: string): { url: string; insecure: boolean } {
  let u: URL;
  try {
    u = new URL(input.trim().includes('://') ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new SyncHttpError(0, 'invalid_url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SyncHttpError(0, 'invalid_url');
  const insecure = u.protocol === 'http:';
  if (insecure && !PRIVATE_HOST.some((re) => re.test(u.hostname))) throw new SyncHttpError(0, 'insecure_url');
  u.hash = '';
  u.search = '';
  return { url: u.toString().replace(/\/+$/, ''), insecure };
}

export async function request<T>(base: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    throw new SyncHttpError(0, 'network', (e as Error).message);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (proxy error page …)
  }
  if (!res.ok) {
    const err = data as { error?: string; message?: string } | null;
    throw new SyncHttpError(res.status, err?.error ?? (res.status >= 500 ? 'server' : 'http'), err?.message);
  }
  return data as T;
}
