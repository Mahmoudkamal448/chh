import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildApp } from '../../../server/src/app';
import { MemoryStore } from '../../../server/src/store/memory';
import { launchApp, type AppHandle } from './fixtures';

const settingsKey = process.platform === 'darwin' ? 'Meta+,' : 'Control+,';

async function register(page: Page, serverUrl: string, email: string) {
  await page.evaluate(([serverUrl, email]) => window.chh.sync.register({ serverUrl, email, password: 'team e2e password' }), [serverUrl, email] as const);
}

async function openTeams(page: Page) {
  await page.getByTestId('nav-teams').click();
}

test('teams: invite, confirm by fingerprint, share a host, audit, remove', async () => {
  test.setTimeout(150_000);
  const store = new MemoryStore();
  const server = await buildApp({
    config: { port: 0, host: '127.0.0.1', store: 'memory', serverSecret: randomBytes(32), allowRegistration: true, trustProxy: false, logLevel: 'silent', accessTtl: 3600, refreshTtl: 86400, authRateLimit: 1000 },
    store,
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  const aliceEmail = `alice-${Date.now()}@example.com`;
  const bobEmail = `bob-${Date.now()}@example.com`;
  const handles: AppHandle[] = [];
  try {
    const a = await launchApp();
    handles.push(a);
    const b = await launchApp(mkdtempSync(join(tmpdir(), 'chh-e2e-bob-')));
    handles.push(b);
    await register(a.page, url, aliceEmail);
    await register(b.page, url, bobEmail);

    // Alice creates a team.
    await openTeams(a.page);
    await a.page.getByTestId('new-team').click();
    await a.page.getByTestId('team-name').fill('Ops crew');
    await a.page.getByTestId('create-team-save').click();
    await expect(a.page.getByTestId('team-title')).toHaveText('Ops crew');
    expect(JSON.stringify([...store.teams.values()])).not.toContain('Ops crew');

    // …and invites Bob as a viewer.
    await a.page.getByTestId('invite-email').fill(bobEmail);
    await a.page.getByTestId('invite-role').selectOption('viewer');
    await a.page.getByTestId('invite-send').click();
    await expect(a.page.getByTestId('team-pending-invite')).toContainText(bobEmail);

    // Bob sees the invite live and accepts it.
    await openTeams(b.page);
    const invite = b.page.getByTestId('team-invite');
    await expect(invite).toContainText(aliceEmail, { timeout: 15_000 });
    await invite.getByTestId('invite-accept').click();
    await expect(b.page.getByTestId('team-pending')).toBeVisible();
    const bobFingerprint = (await b.page.getByTestId('my-fingerprint').textContent())!.trim();

    // Alice compares the fingerprint and confirms Bob.
    const bobRow = a.page.getByTestId('team-member').filter({ hasText: bobEmail });
    await bobRow.getByTestId('member-confirm').click({ timeout: 15_000 });
    const dialog = a.page.getByTestId('confirm-member');
    await expect(dialog.getByTestId('confirm-fingerprint')).toHaveText(bobFingerprint);
    await expect(dialog.getByTestId('confirm-member-ok')).toBeDisabled();
    await dialog.getByTestId('confirm-member-check').check();
    await dialog.getByTestId('confirm-member-ok').click();
    await expect(bobRow.getByText('Needs confirmation')).toHaveCount(0);

    // Bob is now in, with the decrypted team name.
    await expect(b.page.getByTestId('team-title')).toHaveText('Ops crew', { timeout: 15_000 });

    // Alice moves a personal host into the team.
    await a.page.evaluate(() => window.chh.hosts.create({ label: 'shared-web', address: 'web.internal', password: 'team-pw' }));
    await a.page.getByTestId('nav-hosts').click();
    const row = a.page.getByTestId('host-row').filter({ hasText: 'shared-web' });
    await row.click({ button: 'right' });
    await a.page.getByTestId('host-move').click();
    await a.page.getByTestId('move-target').selectOption({ label: 'Ops crew' });
    await a.page.getByTestId('move-confirm').click();
    await expect(row.getByTestId('vault-badge')).toHaveText('Ops crew');

    // Bob receives it (badge shows the team) and, as a viewer, can't change it.
    await b.page.getByTestId('nav-hosts').click();
    const bobHost = b.page.getByTestId('host-row').filter({ hasText: 'shared-web' });
    await expect(bobHost.getByTestId('vault-badge')).toHaveText('Ops crew', { timeout: 20_000 });
    const denied = await b.page.evaluate(async () => {
      const h = (await window.chh.hosts.list({})).items.find((x) => x.label === 'shared-web')!;
      return window.chh.hosts.update({ id: h.id, patch: { notes: 'x' } }).then(
        () => 'updated',
        (e: Error) => e.message,
      );
    });
    expect(denied).toContain('read_only');

    // Alice sees what happened in the audit log.
    await openTeams(a.page);
    await a.page.getByTestId('team-tab-audit').click();
    const audit = a.page.getByTestId('audit-log');
    await expect(audit.getByTestId('audit-row').filter({ hasText: 'Confirmed a member' })).toContainText(bobEmail);
    await expect(audit.getByTestId('audit-row').filter({ hasText: 'Changed an item' }).first()).toContainText('shared-web');

    // Removing Bob rotates the key and wipes the shared host from his device.
    await a.page.getByTestId('team-tab-members').click();
    await a.page.getByTestId('team-member').filter({ hasText: bobEmail }).getByTestId('member-remove').click();
    await a.page.getByRole('button', { name: 'Remove from team' }).click();
    await expect(a.page.getByTestId('team-member').filter({ hasText: bobEmail })).toHaveCount(0, { timeout: 20_000 });
    await expect(bobHost).toHaveCount(0, { timeout: 20_000 });
    expect([...store.vaults.values()].find((v) => v.kind === 'team')!.keyGen).toBe(2);
  } finally {
    for (const h of handles) await h.close();
    await server.close();
  }
});

test('updates: development builds explain why they do not update themselves', async () => {
  const h = await launchApp();
  try {
    await h.page.keyboard.press(settingsKey);
    await h.page.getByTestId('settings-updates').click();
    await expect(h.page.getByTestId('update-unsupported')).toContainText('development build');
    await expect(h.page.getByTestId('update-check')).toHaveCount(0);
  } finally {
    await h.close();
  }
});
