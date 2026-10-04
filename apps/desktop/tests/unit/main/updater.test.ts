import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@chh/shared';
import { UpdateService, detectUpdateSupport, type UpdaterLike } from '../../../src/main/updater';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  allowDowngrade = true;
  installed = false;
  next: 'available' | 'none' | 'fail' = 'available';
  async checkForUpdates() {
    this.emit('checking-for-update');
    if (this.next === 'fail') throw new Error('getaddrinfo ENOTFOUND github.com');
    if (this.next === 'none') return this.emit('update-not-available', {});
    this.emit('update-available', { version: '9.9.9', releaseNotes: '<p>Fixes</p>' });
    if (this.autoDownload) await this.downloadUpdate();
  }
  async downloadUpdate() {
    this.emit('download-progress', { percent: 42.4 });
    this.emit('update-downloaded', { version: '9.9.9' });
  }
  quitAndInstall() {
    this.installed = true;
  }
}

function service(prefs: { auto: boolean; channel: 'latest' | 'beta' }, support = { supported: true } as const) {
  const fake = new FakeUpdater();
  const seen: UpdateStatus[] = [];
  const svc = new UpdateService({
    currentVersion: '1.0.0',
    support,
    releasesUrl: 'https://example.com/releases',
    settings: () => prefs,
    loadUpdater: async () => fake,
    onStatus: (s) => seen.push(s),
  });
  return { fake, seen, svc };
}

describe('UpdateService', () => {
  it('downloads automatically and installs on request', async () => {
    const { fake, seen, svc } = service({ auto: true, channel: 'beta' });
    const s = await svc.check();
    expect(fake).toMatchObject({ autoDownload: true, allowPrerelease: true, allowDowngrade: false, autoInstallOnAppQuit: true });
    expect(s).toMatchObject({ state: 'downloaded', version: '9.9.9', releaseNotes: 'Fixes', progress: 100 });
    expect(seen.map((x) => x.state)).toContain('downloading');
    svc.install();
    expect(fake.installed).toBe(true);
  });

  it('only offers the update when automatic download is off', async () => {
    const { fake, svc } = service({ auto: false, channel: 'latest' });
    expect(await svc.check()).toMatchObject({ state: 'available', version: '9.9.9' });
    expect(fake.allowPrerelease).toBe(false);
    svc.install(); // nothing downloaded yet
    expect(fake.installed).toBe(false);
    await svc.download();
    expect(svc.get().state).toBe('downloaded');
  });

  it('reports up-to-date and network errors', async () => {
    const { fake, svc } = service({ auto: true, channel: 'latest' });
    fake.next = 'none';
    expect(await svc.check()).toMatchObject({ state: 'not-available', version: null });
    fake.next = 'fail';
    expect(await svc.check()).toMatchObject({ state: 'error', error: 'updates.error.network' });
  });

  it('does nothing when the build cannot update itself', async () => {
    const { seen, svc } = service({ auto: true, channel: 'latest' }, { supported: false, reason: 'dev' } as never);
    expect(await svc.check()).toMatchObject({ supported: false, reason: 'dev', state: 'idle' });
    expect(seen).toEqual([]);
  });

  it('detects which builds support updates', () => {
    const base = { isPackaged: true, env: {}, linuxPackageType: null, signed: true };
    expect(detectUpdateSupport({ ...base, isPackaged: false, platform: 'win32' })).toEqual({ supported: false, reason: 'dev' });
    expect(detectUpdateSupport({ ...base, platform: 'win32' })).toEqual({ supported: true });
    expect(detectUpdateSupport({ ...base, platform: 'darwin', signed: false })).toEqual({ supported: false, reason: 'unsigned' });
    expect(detectUpdateSupport({ ...base, platform: 'linux' })).toEqual({ supported: false, reason: 'package' });
    expect(detectUpdateSupport({ ...base, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } })).toEqual({ supported: true });
    expect(detectUpdateSupport({ ...base, platform: 'linux', linuxPackageType: 'deb' })).toEqual({ supported: true });
    expect(detectUpdateSupport({ ...base, platform: 'win32', env: { CHH_DISABLE_UPDATES: '1' } })).toEqual({ supported: false, reason: 'disabled' });
  });
});
