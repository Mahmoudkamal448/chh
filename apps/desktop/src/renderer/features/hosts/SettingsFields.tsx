import { useTranslation } from 'react-i18next';
import type { HostSettings, HostSettingsOverrides } from '@cy-ssh/shared';
import { Field, Input, Select } from '../../components/ui';
import { keyKind } from '../../lib/format';
import { useVault } from '../../stores/vault-store';
import { TERMINAL_SCHEMES, schemeById } from '../../themes/terminal-themes';

/**
 * Editors for inheritable settings. Empty = inherit; the inherited value is shown as placeholder.
 * `connection` toggles username/port (hosts show those at the top of the form instead).
 */
export function SettingsFields({
  value,
  inherited,
  onChange,
  showIdentity,
}: {
  value: HostSettingsOverrides;
  inherited: HostSettings;
  onChange(v: HostSettingsOverrides): void;
  showIdentity: boolean;
}) {
  const { t } = useTranslation();
  const keys = useVault((s) => s.keys);
  const identities = useVault((s) => s.identities);
  const set = <K extends keyof HostSettings>(k: K, v: HostSettings[K] | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const bool = (s: string) => (s === '' ? undefined : s === 'on');
  const boolValue = (b: boolean | undefined) => (b === undefined ? '' : b ? 'on' : 'off');
  const inheritLabel = (v: string) => t('settings.inherit', { value: v });
  const onOff = (b: boolean) => (b ? t('common.on') : t('common.off'));
  /** "" = inherit, "none" = explicitly none, otherwise an id. */
  const refValue = (v: string | null | undefined) => (v === undefined ? '' : v === null ? 'none' : v);
  const refParse = (s: string) => (s === '' ? undefined : s === 'none' ? null : s);
  const identityName = (id: string | null) => (id ? (identities.find((i) => i.id === id)?.label ?? t('settings.missing')) : t('settings.none'));
  const keyName = (id: string | null) => (id ? (keys.find((k) => k.id === id)?.label ?? t('settings.missing')) : t('settings.none'));

  return (
    <div className="grid grid-cols-2 gap-3">
      {showIdentity && (
        <>
          <Field label={t('hostEditor.username')}>
            {(id) => (
              <Input id={id} value={value.username ?? ''} placeholder={inherited.username || t('hostEditor.askOnConnect')} onChange={(e) => set('username', e.target.value || undefined)} />
            )}
          </Field>
          <Field label={t('hostEditor.port')}>
            {(id) => (
              <Input id={id} type="number" min={1} max={65535} value={value.port ?? ''} placeholder={String(inherited.port)} onChange={(e) => set('port', num(e.target.value))} />
            )}
          </Field>
        </>
      )}
      <Field label={t('hostEditor.identity')} hint={t('hostEditor.identityHint')}>
        {(id, d) => (
          <Select id={id} aria-describedby={d} value={refValue(value.identityId)} onChange={(e) => set('identityId', refParse(e.target.value))} data-testid="host-identity">
            <option value="">{inheritLabel(identityName(inherited.identityId))}</option>
            <option value="none">{t('settings.none')}</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
                {i.username ? ` (${i.username})` : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('hostEditor.key')}>
        {(id) => (
          <Select id={id} value={refValue(value.keyId)} onChange={(e) => set('keyId', refParse(e.target.value))} data-testid="host-key">
            <option value="">{inheritLabel(keyName(inherited.keyId))}</option>
            <option value="none">{t('settings.none')}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({keyKind(k.type, k.bits)})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('hostEditor.terminalTheme')}>
        {(id) => (
          <Select id={id} value={value.terminalTheme ?? ''} onChange={(e) => set('terminalTheme', e.target.value || undefined)}>
            <option value="">{inheritLabel(schemeById(inherited.terminalTheme).name)}</option>
            {TERMINAL_SCHEMES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('hostEditor.fontSize')}>
        {(id) => (
          <Input id={id} type="number" min={6} max={48} value={value.fontSize ?? ''} placeholder={String(inherited.fontSize)} onChange={(e) => set('fontSize', num(e.target.value))} />
        )}
      </Field>
      <div className="col-span-2">
        <Field label={t('hostEditor.fontFamily')}>
          {(id) => (
            <Input id={id} value={value.fontFamily ?? ''} placeholder={inherited.fontFamily} onChange={(e) => set('fontFamily', e.target.value || undefined)} />
          )}
        </Field>
      </div>
      <Field label={t('hostEditor.useAgent')}>
        {(id) => (
          <Select id={id} value={boolValue(value.useAgent)} onChange={(e) => set('useAgent', bool(e.target.value))}>
            <option value="">{inheritLabel(onOff(inherited.useAgent))}</option>
            <option value="on">{t('common.on')}</option>
            <option value="off">{t('common.off')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('hostEditor.tryDefaultKeys')}>
        {(id) => (
          <Select id={id} value={boolValue(value.tryDefaultKeys)} onChange={(e) => set('tryDefaultKeys', bool(e.target.value))}>
            <option value="">{inheritLabel(onOff(inherited.tryDefaultKeys))}</option>
            <option value="on">{t('common.on')}</option>
            <option value="off">{t('common.off')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('hostEditor.recordHistory')}>
        {(id) => (
          <Select id={id} value={boolValue(value.recordHistory)} onChange={(e) => set('recordHistory', bool(e.target.value))}>
            <option value="">{inheritLabel(onOff(inherited.recordHistory))}</option>
            <option value="on">{t('common.on')}</option>
            <option value="off">{t('common.off')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('hostEditor.moshServer')} hint={t('hostEditor.moshServerHint')}>
        {(id, d) => (
          <Input id={id} aria-describedby={d} value={value.moshServer ?? ''} placeholder={inherited.moshServer} onChange={(e) => set('moshServer', e.target.value || undefined)} />
        )}
      </Field>
      <Field label={t('hostEditor.keepAlive')}>
        {(id) => (
          <Input id={id} type="number" min={0} max={3600} value={value.keepAliveSec ?? ''} placeholder={String(inherited.keepAliveSec)} onChange={(e) => set('keepAliveSec', num(e.target.value))} />
        )}
      </Field>
      <Field label={t('hostEditor.connectTimeout')}>
        {(id) => (
          <Input id={id} type="number" min={1} max={300} value={value.connectTimeoutSec ?? ''} placeholder={String(inherited.connectTimeoutSec)} onChange={(e) => set('connectTimeoutSec', num(e.target.value))} />
        )}
      </Field>
    </div>
  );
}

export function GroupOptions({ groups, exclude }: { groups: Array<{ id: string; label: string; parentId: string | null }>; exclude?: Set<string> }) {
  const children = new Map<string | null, typeof groups>();
  for (const g of groups) {
    const arr = children.get(g.parentId) ?? [];
    arr.push(g);
    children.set(g.parentId, arr);
  }
  const ids = new Set(groups.map((g) => g.id));
  const out: React.ReactNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const g of children.get(parent) ?? []) {
      if (exclude?.has(g.id)) continue;
      out.push(
        <option key={g.id} value={g.id}>
          {`${'  '.repeat(depth)}${g.label}`}
        </option>,
      );
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (parent missing) appear at top level.
  for (const g of groups) if (g.parentId && !ids.has(g.parentId) && !exclude?.has(g.id)) out.push(<option key={g.id} value={g.id}>{g.label}</option>);
  return <>{out}</>;
}
