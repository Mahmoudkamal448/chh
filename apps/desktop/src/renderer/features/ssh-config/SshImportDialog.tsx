import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SshImportPreview, SshImportResult } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Field, Input } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { refreshAll } from '../../stores/hosts-store';
import { useLibrary } from '../../stores/library-store';
import { useVault } from '../../stores/vault-store';

/** Preview hosts from an ssh_config, choose which to import, then show a summary. */
export function SshImportDialog({ open, pickFile, onClose }: { open: boolean; pickFile: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<SshImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState('SSH config');
  const [importKeys, setImportKeys] = useState(true);
  const [importForwards, setImportForwards] = useState(true);
  const [result, setResult] = useState<SshImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setResult(null);
    setError(null);
    void window.chh.sshConfig
      .preview({ pickFile })
      .then((p) => {
        if (!p) return onClose();
        setPreview(p);
        setSelected(new Set(p.candidates.filter((c) => !c.exists).map((c) => c.alias)));
      })
      .catch((err) => setError(t(errorKey(err))));
  }, [open, pickFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const forwardsCount = useMemo(() => preview?.candidates.filter((c) => selected.has(c.alias)).reduce((n, c) => n + c.forwards.length, 0) ?? 0, [preview, selected]);

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await window.chh.sshConfig.import({ token: preview.token, aliases: [...selected], groupLabel: group.trim() || undefined, importKeys, importForwards });
      setResult(res);
      await Promise.all([refreshAll(), useVault.getState().refresh(), useLibrary.getState().refreshForwards()]);
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (alias: string) => {
    const next = new Set(selected);
    if (next.has(alias)) next.delete(alias);
    else next.add(alias);
    setSelected(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('sshConfig.importTitle')}
      description={preview?.path}
      width="w-[680px]"
      testId="ssh-import-dialog"
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!preview || !selected.size || busy} onClick={() => void doImport()} data-testid="ssh-import-submit">
              {t('sshConfig.importCount', { count: selected.size })}
            </Button>
          </>
        )
      }
    >
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="flex flex-col gap-2 text-[13px]" data-testid="ssh-import-result">
          <p>{t('sshConfig.result', { hosts: result.hosts, keys: result.keys, forwards: result.forwards })}</p>
          {result.skippedKeys.length > 0 && (
            <>
              <p className="text-muted">{t('sshConfig.skippedKeys')}</p>
              <ul className="selectable list-inside list-disc text-[12px] text-muted">
                {result.skippedKeys.map((k) => (
                  <li key={k.path}>
                    {k.path} — {t(`sshConfig.keyReason.${k.reason}`, { defaultValue: k.reason })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {!result && preview && (
        <div className="flex flex-col gap-3">
          {preview.candidates.length === 0 ? (
            <p className="text-muted">{t('sshConfig.noHosts')}</p>
          ) : (
            <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="w-8 px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={t('sshConfig.selectAll')}
                        className="accent-[var(--accent)]"
                        checked={selected.size === preview.candidates.length}
                        onChange={(e) => setSelected(new Set(e.target.checked ? preview.candidates.map((c) => c.alias) : []))}
                      />
                    </th>
                    <th className="px-2 py-1.5 font-medium">{t('sshConfig.alias')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('sshConfig.target')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('sshConfig.extras')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.candidates.map((c) => (
                    <tr key={c.alias} className="border-t border-border/60" data-testid="ssh-import-row">
                      <td className="px-2 py-1.5">
                        <input type="checkbox" aria-label={c.alias} className="accent-[var(--accent)]" checked={selected.has(c.alias)} onChange={() => toggle(c.alias)} />
                      </td>
                      <td className="px-2 py-1.5 font-medium">
                        {c.alias}
                        {c.exists && <span className="ml-2 rounded bg-surface-2 px-1 text-[10px] text-muted">{t('sshConfig.exists')}</span>}
                      </td>
                      <td className="selectable px-2 py-1.5 font-mono">
                        {c.user ? `${c.user}@` : ''}
                        {c.hostName}
                        {c.port && c.port !== 22 ? `:${c.port}` : ''}
                      </td>
                      <td className="px-2 py-1.5 text-muted">
                        {[
                          c.identityFiles.length ? t('sshConfig.keysN', { count: c.identityFiles.length }) : null,
                          c.forwards.length ? t('sshConfig.forwardsN', { count: c.forwards.length }) : null,
                          c.proxyJump ? `ProxyJump ${c.proxyJump}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Field label={t('sshConfig.group')} hint={t('sshConfig.groupHint')}>
            {(id, d) => <Input id={id} aria-describedby={d} value={group} onChange={(e) => setGroup(e.target.value)} />}
          </Field>
          <Checkbox label={t('sshConfig.importKeys')} checked={importKeys} onChange={setImportKeys} />
          <Checkbox label={t('sshConfig.importForwards', { count: forwardsCount })} checked={importForwards} onChange={setImportForwards} />
          {preview.candidates.some((c) => c.proxyJump) && <p className="text-[12px] text-muted">{t('sshConfig.proxyJumpNote')}</p>}
          {preview.warnings.length > 0 && (
            <details className="text-[12px] text-muted">
              <summary>{t('sshConfig.warnings', { count: preview.warnings.length })}</summary>
              <ul className="selectable mt-1 list-inside list-disc">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
}
