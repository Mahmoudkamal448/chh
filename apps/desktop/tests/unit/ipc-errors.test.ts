import { describe, expect, it } from 'vitest';
import { decodeIpcError, encodeIpcError } from '@cy-ssh/shared';

describe('IPC error envelopes', () => {
  it('survive being reduced to a message (as contextBridge does)', () => {
    const e = { code: 'sync_invalid_credentials', messageKey: 'sync.error.invalid_credentials', details: { detail: 'x' } };
    // Electron prefixes remote errors with "Error invoking remote method …: Error: "
    const across = new Error(`Error invoking remote method 'cy:sync.login': Error: ${encodeIpcError(e)}`);
    expect(decodeIpcError(across)).toEqual(e);
    expect(decodeIpcError(new Error('plain'))).toBeNull();
    expect(decodeIpcError(null)).toBeNull();
  });
});
