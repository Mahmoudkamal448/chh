import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostSettings, HostSettingsOverrides, Protocol } from '@chh/shared';
import { Field, Input, Select } from '../../components/ui';
import { TERMINAL_SCHEMES, schemeById } from '../../themes/terminal-themes';
import { AdvancedFields, SerialFields } from './AdvancedFields';
import { AuthSection } from './AuthSection';
import { useInheritLabel } from './inherit';

/**
 * Editors for inheritable settings. Empty = inherit; the inherited value is shown as placeholder.
 * `connection` toggles username/port (hosts show those at the top of the form instead).
 */
export function SettingsFields({
  value,
  inherited,
  onChange,
  showIdentity,
  protocol,
  selfId,
  passwordField,
  section,
  showPort = true,
}: {
  value: HostSettingsOverrides;
  inherited: HostSettings;
  onChange(v: HostSettingsOverrides): void;
  showIdentity: boolean;
  /** Host protocol (undefined in the group editor): hides fields that don't apply. */
  protocol?: Protocol;
  selfId?: string | null;
  /** The host's password editor, shown in the Authentication section. */
  passwordField?: ReactNode;
  /** Which tab of the editor: general (login), terminal (appearance) or advanced. */
  section: 'general' | 'terminal' | 'advanced';
  /** The host editor shows the port next to the address instead. */
  showPort?: boolean;
}) {
  const sshLike = !protocol || protocol === 'ssh' || protocol === 'mosh';
  const { t } = useTranslation();
  const set = <K extends keyof HostSettings>(k: K, v: HostSettings[K] | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const bool = (s: string) => (s === '' ? undefined : s === 'on');
  const boolValue = (b: boolean | undefined) => (b === undefined ? '' : b ? 'on' : 'off');
  const inheritLabel = useInheritLabel();
  const onOff = (b: boolean) => (b ? t('common.on') : t('common.off'));

  const portField = (
    <Field label={t('hostEditor.port')}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={1}
          max={65535}
          value={value.port ?? ''}
          // Telnet ignores inherited (SSH) ports and defaults to 23.
          placeholder={protocol === 'telnet' ? '23' : String(inherited.port)}
          onChange={(e) => set('port', num(e.target.value))}
        />
      )}
    </Field>
  );

  if (section === 'general') {
    return (
      <div className="grid grid-cols-2 gap-3">
        {protocol === 'serial' && (
          <div className="col-span-2">
            <SerialFields value={value} inherited={inherited} set={set} />
          </div>
        )}
        {showIdentity && showPort && protocol !== 'serial' && portField}
        {showIdentity && sshLike && <AuthSection value={value} inherited={inherited} set={set} passwordField={passwordField} />}
      </div>
    );
  }

  if (section === 'terminal') {
    return (
      <div className="grid grid-cols-2 gap-3">
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
            {(id) => <Input id={id} value={value.fontFamily ?? ''} placeholder={inherited.fontFamily} onChange={(e) => set('fontFamily', e.target.value || undefined)} />}
          </Field>
        </div>
        {sshLike && (
          <Field label={t('hostEditor.recordHistory')}>
            {(id) => (
              <Select id={id} value={boolValue(value.recordHistory)} onChange={(e) => set('recordHistory', bool(e.target.value))}>
                <option value="">{inheritLabel(onOff(inherited.recordHistory))}</option>
                <option value="on">{t('common.on')}</option>
                <option value="off">{t('common.off')}</option>
              </Select>
            )}
          </Field>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
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
        {sshLike && (
          <Field label={t('hostEditor.moshServer')} hint={t('hostEditor.moshServerHint')}>
            {(id, d) => <Input id={id} aria-describedby={d} value={value.moshServer ?? ''} placeholder={inherited.moshServer} onChange={(e) => set('moshServer', e.target.value || undefined)} />}
          </Field>
        )}
      </div>
      <AdvancedFields value={value} inherited={inherited} set={set} protocol={protocol} selfId={selfId} />
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
