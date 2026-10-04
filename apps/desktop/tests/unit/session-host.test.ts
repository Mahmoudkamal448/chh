import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FlowControl, HIGH_WATER, LOW_WATER } from '../../src/session-host/flow';
import { fingerprintSha256, keyTypeOf } from '../../src/session-host/host-key';
import { describeSshError } from '../../src/session-host/ssh/connect';

function sshString(s: string): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(s.length);
  return Buffer.concat([len, Buffer.from(s)]);
}

describe('host key helpers', () => {
  it('formats OpenSSH-style SHA256 fingerprints', () => {
    const blob = Buffer.concat([sshString('ssh-ed25519'), sshString('x'.repeat(32))]);
    const expected = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    expect(fingerprintSha256(blob)).toBe(`SHA256:${expected}`);
    expect(fingerprintSha256(blob)).not.toContain('=');
  });

  it('reads the key type from the blob and tolerates garbage', () => {
    expect(keyTypeOf(Buffer.concat([sshString('ssh-ed25519'), sshString('k')]))).toBe('ssh-ed25519');
    expect(keyTypeOf(Buffer.from([0, 0]))).toBe('unknown');
    expect(keyTypeOf(Buffer.from([0xff, 0xff, 0xff, 0xff, 1]))).toBe('unknown');
  });
});

describe('FlowControl', () => {
  it('pauses above the high-water mark and resumes below the low-water mark', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const f = new FlowControl(pause, resume);
    f.sent(HIGH_WATER);
    expect(pause).not.toHaveBeenCalled();
    f.sent(1);
    expect(pause).toHaveBeenCalledTimes(1);
    f.sent(1000);
    expect(pause).toHaveBeenCalledTimes(1);
    f.acked(HIGH_WATER + 1001 - LOW_WATER);
    expect(resume).not.toHaveBeenCalled();
    f.acked(1);
    expect(resume).toHaveBeenCalledTimes(1);
    f.acked(10 ** 9);
    expect(f.pending).toBe(0);
  });
});

describe('describeSshError', () => {
  it('maps errors to i18n keys without leaking details for known cases', () => {
    expect(describeSshError(Object.assign(new Error('x'), { level: 'client-authentication' }))).toBe('session.error.auth');
    expect(describeSshError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('session.error.refused');
    expect(describeSshError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('session.error.dns');
    expect(describeSshError(new Error('weird'))).toBe('session.error.generic::weird');
  });
});
