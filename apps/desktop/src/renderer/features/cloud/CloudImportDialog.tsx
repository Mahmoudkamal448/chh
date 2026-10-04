import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CloudCandidate } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Input, Select } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { refreshAll } from '../../stores/hosts-store';

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-east-1',
  'me-south-1', 'me-central-1', 'af-south-1', 'il-central-1',
];

/** Fetch instances/droplets from a cloud provider, preview, then import (re-import updates). */
export function CloudImportDialog({ provider, onClose }: { provider: 'aws' | 'do' | null; onClose(): void }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [regions, setRegions] = useState<string[]>(['us-east-1']);
  const [doToken, setDoToken] = useState('');
  const [staged, setStaged] = useState<{ token: string; candidates: CloudCandidate[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState('');
  const [username, setUsername] = useState('');
  const [address, setAddress] = useState<'public' | 'private' | 'dns'>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    setStaged(null);
    setError(null);
    setDone(null);
    setGroup(provider === 'aws' ? 'AWS' : 'DigitalOcean');
    setUsername(provider === 'aws' ? 'ec2-user' : '');
    if (provider === 'aws') void window.chh.cloud.awsProfiles({}).then((p) => (setProfiles(p), setProfile(p[0] ?? '')));
  }, [provider]);

  const fail = (err: unknown) => {
    const { key, detail } = errorMessage(err);
    setError(t(key, { defaultValue: t('errors.internal'), detail }));
  };

  const fetchList = async () => {
    setBusy(true);
    setError(null);
    try {
      const res =
        provider === 'aws'
          ? await window.chh.cloud.awsList({ regions, ...(keyId ? { accessKeyId: keyId, secretAccessKey: secret } : profile ? { profile } : {}) })
          : await window.chh.cloud.doList({ apiToken: doToken });
      setStaged(res);
      setSelected(new Set(res.candidates.map((c) => c.externalId)));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!staged) return;
    setBusy(true);
    try {
      const r = await window.chh.cloud.import({ token: staged.token, externalIds: [...selected], groupLabel: group || undefined, username: username || undefined, address });
      setDone(t('cloud.result', { created: r.created, updated: r.updated }));
      await refreshAll();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!provider}
      onOpenChange={(o) => !o && onClose()}
      title={provider === 'aws' ? t('cloud.awsTitle') : t('cloud.doTitle')}
      description={t('cloud.hint')}
      width="w-[720px]"
      testId="cloud-import-dialog"
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {staged ? (
              <Button variant="primary" disabled={!selected.size || busy} onClick={() => void doImport()} data-testid="cloud-import">
                {t('cloud.import', { count: selected.size })}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || (provider === 'do' && !doToken) || (provider === 'aws' && !regions.length)} onClick={() => void fetchList()} data-testid="cloud-fetch">
                {busy ? t('sync.working') : t('cloud.fetch')}
              </Button>
            )}
          </>
        )
      }
    >
      {done && (
        <p role="status" data-testid="cloud-result">
          {done}
        </p>
      )}
      {!done && !staged && provider === 'aws' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('cloud.profile')} hint={t('cloud.profileHint')}>
              {(id, d) => (
                <Select id={id} aria-describedby={d} value={profile} onChange={(e) => setProfile(e.target.value)}>
                  <option value="">{t('cloud.defaultChain')}</option>
                  {profiles.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              )}
            </Field>
            <div />
            <Field label={t('cloud.accessKeyId')} hint={t('cloud.keysHint')}>
              {(id, d) => <Input id={id} aria-describedby={d} value={keyId} onChange={(e) => setKeyId(e.target.value.trim())} />}
            </Field>
            <Field label={t('cloud.secretKey')}>{(id) => <Input id={id} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
          </div>
          <fieldset>
            <legend className="mb-1 text-[12px] font-medium text-muted">{t('cloud.regions')}</legend>
            <div className="grid grid-cols-4 gap-1 text-[12px]">
              {AWS_REGIONS.map((r) => (
                <label key={r} className="flex items-center gap-1">
                  <input type="checkbox" className="accent-[var(--accent)]" checked={regions.includes(r)} onChange={(e) => setRegions(e.target.checked ? [...regions, r] : regions.filter((x) => x !== r))} />
                  {r}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {!done && !staged && provider === 'do' && (
        <Field label={t('cloud.doToken')} hint={t('cloud.doTokenHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" value={doToken} onChange={(e) => setDoToken(e.target.value.trim())} data-testid="do-token" />}
        </Field>
      )}
      {!done && staged && (
        <div className="flex flex-col gap-3">
          {staged.candidates.length === 0 ? (
            <p className="text-muted">{t('cloud.none')}</p>
          ) : (
            <div className="max-h-[36vh] overflow-y-auto rounded-md border border-border">
              <table className="w-full text-[12px]">
                <tbody>
                  {staged.candidates.map((c) => (
                    <tr key={c.externalId} className="border-b border-border/60" data-testid="cloud-row">
                      <td className="w-8 px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={c.name}
                          className="accent-[var(--accent)]"
                          checked={selected.has(c.externalId)}
                          onChange={() => {
                            const next = new Set(selected);
                            next.has(c.externalId) ? next.delete(c.externalId) : next.add(c.externalId);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-medium">
                        {c.name}
                        {c.exists && <span className="ml-2 rounded bg-surface-2 px-1 text-[10px] text-muted">{t('cloud.willUpdate')}</span>}
                      </td>
                      <td className="selectable px-2 py-1.5 font-mono">{c.publicAddress ?? '—'}</td>
                      <td className="selectable px-2 py-1.5 font-mono text-muted">{c.privateAddress ?? '—'}</td>
                      <td className="px-2 py-1.5 text-muted">{c.region}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('cloud.address')}>
              {(id) => (
                <Select id={id} value={address} onChange={(e) => setAddress(e.target.value as 'public')}>
                  <option value="public">{t('cloud.addresses.public')}</option>
                  <option value="private">{t('cloud.addresses.private')}</option>
                  {provider === 'aws' && <option value="dns">{t('cloud.addresses.dns')}</option>}
                </Select>
              )}
            </Field>
            <Field label={t('hostEditor.username')} hint={provider === 'aws' ? t('cloud.awsUserHint') : undefined}>
              {(id, d) => <Input id={id} aria-describedby={d} value={username} placeholder={provider === 'do' ? 'root' : ''} onChange={(e) => setUsername(e.target.value)} />}
            </Field>
            <Field label={t('sshConfig.group')}>{(id) => <Input id={id} value={group} onChange={(e) => setGroup(e.target.value)} />}</Field>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
