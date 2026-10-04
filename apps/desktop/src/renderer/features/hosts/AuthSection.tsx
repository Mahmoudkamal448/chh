import { FileBadge, KeyRound, LockKeyhole, MessageCircleQuestion, Plug, Sparkles, Upload, UserRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthMethod, HostSettings, HostSettingsOverrides } from '@chh/shared';
import { Button, Field, IconButton, Input, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import { keyKind } from '../../lib/format';
import { useVault } from '../../stores/vault-store';
import { CertificatePanel } from '../keys/Certificate';
import { ImportKeyDialog } from '../keys/ImportKeyDialog';
import { useInheritLabel } from './inherit';

const METHODS: Array<{ id: AuthMethod; icon: typeof KeyRound }> = [
  { id: 'password', icon: LockKeyhole },
  { id: 'key', icon: KeyRound },
  { id: 'certificate', icon: FileBadge },
  { id: 'agent', icon: Plug },
  { id: 'identity', icon: UserRound },
  { id: 'ask', icon: MessageCircleQuestion },
  { id: 'auto', icon: Sparkles },
];

type Setter = <K extends keyof HostSettings>(k: K, v: HostSettings[K] | undefined) => void;

/**
 * How to log in, chosen with one button per method; each shows only the fields it needs. Hosts pass their
 * password field (passwords are per host); groups set the default method and credentials for their hosts.
 */
export function AuthSection({
  value,
  inherited,
  set,
  passwordField,
}: {
  value: HostSettingsOverrides;
  inherited: HostSettings;
  set: Setter;
  /** The host's password editor; absent in the group editor. */
  passwordField?: ReactNode;
}) {
  const { t } = useTranslation();
  const keys = useVault((s) => s.keys);
  const identities = useVault((s) => s.identities);
  const method = value.authMethod ?? inherited.authMethod;
  // Only worth offering when a group chose a method of its own (otherwise just pick Automatic).
  const overridden = value.authMethod !== undefined && value.authMethod !== inherited.authMethod && inherited.authMethod !== 'auto';

  /** "" = inherit, "none" = explicitly none, otherwise an id. */
  const refValue = (v: string | null | undefined) => (v === undefined ? '' : v === null ? 'none' : v);
  const refParse = (s: string) => (s === '' ? undefined : s === 'none' ? null : s);
  const inheritLabel = useInheritLabel();
  const keyName = (id: string | null) => (id ? (keys.find((k) => k.id === id)?.label ?? t('settings.missing')) : t('settings.none'));
  const identityName = (id: string | null) => (id ? (identities.find((i) => i.id === id)?.label ?? t('settings.missing')) : t('settings.none'));
  const effectiveKeyId = value.keyId === undefined ? inherited.keyId : value.keyId;
  const effectiveKey = effectiveKeyId ? keys.find((k) => k.id === effectiveKeyId) : undefined;
  const effectiveIdentityId = value.identityId === undefined ? inherited.identityId : value.identityId;
  const identity = effectiveIdentityId ? identities.find((i) => i.id === effectiveIdentityId) : undefined;

  const username = (placeholder: string) => (
    <Field label={t('hostEditor.username')}>
      {(id) => <Input id={id} value={value.username ?? ''} placeholder={inherited.username || placeholder} onChange={(e) => set('username', e.target.value || undefined)} data-testid="host-username" />}
    </Field>
  );
  const password =
    passwordField ?? (
      <p className="self-end pb-2 text-[12px] text-muted" data-testid="auth-group-password">
        {t('hostEditor.auth.groupPassword')}
      </p>
    );
  const keyPicker = (withCertificate: boolean) => <KeyPicker value={value.keyId} inheritLabel={inheritLabel(keyName(inherited.keyId))} onChange={(v) => set('keyId', v)} withCertificate={withCertificate} refValue={refValue} refParse={refParse} />;

  return (
    <section className="col-span-2 flex flex-col gap-3 rounded-lg border border-border p-3" aria-labelledby="auth-title" data-testid="auth-section">
      <div className="flex items-center gap-2">
        <h3 id="auth-title" className="text-[13px] font-semibold">
          {t('hostEditor.auth.title')}
        </h3>
        {overridden && (
          <Button variant="ghost" className="ml-auto text-[12px]" onClick={() => set('authMethod', undefined)} data-testid="auth-reset">
            {t('hostEditor.auth.useGroupDefault', { method: t(`hostEditor.auth.method.${inherited.authMethod}`) })}
          </Button>
        )}
      </div>
      <div role="radiogroup" aria-labelledby="auth-title" className="flex flex-wrap gap-1.5">
        {METHODS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={method === id}
            onClick={() => set('authMethod', id)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-focus',
              method === id ? 'border-accent bg-accent/10 font-medium text-fg' : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
            )}
            data-testid={`auth-method-${id}`}
          >
            <Icon size={14} aria-hidden />
            {t(`hostEditor.auth.method.${id}`)}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-muted" data-testid="auth-explain">
        {t(`hostEditor.auth.explain.${method}`)}
      </p>

      {method === 'password' && (
        <div className="grid grid-cols-2 gap-3">
          {username(t('hostEditor.auth.askUsername'))}
          {password}
        </div>
      )}

      {(method === 'key' || method === 'certificate') && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {username(t('hostEditor.auth.askUsername'))}
            {keyPicker(method === 'certificate')}
          </div>
          {method === 'certificate' && (effectiveKey ? <CertificatePanel keyItem={effectiveKey} compact /> : <p className="text-[12px] text-muted">{t('hostEditor.auth.chooseKeyForCertificate')}</p>)}
          {method === 'key' && effectiveKey?.certificate && <p className="text-[12px] text-muted">{t('hostEditor.auth.keyHasCertificate')}</p>}
        </>
      )}

      {method === 'agent' && <div className="grid grid-cols-2 gap-3">{username(t('hostEditor.auth.askUsername'))}</div>}

      {method === 'identity' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('hostEditor.identity')} hint={identity ? identitySummary(identity, keys, t) : t('hostEditor.auth.noIdentities')}>
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
            {username(identity?.username || t('hostEditor.auth.fromIdentity'))}
          </div>
        </>
      )}

      {method === 'ask' && <div className="grid grid-cols-2 gap-3">{username(t('hostEditor.auth.askUsername'))}</div>}

      {method === 'auto' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {username(t('hostEditor.askOnConnect'))}
            {password}
            {keyPicker(true)}
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
            <OnOff label={t('hostEditor.useAgent')} value={value.useAgent} inherited={inherited.useAgent} onChange={(v) => set('useAgent', v)} />
            <OnOff label={t('hostEditor.tryDefaultKeys')} value={value.tryDefaultKeys} inherited={inherited.tryDefaultKeys} onChange={(v) => set('tryDefaultKeys', v)} />
          </div>
          {effectiveKey && <CertificatePanel keyItem={effectiveKey} compact />}
        </>
      )}
    </section>
  );
}

