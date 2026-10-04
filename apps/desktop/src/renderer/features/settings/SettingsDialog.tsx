import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_HOST_SETTINGS, type LocalShell, type UiTheme } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Field, Input, Kbd, Select } from '../../components/ui';
import { ThemePicker } from './ThemePicker';
import { AiSettings } from './AiSettings';
import { UpdateSettings } from './UpdateSettings';
import { COMMAND_IDS, defaultKeymap, displayAccelerator, effectiveKeymap, eventToAccelerator, type CommandId } from '../../lib/keymap';
import { cn } from '../../lib/cn';
import { useApp, type SettingsSection } from '../../stores/app-store';
import { SyncSettings } from '../sync/SyncSettings';
import { SecuritySettings } from './SecuritySettings';

const SECTIONS: SettingsSection[] = ['general', 'terminal', 'shortcuts', 'security', 'sync', 'updates'];

export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const update = useApp((s) => s.updateSettings);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const section = useApp((s) => s.settingsSection);
  const setSection = useApp((s) => s.setSettingsSection);

  useEffect(() => {
    if (open) void window.chh.sessions.localShells({}).then(setShells);
    else setRecording(null);
  }, [open]);

  const keymap = effectiveKeymap(settings.keymap);
  const defaults = defaultKeymap();

  const record = (id: CommandId) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return setRecording(null);
    const accel = eventToAccelerator(e.nativeEvent);
    if (!accel) return;
    setRecording(null);
    void update({ keymap: { ...settings.keymap, [id]: accel } });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)} title={t('settings.title')} width="w-[860px]">
      <div className="flex min-h-[420px] gap-6">
        <nav aria-label={t('settings.sections')} className="flex w-40 shrink-0 flex-col gap-0.5">
          {SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
              className={cn('rounded-md px-3 py-1.5 text-left text-[13px]', section === id ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}
              data-testid={`settings-${id}`}
            >
              {t(`settings.section.${id}`)}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {section === 'general' && (
            <>

        <section className="grid grid-cols-2 gap-3">
          <Field label={t('settings.appearance')}>
            {(id) => (
              <Select id={id} value={settings.uiTheme} onChange={(e) => void update({ uiTheme: e.target.value as UiTheme })} data-testid="ui-theme">
                <option value="system">{t('settings.themeSystem')}</option>
                <option value="light">{t('settings.themeLight')}</option>
                <option value="dark">{t('settings.themeDark')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('settings.sshAgent')} hint={t('settings.sshAgentHint')}>
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                value={settings.sshAgent === '' || settings.sshAgent === 'pageant' ? settings.sshAgent : 'custom'}
                onChange={(e) => void update({ sshAgent: e.target.value === 'custom' ? '/path/to/agent.sock' : e.target.value })}
              >
                <option value="">{t('settings.agentAuto')}</option>
                {info?.platform === 'win32' && <option value="pageant">Pageant</option>}
                <option value="custom">{t('settings.agentCustom')}</option>
              </Select>
            )}
          </Field>
          {settings.sshAgent !== '' && settings.sshAgent !== 'pageant' && (
            <Field label={t('settings.agentPath')}>
              {(id) => <Input id={id} className="font-mono" defaultValue={settings.sshAgent} onBlur={(e) => void update({ sshAgent: e.target.value.trim() })} />}
            </Field>
          )}
          <Field label={t('settings.defaultShell')}>
            {(id) => (
              <Select id={id} value={settings.defaultShell ?? ''} onChange={(e) => void update({ defaultShell: e.target.value || null })}>
                <option value="">{t('settings.shellAuto', { name: shells[0]?.label ?? '' })}</option>
                {shells.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </section>

        <section className="text-[12px] text-muted">
          <p>
            {t('settings.version', { version: info?.version ?? '' })} · {info?.platform} {info?.arch}
          </p>
          <p>{info?.keystore === 'os' ? t('settings.keystoreOs') : t('settings.keystoreWeak')}</p>
        </section>
            </>
          )}
          {section === 'terminal' && (
            <>
        <section className="flex flex-col gap-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t('settings.terminal')}</h3>
          <p className="text-[12px] text-muted">{t('settings.terminalHint')}</p>
          <ThemePicker
            value={settings.terminalDefaults.terminalTheme ?? DEFAULT_HOST_SETTINGS.terminalTheme}
            onChange={(id) => void update({ terminalDefaults: { ...settings.terminalDefaults, terminalTheme: id } })}
          />
          <div className="grid grid-cols-[1fr_100px_140px] gap-3">
            <Field label={t('hostEditor.fontFamily')}>
              {(id) => (
                <Input
                  id={id}
                  defaultValue={settings.terminalDefaults.fontFamily ?? ''}
                  placeholder={DEFAULT_HOST_SETTINGS.fontFamily}
                  onBlur={(e) => void update({ terminalDefaults: { ...settings.terminalDefaults, fontFamily: e.target.value.trim() || undefined } })}
                />
              )}
            </Field>
            <Field label={t('hostEditor.fontSize')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={6}
                  max={48}
                  value={settings.terminalDefaults.fontSize ?? ''}
                  placeholder={String(DEFAULT_HOST_SETTINGS.fontSize)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!e.target.value || (n >= 6 && n <= 48)) void update({ terminalDefaults: { ...settings.terminalDefaults, fontSize: e.target.value ? n : undefined } });
                  }}
                  data-testid="default-font-size"
                />
              )}
            </Field>
            <Field label={t('settings.cursor')}>
              {(id) => (
                <Select
                  id={id}
                  value={settings.terminalDefaults.cursorStyle ?? DEFAULT_HOST_SETTINGS.cursorStyle}
                  onChange={(e) => void update({ terminalDefaults: { ...settings.terminalDefaults, cursorStyle: e.target.value as 'block' } })}
                >
                  <option value="block">{t('settings.cursorBlock')}</option>
                  <option value="bar">{t('settings.cursorBar')}</option>
                  <option value="underline">{t('settings.cursorUnderline')}</option>
                </Select>
              )}
            </Field>
          </div>
          <Checkbox
            label={t('settings.cursorBlink')}
            checked={settings.terminalDefaults.cursorBlink ?? DEFAULT_HOST_SETTINGS.cursorBlink}
            onChange={(v) => void update({ terminalDefaults: { ...settings.terminalDefaults, cursorBlink: v } })}
          />
          <Checkbox label={t('settings.historyEnabled')} checked={settings.historyEnabled} onChange={(v) => void update({ historyEnabled: v })} />
          <Checkbox
            label={t('settings.autocomplete')}
            checked={settings.autocomplete.enabled}
            onChange={(v) => void update({ autocomplete: { enabled: v } })}
          />
        </section>

              <AiSettings />
            </>
          )}
          {section === 'shortcuts' && (
            <>
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t('settings.shortcuts')}</h3>
            <Button variant="ghost" onClick={() => void update({ keymap: {} })}>
              {t('settings.resetShortcuts')}
            </Button>
          </div>
          <table className="w-full text-[13px]">
            <tbody>
              {COMMAND_IDS.map((id) => (
                <tr key={id} className="border-b border-border/60">
                  <td className="py-1.5">{t(`commands.${id}`)}</td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      data-recording={recording === id ? 'true' : undefined}
                      onClick={() => setRecording(id)}
                      onKeyDown={recording === id ? record(id) : undefined}
                      onBlur={() => recording === id && setRecording(null)}
                      className="rounded px-1 hover:bg-surface-2"
                      aria-label={t('settings.changeShortcut', { command: t(`commands.${id}`) })}
                    >
                      {recording === id ? <span className="text-accent">{t('settings.pressKeys')}</span> : <Kbd>{displayAccelerator(keymap[id])}</Kbd>}
                    </button>
                    {settings.keymap[id] && settings.keymap[id] !== defaults[id] && <span className="ml-2 text-[11px] text-muted">{t('settings.customized')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

            </>
          )}
          {section === 'security' && <SecuritySettings />}
          {section === 'sync' && <SyncSettings />}
          {section === 'updates' && <UpdateSettings />}
        </div>
      </div>
    </Dialog>
  );
}