function identitySummary(
  i: { username: string; hasPassword: boolean; keyId: string | null },
  keys: Array<{ id: string; label: string; certificate: unknown }>,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const key = i.keyId ? keys.find((k) => k.id === i.keyId) : undefined;
  return [
    i.username || t('identities.noUsername'),
    i.hasPassword ? t('identities.withPassword') : null,
    key ? t('identities.withKey', { key: key.label }) : null,
    key?.certificate ? t('certs.chip').toLowerCase() : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function KeyPicker({
  value,
  inheritLabel,
  onChange,
  withCertificate,
  refValue,
  refParse,
}: {
  value: string | null | undefined;
  inheritLabel: string;
  onChange(v: string | null | undefined): void;
  withCertificate: boolean;
  refValue(v: string | null | undefined): string;
  refParse(s: string): string | null | undefined;
}) {
  const { t } = useTranslation();
  const keys = useVault((s) => s.keys);
  const [importing, setImporting] = useState(false);
  return (
    <Field label={t('hostEditor.key')}>
      {(id) => (
        <div className="flex gap-2">
          <Select id={id} className="min-w-0 flex-1" value={refValue(value)} onChange={(e) => onChange(refParse(e.target.value))} data-testid="host-key">
            <option value="">{inheritLabel}</option>
            <option value="none">{t('settings.none')}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({keyKind(k.type, k.bits)}){withCertificate && k.certificate ? ` · ${t('certs.chip')}` : ''}
              </option>
            ))}
          </Select>
          <IconButton label={t('identities.importKey')} className="h-8 w-8 shrink-0 border border-border" onClick={() => setImporting(true)} data-testid="host-import-key">
            <Upload size={14} />
          </IconButton>
          <ImportKeyDialog open={importing} mode="file" onClose={() => setImporting(false)} onImported={(k) => onChange(k.id)} />
        </div>
      )}
    </Field>
  );
}

function OnOff({ label, value, inherited, onChange }: { label: string; value: boolean | undefined; inherited: boolean; onChange(v: boolean | undefined): void }) {
  const { t } = useTranslation();
  const inheritLabel = useInheritLabel();
  const onOff = (b: boolean) => (b ? t('common.on') : t('common.off'));
  return (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value === undefined ? '' : value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'on')}>
          <option value="">{inheritLabel(onOff(inherited))}</option>
          <option value="on">{t('common.on')}</option>
          <option value="off">{t('common.off')}</option>
        </Select>
      )}
    </Field>
  );
}
